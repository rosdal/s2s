import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  type Manifest,
  readManifest,
  type StageState,
  writeManifest,
} from "../capture/manifest.js";
import { type WorkspacePaths, workspacePaths } from "../capture/workspace.js";
import { writeFileAtomic, writeJsonAtomic } from "../fs-util.js";
import type { ProjectHints } from "../maps/hints.js";
import { WorkspaceError } from "../maps/run.js";
import { checkPackages, DEFAULT_POPULARITY_FLOOR } from "./check.js";
import { COLLECTORS, type CollectorName } from "./collectors.js";
import { type DetectContext, loadContext } from "./context.js";
import { type Evidence, EvidenceFile, finalizeEvidence, isNpmName } from "./evidence.js";
import {
  CONFIDENCE_RANK,
  type Confidence,
  type MergedPackage,
  mergeEvidence,
  type VersionSource,
} from "./merge.js";
import {
  buildPackageJson,
  chooseManager,
  type InstallResult,
  installProject,
  type PackageManager,
  projectName,
  versionSpec,
} from "./project.js";
import { type BundleRanges, vendorRanges } from "./ranges.js";
import { Registry, type RegistryOptions, resolveVersion } from "./registry.js";

export interface DetectOptions {
  /** Workspace folder written by `s2s capture`. */
  workspace: string;
  cwd?: string;
  force?: boolean;
  /** Skip every registry request; evidence is still collected and written. */
  offline?: boolean;
  pm?: PackageManager;
  install?: boolean;
  /** Lowest confidence that goes into `dependencies`. Defaults to `medium`. */
  minConfidence?: Confidence;
  /** `exact` pins (`18.3.1`, the default) or `caret` ranges (`^18.3.1`). */
  ranges?: "exact" | "caret";
  /** Packages to put in `package.json` whatever their score, as `name` or `name@version`. */
  accept?: string[];
  /** Packages to keep out of `package.json`. */
  reject?: string[];
  popularityFloor?: number;
  /** Registry client settings; tests pass a `fetch` that serves recorded responses. */
  registry?: RegistryOptions;
  /** Injected for tests: the installed version of a package manager. */
  managerVersion?: (pm: PackageManager) => string | undefined;
  signal?: AbortSignal;
  onProgress?: (event: DetectProgress) => void;
}

export type DetectProgress =
  | { kind: "start"; workspace: string }
  | { kind: "skip"; workspace: string; reason: string }
  | { kind: "warning"; message: string }
  | { kind: "install"; manager: PackageManager; dir: string }
  | { kind: "done"; status: StageState["status"]; summary: string };

export type PackageStatus = "dependency" | "devDependency" | "transitive" | "review" | "rejected";

export interface PackageRow {
  name: string;
  version: string | null;
  confidence: Confidence;
  status: PackageStatus;
  signals: string[];
}

export interface DetectResult {
  workspace: string;
  status: StageState["status"];
  skipped: boolean;
  stats: Record<string, number>;
  warnings: string[];
  summary: string;
  packages: PackageRow[];
  install?: Omit<InstallResult, "output">;
  error?: string;
}

export interface PackageRecord extends Omit<MergedPackage, "versions"> {
  status: PackageStatus;
  /** Why it is not in `dependencies`, for review and rejected packages. */
  reason: string | null;
  versions: MergedPackage["versions"];
  /** Bytes of shipped code marked as this package in `vendor-ranges.json`. */
  vendorBytes: number;
}

export interface PackagesFile {
  packageManager: { name: string; source: string; version: string | null };
  packages: PackageRecord[];
}

/**
 * Stage 3: merge every cheap package signal into one scored list, check it against the npm
 * registry, mark the vendor byte ranges of each bundle, and write `project/package.json`
 * (installing it with scripts disabled when asked). Re-running a complete stage is a no-op
 * unless `force` or an option that changes the output is given.
 */
export async function detect(options: DetectOptions): Promise<DetectResult> {
  const root = path.resolve(options.cwd ?? process.cwd(), options.workspace);
  const paths = workspacePaths(root);
  const progress = options.onProgress ?? (() => {});
  const manifest = await readManifest(paths.manifest).catch((error: Error) => {
    throw new WorkspaceError(`${paths.manifest} is unreadable: ${error.message.split("\n")[0]}`);
  });
  if (!manifest) {
    throw new WorkspaceError(`No workspace at ${root}. Run "s2s capture <url>" first.`);
  }
  const captureStatus = manifest.stages.capture.status;
  if (captureStatus === "pending" || captureStatus === "failed") {
    throw new WorkspaceError(
      `Capture in ${root} is ${captureStatus}. Run "s2s capture" again before "s2s detect".`,
    );
  }
  const changesOutput =
    Boolean(options.install) ||
    options.pm !== undefined ||
    options.minConfidence !== undefined ||
    options.ranges !== undefined ||
    options.popularityFloor !== undefined ||
    // Going online after an offline run (or back) changes every registry result.
    (manifest.stages.detect.details?.offline ?? false) !== Boolean(options.offline) ||
    (options.accept?.length ?? 0) > 0 ||
    (options.reject?.length ?? 0) > 0;
  if (manifest.stages.detect.status === "complete" && !options.force && !changesOutput) {
    progress({ kind: "skip", workspace: root, reason: "detect is already complete" });
    const stats = manifest.stages.detect.stats;
    return {
      workspace: root,
      status: "complete",
      skipped: true,
      stats,
      warnings: manifest.stages.detect.warnings,
      summary: summaryLine(stats),
      packages: await readRows(paths),
    };
  }

  const startedAt = new Date();
  manifest.stages.detect = {
    status: "partial",
    startedAt: startedAt.toISOString(),
    stats: {},
    warnings: [],
  };
  await writeManifest(paths.manifest, manifest);
  progress({ kind: "start", workspace: root });

  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    progress({ kind: "warning", message });
  };
  if (captureStatus === "partial") warn("Capture is partial; packages it missed cannot be found.");
  if (manifest.stages.maps.status !== "complete")
    warn('Stage 2 has not run; source-map evidence is missing. Run "s2s maps" first.');

  let status: StageState["status"] = "failed";
  let outcome: RunOutcome = { stats: {}, details: {}, rows: [] };
  let error: string | undefined;
  try {
    outcome = await run(paths, manifest, options, warn, progress);
    status = "complete";
  } catch (caught) {
    if (options.signal?.aborted) {
      status = "partial";
      error = "Interrupted";
    } else {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  manifest.stages.detect = {
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    stats: outcome.stats,
    warnings,
    details: outcome.details,
    ...(error ? { error } : {}),
  };
  await writeManifest(paths.manifest, manifest);
  const summary = summaryLine(outcome.stats);
  progress({ kind: "done", status, summary });
  return {
    workspace: root,
    status,
    skipped: false,
    stats: outcome.stats,
    warnings,
    summary,
    packages: outcome.rows,
    ...(outcome.install ? { install: outcome.install } : {}),
    ...(error ? { error } : {}),
  };
}

/** For example "12 packages: 8 dependencies, 1 devDependency, 3 for review". */
export function summaryLine(stats: Record<string, number>): string {
  const n = (k: string) => stats[k] ?? 0;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const deps = n("dependencies");
  return `${plural(n("packages"), "package")}: ${deps} ${deps === 1 ? "dependency" : "dependencies"}, ${plural(n("devDependencies"), "devDependency")}, ${n("review")} for review`;
}

interface RunOutcome {
  stats: Record<string, number>;
  details: Record<string, string | number | boolean | null>;
  rows: PackageRow[];
  install?: Omit<InstallResult, "output">;
}

const COLLECTOR_FILES: Record<CollectorName, string> = {
  cdn: "cdn.json",
  sourcemap: "sourcemap.json",
  banners: "banners.json",
  "license-files": "license-files.json",
  "version-strings": "version-strings.json",
  runtime: "runtime.json",
  framework: "framework.json",
};

export function detectPaths(paths: WorkspacePaths) {
  return {
    packages: path.join(paths.analysis, "packages.json"),
    review: path.join(paths.analysis, "packages-review.json"),
    vendorRanges: path.join(paths.analysis, "vendor-ranges.json"),
    installLog: path.join(paths.analysis, "install.log"),
    project: path.join(paths.root, "project"),
    packageJson: path.join(paths.root, "project", "package.json"),
    evidence: (name: CollectorName) => path.join(paths.evidence, COLLECTOR_FILES[name]),
  };
}

async function run(
  paths: WorkspacePaths,
  manifest: Manifest,
  options: DetectOptions,
  warn: (message: string) => void,
  progress: (event: DetectProgress) => void,
): Promise<RunOutcome> {
  const out = detectPaths(paths);
  await Promise.all(
    [
      ...Object.keys(COLLECTOR_FILES).map((n) => out.evidence(n as CollectorName)),
      out.packages,
      out.review,
      out.vendorRanges,
      out.installLog,
    ].map((p) => rm(p, { force: true })),
  );

  // 1. Collect evidence; each collector writes its own file in the shared shape.
  const ctx = await loadContext(paths);
  const evidence: Evidence[] = [];
  for (const [name, collect] of Object.entries(COLLECTORS) as [
    CollectorName,
    (c: DetectContext) => Promise<Parameters<typeof finalizeEvidence>[1]>,
  ][]) {
    options.signal?.throwIfAborted();
    const file = finalizeEvidence(name, await collect(ctx));
    await writeJsonAtomic(out.evidence(name), file);
    evidence.push(...file.evidence);
  }

  // 2. Merge and score.
  const merged = mergeEvidence(evidence);
  const accept = parseSpecs(options.accept ?? [], warn);
  for (const [name, version] of accept) {
    if (merged.some((p) => p.name === name)) continue;
    merged.push(manualPackage(name, version));
  }
  merged.sort((a, b) => a.name.localeCompare(b.name));

  // 3. Registry checks.
  const captureDate = new Date(manifest.stages.capture.startedAt ?? manifest.createdAt);
  const registry = options.offline
    ? null
    : new Registry({ ...options.registry, ...(options.signal ? { signal: options.signal } : {}) });
  const lastModified = lastModifiedIndex(ctx);
  const evidenceOf = new Map<string, Evidence[]>();
  for (const item of evidence)
    evidenceOf.set(item.package, [...(evidenceOf.get(item.package) ?? []), item]);
  options.signal?.throwIfAborted();
  await checkPackages(merged, {
    registry,
    popularityFloor: options.popularityFloor ?? DEFAULT_POPULARITY_FLOOR,
    cutoffOf: (pkg) => cutoffOf(pkg, evidenceOf, lastModified, captureDate),
    warn,
  });
  for (const [name, version] of accept) {
    const pkg = merged.find((p) => p.name === name);
    if (pkg && version) {
      pkg.version = version;
      pkg.versionSource = "evidence";
    }
  }

  // 4. Decide where each package goes.
  const min = options.minConfidence ?? "medium";
  const rejected = new Set(parseSpecs(options.reject ?? [], warn).keys());
  const records: PackageRecord[] = merged.map((pkg) => {
    const base = { ...pkg, vendorBytes: 0 };
    if (rejected.has(pkg.name))
      return { ...base, status: "rejected", reason: "rejected with --reject" };
    if (accept.has(pkg.name))
      return { ...base, status: pkg.dev ? "devDependency" : "dependency", reason: null };
    if (pkg.registry?.status === "failed")
      return { ...base, status: "review", reason: pkg.registry.reason };
    if (pkg.transitiveOf.length > 0)
      return {
        ...base,
        status: "transitive",
        reason: `installed with ${pkg.transitiveOf.join(", ")}`,
      };
    if (CONFIDENCE_RANK[pkg.confidence] < CONFIDENCE_RANK[min])
      return {
        ...base,
        status: "review",
        reason: `${pkg.confidence} confidence (below ${min}): ${pkg.signals.join(", ") || "implied"}`,
      };
    return { ...base, status: pkg.dev ? "devDependency" : "dependency", reason: null };
  });
  // A transitive package whose parent went to review is not installed through it: review it too.
  // Repeated until nothing changes, so a chain of transitives under a reviewed parent all moves.
  for (let changed = true; changed; ) {
    changed = false;
    for (const record of records) {
      if (record.status !== "transitive") continue;
      const parents = records.filter((r) => record.transitiveOf.includes(r.name));
      if (parents.every((p) => p.status === "review" || p.status === "rejected")) {
        record.status = "review";
        record.reason = `depends on ${record.transitiveOf.join(", ")}, which ${parents.length === 1 ? "is" : "are"} not accepted`;
        changed = true;
      }
    }
  }

  // 5. Vendor ranges for everything that will be installed.
  const installed = new Map<string, string | null>();
  for (const r of records)
    if (r.status === "dependency" || r.status === "transitive") installed.set(r.name, r.version);
  const bundles = await vendorRanges({ ctx, evidence, accepted: installed });
  const vendorBytes = new Map<string, number>();
  for (const bundle of bundles)
    for (const range of bundle.ranges)
      vendorBytes.set(
        range.package,
        (vendorBytes.get(range.package) ?? 0) + range.end - range.start,
      );
  for (const record of records) record.vendorBytes = vendorBytes.get(record.name) ?? 0;
  await writeJsonAtomic(out.vendorRanges, { bundles } satisfies { bundles: BundleRanges[] });

  // 6. package.json.
  const hints = await ctx.readJson<ProjectHints>(paths.projectHints);
  const manager = chooseManager(options.pm, hints?.packageManager?.value, options.managerVersion);
  const ranges = options.ranges ?? "exact";
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  for (const r of records) {
    if (r.status === "dependency") dependencies[r.name] = versionSpec(r.version, ranges);
    if (r.status === "devDependency") devDependencies[r.name] = versionSpec(r.version, ranges);
  }
  for (const [name, version] of await hintDevDependencies(hints, registry, captureDate, warn)) {
    // A package detected on its own is placed by its record, even when that is review.
    if (name in dependencies || name in devDependencies || records.some((r) => r.name === name))
      continue;
    devDependencies[name] = versionSpec(version, ranges);
  }
  const packageJson = buildPackageJson({
    name: projectName(manifest.targetUrl),
    manager,
    dependencies,
    devDependencies,
  });
  await writeJsonAtomic(out.packageJson, packageJson);

  const file: PackagesFile = {
    packageManager: {
      name: manager.name,
      source: manager.source,
      version: manager.version ?? null,
    },
    packages: records,
  };
  await writeJsonAtomic(out.packages, file);
  await writeJsonAtomic(out.review, {
    packages: records
      .filter((r) => r.status === "review" || r.status === "rejected")
      .map((r) => ({
        name: r.name,
        version: r.version,
        confidence: r.confidence,
        status: r.status,
        reason: r.reason,
        signals: r.signals,
        trusted: r.trusted,
        evidence: r.evidence,
      })),
  });

  // 7. Install, with scripts disabled.
  let install: Omit<InstallResult, "output"> | undefined;
  if (options.install) {
    progress({ kind: "install", manager: manager.name, dir: out.project });
    if (!manager.version) warn(`${manager.name} is not installed; the install will fail.`);
    const result = await installProject(out.project, manager, options.signal);
    options.signal?.throwIfAborted();
    await writeFileAtomic(out.installLog, result.output);
    install = { manager: result.manager, exitCode: result.exitCode, lockfile: result.lockfile };
    if (result.exitCode !== 0)
      warn(`${manager.name} install exited with ${result.exitCode}; see analysis/install.log.`);
  }

  const count = (s: PackageStatus) => records.filter((r) => r.status === s).length;
  return {
    stats: {
      evidence: evidence.length,
      packages: records.length,
      dependencies: Object.keys(dependencies).length,
      devDependencies: Object.keys(devDependencies).length,
      transitive: count("transitive"),
      review: count("review") + count("rejected"),
      bundlesWithVendorCode: bundles.length,
      vendorBytes: bundles.reduce((n, b) => n + b.vendorBytes, 0),
      registryRequests: registry?.requests ?? 0,
      ...(install ? { installExitCode: install.exitCode } : {}),
    },
    details: {
      packageManager: manager.name,
      packageManagerSource: manager.source,
      offline: Boolean(options.offline),
      ...(install ? { lockfile: install.lockfile } : {}),
    },
    rows: records.map(toRow),
    ...(install ? { install } : {}),
  };
}

function toRow(r: PackageRecord): PackageRow {
  return {
    name: r.name,
    version: r.version,
    confidence: r.confidence,
    status: r.status,
    signals: r.signals,
  };
}

async function readRows(paths: WorkspacePaths): Promise<PackageRow[]> {
  try {
    const file = JSON.parse(await readFile(detectPaths(paths).packages, "utf8")) as PackagesFile;
    return file.packages.map(toRow);
  } catch {
    return [];
  }
}

/** `name` or `name@version` (scoped names keep their leading `@`). */
function parseSpecs(specs: string[], warn: (m: string) => void): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const spec of specs
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean)) {
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : null;
    if (!isNpmName(name)) {
      warn(`Ignoring "${spec}": not a valid package name.`);
      continue;
    }
    out.set(name, version || null);
  }
  return out;
}

function manualPackage(name: string, version: string | null): MergedPackage {
  return {
    name,
    version,
    versionSource: (version ? "evidence" : "unresolved") satisfies VersionSource,
    confidence: "low",
    strongest: "name-only",
    signals: [],
    trusted: true,
    dev: false,
    evidence: [],
    versions: [],
    disagreements: [],
    bytes: 0,
    pages: [],
    impliedBy: [],
    transitiveOf: [],
    parents: [],
    registry: null,
  };
}

function lastModifiedIndex(ctx: DetectContext): Map<string, number> {
  const index = new Map<string, number>();
  const add = (key: string, header: string | null) => {
    const at = header ? Date.parse(header) : Number.NaN;
    if (!Number.isNaN(at)) index.set(key, at);
  };
  for (const asset of ctx.assets) {
    add(asset.hash, asset.lastModified);
    for (const url of asset.urls) add(url, asset.lastModified);
  }
  for (const license of ctx.licenseFiles) add(license.url, license.lastModified);
  return index;
}

/** The newest `Last-Modified` among the files that named the package, else the capture date. */
function cutoffOf(
  pkg: MergedPackage,
  evidenceOf: Map<string, Evidence[]>,
  lastModified: Map<string, number>,
  captureDate: Date,
): Date {
  let latest: number | undefined;
  for (const name of [pkg.name, ...pkg.impliedBy]) {
    for (const item of evidenceOf.get(name) ?? []) {
      const at =
        lastModified.get(item.location.bodyHash ?? "") ?? lastModified.get(item.location.file);
      if (at !== undefined && (latest === undefined || at > latest)) latest = at;
    }
  }
  return latest === undefined ? captureDate : new Date(latest);
}

/** devDependencies the source maps imply: typescript, sass, less, tailwindcss, framework CLIs. */
async function hintDevDependencies(
  hints: ProjectHints | undefined,
  registry: Registry | null,
  cutoff: Date,
  warn: (m: string) => void,
): Promise<Map<string, string | null>> {
  const names: string[] = [];
  if (hints?.language?.value === "typescript" && hints.language.confidence >= 0.5)
    names.push("typescript");
  for (const style of hints?.styling ?? []) {
    if (style.value === "scss") names.push("sass");
    if (style.value === "less") names.push("less");
    if (style.value === "tailwind") names.push("tailwindcss");
  }
  for (const framework of hints?.framework ?? []) {
    if (framework.value === "sveltekit") names.push("@sveltejs/kit");
    if (framework.value === "angular") names.push("@angular/cli");
  }
  const out = new Map<string, string | null>();
  for (const name of new Set(names)) {
    let version: string | null = null;
    if (registry) {
      try {
        const info = await registry.packageInfo(name);
        version = info ? resolveVersion(info, cutoff) : null;
      } catch (error) {
        if (registry.aborted) throw error;
        warn(`Could not resolve a version for ${name}: ${(error as Error).message}`);
      }
    }
    out.set(name, version);
  }
  return out;
}

export interface Explanation {
  package: string;
  record: PackageRecord | null;
  evidence: Evidence[];
}

/** Every piece of evidence behind one package, from a workspace `detect` has run on. */
export async function explain(workspace: string, name: string, cwd?: string): Promise<Explanation> {
  const paths = workspacePaths(path.resolve(cwd ?? process.cwd(), workspace));
  const out = detectPaths(paths);
  let file: PackagesFile;
  try {
    file = JSON.parse(await readFile(out.packages, "utf8")) as PackagesFile;
  } catch {
    throw new WorkspaceError(`No packages.json in ${paths.analysis}. Run "s2s detect" first.`);
  }
  const record = file.packages.find((p) => p.name === name) ?? null;
  const evidence: Evidence[] = [];
  for (const collector of Object.keys(COLLECTOR_FILES) as CollectorName[]) {
    try {
      const parsed = EvidenceFile.parse(
        JSON.parse(await readFile(out.evidence(collector), "utf8")),
      );
      evidence.push(...parsed.evidence.filter((e) => e.package === name));
    } catch {
      // A collector file that is missing has nothing to add.
    }
  }
  return { package: name, record, evidence };
}
