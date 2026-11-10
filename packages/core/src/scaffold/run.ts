import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { readManifest, type StageState, writeManifest } from "../capture/manifest.js";
import { type RequestRecord, readRequestLog } from "../capture/request-log.js";
import { type WorkspacePaths, workspacePaths } from "../capture/workspace.js";
import {
  installProject,
  PACKAGE_MANAGERS,
  type PackageJson,
  type PackageManager,
} from "../detect/project.js";
import { writeFileAtomic, writeJsonAtomic } from "../fs-util.js";
import { WorkspaceError } from "../maps/run.js";
import { readFramework, recovererByName } from "../recoverers/registry.js";
import type { ModulesFile } from "../unbundle/graph.js";
import { packageName } from "../unbundle/graph.js";
import { loadThresholds } from "../verify/config.js";
import {
  agentsMd,
  CLAUDE_MD,
  claudeSettings,
  progressMd,
  promptMd,
  slashCommandMd,
} from "./agent-files.js";
import { chunkExports, chunkStem, type SplitChunk, synthesizeMissing } from "./barrels.js";
import { buildFailureExcerpt, git, runScript } from "./exec.js";
import {
  type AgentFacts,
  DEFAULT_THRESHOLDS,
  type GroupFact,
  type StackFact,
  type Target,
  type Thresholds,
} from "./facts.js";
import { buildIndexHtml } from "./html.js";
import { hasJsx, relocateReferences } from "./relocate.js";
import {
  configTs,
  mainTs,
  needsWasmPlugin,
  runtimeShim,
  SHIM_HELPERS,
  scaffoldPackageJson,
  tsconfig,
  viteConfig,
  WORKSPACE_GITIGNORE,
} from "./templates.js";
import { type NamedBinding, resolveVendorNames } from "./vendor-names.js";
import { findWorkspacePackages, workspaceEntry } from "./workspaces.js";

export interface ScaffoldOptions {
  workspace: string;
  cwd?: string;
  force?: boolean;
  /** UI library for the Vite project; detected from the packages when left out. */
  target?: Target;
  /** Install dependencies (scripts disabled). Defaults to true. */
  install?: boolean;
  /** Build once after installing and record the result. Defaults to true. */
  build?: boolean;
  /** `git init` and commit `s2s scaffold`. Defaults to true. */
  git?: boolean;
  /** Options for the chosen recoverer's scaffold hook, such as `{ assets: "proxy" }` for three. */
  recoverer?: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (event: ScaffoldProgress) => void;
}

export type ScaffoldProgress =
  | { kind: "start"; workspace: string }
  | { kind: "skip"; workspace: string; reason: string }
  | { kind: "warning"; message: string }
  | { kind: "step"; step: "files" | "install" | "build" | "git" }
  | { kind: "done"; status: StageState["status"]; summary: string };

export interface ScaffoldResult {
  workspace: string;
  status: StageState["status"];
  skipped: boolean;
  stats: Record<string, number>;
  warnings: string[];
  summary: string;
  target?: Target;
  /** `passed`, `failed` or `skipped`. */
  build?: string;
  /** First lines of a failed build's output. */
  buildOutput?: string;
  error?: string;
}

/** What `analysis/scaffold.json` records: the target, the entry, and where each module went. */
export interface ScaffoldFile {
  target: Target;
  fallbackFrom: string | null;
  page: string;
  entry: { styles: string[]; modules: string[]; runtime: boolean };
  removedFromHtml: string[];
  files: { module: string; original: string; file: string }[];
  /** Files s2s wrote because the code imports them and no source map held them. */
  synthesized: {
    path: string;
    kind: string;
    importers: string[];
    missing?: string[];
    placeholderTypes?: string[];
  }[];
}

/** For example "react · 3 modules · build passed". */
export function summaryLine(target: string, stats: Record<string, number>, build: string): string {
  const n = stats.modules ?? 0;
  return `${target} · ${n} module${n === 1 ? "" : "s"} · build ${build}`;
}

const SSR_FRAMEWORKS: Record<string, string> = {
  next: "Next.js",
  nuxt: "Nuxt",
  astro: "Astro",
  "@sveltejs/kit": "SvelteKit",
  gatsby: "Gatsby",
  "@remix-run/react": "Remix",
};

interface PackagesFile {
  packageManager?: { name: string; source: string; version: string | null };
  packages: {
    name: string;
    version: string | null;
    confidence: string;
    status: string;
    dev?: boolean;
    registry?: { exists?: boolean | null; versionPublished?: boolean | null };
  }[];
}

interface ReviewFile {
  packages: { name: string; version: string | null; confidence: string; reason: string | null }[];
}

interface ReportFile {
  modules: { id: string; file: string; chunk: string; range: { start: number } }[];
  styles?: { file: string; url: string; kind: string; pages: string[] }[];
  exactSources?: { file: string; chunk: string; pages: string[] }[];
}

interface PageInfo {
  slug: string;
  url: string;
  finalUrl: string;
  tags: { tag: string; attributes: Record<string, string> }[];
}

/**
 * Stage 5a: turn the recovered modules into a Vite project that builds as is, wired so the
 * untouched scaffold behaves like the site, and write the files that hand the rest to an agent.
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const root = path.resolve(options.cwd ?? process.cwd(), options.workspace);
  const paths = workspacePaths(root);
  const progress = options.onProgress ?? (() => {});
  const manifest = await readManifest(paths.manifest).catch((error: Error) => {
    throw new WorkspaceError(`${paths.manifest} is unreadable: ${error.message.split("\n")[0]}`);
  });
  if (!manifest)
    throw new WorkspaceError(`No workspace at ${root}. Run "s2s capture <url>" first.`);
  if (manifest.stages.unbundle.status !== "complete")
    throw new WorkspaceError(
      `Unbundle in ${root} is ${manifest.stages.unbundle.status}. Run "s2s unbundle" before "s2s scaffold".`,
    );
  const previous = manifest.stages.scaffold;
  const sameTarget =
    (!options.target || previous.details?.target === options.target) &&
    Object.entries(options.recoverer ?? {}).every(
      ([k, v]) => v === undefined || previous.details?.[k] === v,
    );
  if (previous.status === "complete" && !options.force && sameTarget) {
    progress({ kind: "skip", workspace: root, reason: "scaffold is already complete" });
    const target = String(previous.details?.target ?? "vanilla");
    const build = String(previous.details?.build ?? "skipped");
    const webglSummary = previous.details?.webglSummary;
    return {
      workspace: root,
      status: "complete",
      skipped: true,
      stats: previous.stats,
      warnings: previous.warnings,
      summary:
        typeof webglSummary === "string"
          ? `${webglSummary} · build ${build}`
          : summaryLine(target, previous.stats, build),
      target: target as Target,
      build,
    };
  }

  const startedAt = new Date();
  manifest.stages.scaffold = {
    status: "partial",
    startedAt: startedAt.toISOString(),
    stats: {},
    warnings: [],
  };
  await writeManifest(paths.manifest, manifest);
  progress({ kind: "start", workspace: root });
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (warnings.includes(message)) return;
    warnings.push(message);
    progress({ kind: "warning", message });
  };

  let status: StageState["status"] = "failed";
  let error: string | undefined;
  let outcome: Outcome | undefined;
  try {
    outcome = await run(paths, manifest.targetUrl, options, warn, progress);
    status = "complete";
  } catch (caught) {
    if (options.signal?.aborted) {
      status = "partial";
      error = "Interrupted";
    } else {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  const stats = outcome?.stats ?? {};
  manifest.stages.scaffold = {
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    stats,
    warnings,
    ...(outcome
      ? {
          details: {
            target: outcome.target,
            fallbackFrom: outcome.fallbackFrom,
            install: outcome.install,
            build: outcome.build,
            lockfile: outcome.lockfile,
            recoverer: outcome.recoverer,
            ...outcome.recovererDetails,
          },
        }
      : {}),
    ...(error ? { error } : {}),
  };
  await writeManifest(paths.manifest, manifest);
  // The manifest changed after the commit; fold it in so the tree starts clean.
  if (outcome?.committed)
    await git(["commit", "-q", "--amend", "--no-edit", "-a"], root, outcome.fallbackIdentity);
  const webglSummary = outcome?.recovererDetails.webglSummary;
  const summary =
    typeof webglSummary === "string"
      ? `${webglSummary} · build ${outcome?.build ?? "skipped"}`
      : summaryLine(outcome?.target ?? "unknown", stats, outcome?.build ?? "skipped");
  progress({ kind: "done", status, summary });
  return {
    workspace: root,
    status,
    skipped: false,
    stats,
    warnings,
    summary,
    ...(outcome ? { target: outcome.target, build: outcome.build } : {}),
    ...(outcome?.buildOutput ? { buildOutput: outcome.buildOutput } : {}),
    ...(error ? { error } : {}),
  };
}

interface Outcome {
  target: Target;
  fallbackFrom: string | null;
  stats: Record<string, number>;
  install: string;
  build: string;
  buildOutput?: string;
  lockfile: string | null;
  committed: boolean;
  fallbackIdentity: boolean;
  recoverer: string;
  recovererDetails: Record<string, string | number | boolean | null>;
}

/** Whether a recovered module still binds a library's whole namespace (`const X = __vendor_y;`). */
async function hasUnnamedAliases(files: string[]): Promise<boolean> {
  for (const file of files) {
    const code = await readFile(file, "utf8").catch(() => "");
    if (/^const [\w$]+ = __vendor_[\w$]+;$/m.test(code)) return true;
  }
  return false;
}

/**
 * Install the review `candidates` next to the project's dependencies, name bindings again with
 * them, and keep each one that named something. The rest come out of `package.json` again.
 */
async function tryReviewPackages(
  paths: WorkspacePaths,
  pm: PackageManager,
  packagesFile: PackagesFile,
  candidates: PackagesFile["packages"],
  signal: AbortSignal | undefined,
  name: () => Promise<NamedBinding[]>,
): Promise<{ named: NamedBinding[]; kept: PackagesFile["packages"]; lockfile: string | null }> {
  const original = await readFile(paths.packageJson, "utf8");
  const manifest = JSON.parse(original) as PackageJson & { dependencies?: Record<string, string> };
  const install = () =>
    installProject(
      paths.project,
      { name: pm, version: packagesFile.packageManager?.version ?? undefined },
      signal,
    );
  const restore = async () => {
    await writeFileAtomic(paths.packageJson, original);
    return install();
  };
  manifest.dependencies = { ...manifest.dependencies };
  for (const c of candidates) manifest.dependencies[c.name] = c.version as string;
  await writeJsonAtomic(paths.packageJson, manifest);
  if ((await install()).exitCode !== 0) {
    const back = await restore();
    return { named: [], kept: [], lockfile: back.lockfile };
  }
  const named = await name();
  const root = (pkg: string) =>
    pkg.startsWith("@") ? pkg.split("/").slice(0, 2).join("/") : (pkg.split("/")[0] ?? pkg);
  // A binding records the namespace it stood for (`gsap`); the package it is now is its import.
  const used = new Set(named.map((n) => root(n.specifier)));
  const kept = candidates.filter((c) => used.has(c.name));
  if (kept.length === 0) {
    const back = await restore();
    return { named, kept, lockfile: back.lockfile };
  }
  const dropped = candidates.filter((c) => !used.has(c.name));
  if (dropped.length === 0) return { named, kept, lockfile: null };
  for (const c of dropped) delete manifest.dependencies[c.name];
  await writeJsonAtomic(paths.packageJson, manifest);
  const result = await install();
  return { named, kept, lockfile: result.lockfile };
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const posix = (p: string) => p.split(path.sep).join("/");

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

/** The project path a workspace file moves to (both workspace-relative, posix). */
function projectPath(file: string, jsx: boolean): string {
  let rel: string;
  if (file.startsWith("recovered/unbundled/shaders/") && /\.glsl$/i.test(file))
    rel = `project/src/shaders/${file.slice("recovered/unbundled/shaders/".length)}`;
  else if (file.startsWith("recovered/unbundled/"))
    rel = `project/src/_recovered/${file.slice("recovered/unbundled/".length)}`;
  else if (file.startsWith("recovered/sourcemap/"))
    rel = `project/src/_recovered/_sourcemap/${file.slice("recovered/sourcemap/".length)}`;
  else if (file.startsWith("assets/")) rel = `project/src/${file}`;
  else rel = `project/src/_recovered/_other/${file}`;
  return jsx ? rel.replace(/\.js$/, ".jsx") : rel;
}

export function chooseTarget(packages: PackagesFile["packages"]): {
  target: Target;
  fallbackFrom: string | null;
} {
  const accepted = new Set(
    packages
      .filter((p) => p.status === "dependency" || p.status === "devDependency")
      .map((p) => p.name),
  );
  const fallback = Object.entries(SSR_FRAMEWORKS).find(([name]) => accepted.has(name));
  const target: Target =
    accepted.has("react") || accepted.has("react-dom")
      ? "react"
      : accepted.has("preact")
        ? "preact"
        : accepted.has("vue")
          ? "vue"
          : "vanilla";
  return { target, fallbackFrom: fallback?.[1] ?? null };
}

async function readPages(paths: WorkspacePaths): Promise<PageInfo[]> {
  const slugs = existsSync(paths.pages) ? (await readdir(paths.pages)).sort() : [];
  const pages: PageInfo[] = [];
  for (const slug of slugs) {
    const page = await readJson<Omit<PageInfo, "slug">>(path.join(paths.pages, slug, "page.json"));
    if (page) pages.push({ slug, url: page.url, finalUrl: page.finalUrl, tags: page.tags ?? [] });
  }
  return pages;
}

async function run(
  paths: WorkspacePaths,
  targetUrl: string,
  options: ScaffoldOptions,
  warn: (message: string) => void,
  progress: (event: ScaffoldProgress) => void,
): Promise<Outcome> {
  const signal = options.signal;
  const graph = await readJson<ModulesFile>(paths.modules);
  if (!graph) throw new Error('analysis/modules.json is missing; run "s2s unbundle" again.');
  const report = (await readJson<ReportFile>(paths.unbundleReport)) ?? { modules: [] };
  const packagesFile = (await readJson<PackagesFile>(
    path.join(paths.analysis, "packages.json"),
  )) ?? { packages: [] };
  const reviewFile = (await readJson<ReviewFile>(
    path.join(paths.analysis, "packages-review.json"),
  )) ?? { packages: [] };
  const pkg = await readJson<PackageJson>(paths.packageJson);
  if (!pkg) throw new Error('project/package.json is missing; run "s2s detect" again.');

  const chosen = chooseTarget(packagesFile.packages);
  const target = options.target ?? chosen.target;
  const fallbackFrom = chosen.fallbackFrom;
  if (fallbackFrom)
    warn(
      `The site was built with ${fallbackFrom}; the scaffold is a Vite SPA built from the hydrated DOM.`,
    );
  const pmName = packagesFile.packageManager?.name;
  const pm: PackageManager = (PACKAGE_MANAGERS as readonly string[]).includes(pmName ?? "")
    ? (pmName as PackageManager)
    : "npm";

  // 1. Clear what an earlier scaffold wrote, keeping node_modules so a rerun installs fast.
  progress({ kind: "step", step: "files" });
  for (const p of ["src", "dist", "index.html", "vite.config.ts", "tsconfig.json"])
    await rm(path.join(paths.project, p), { recursive: true, force: true });

  // 2. Plan where every file goes, then copy with references re-pointed.
  const sources: string[] = [];
  for (const m of graph.modules) sources.push(m.file);
  // Exact sources the graph doesn't list (their CSS, JSON, images) are still imported by the ones
  // it does. Bundler internals and node_modules copies stay out.
  const listed = new Set(sources.map((s) => s.toLowerCase()));
  for (const file of await listFiles(paths.recoveredSourcemap)) {
    const rel = posix(path.relative(paths.root, file));
    const inner = rel.slice("recovered/sourcemap/".length);
    if (/^_(?:vendor|virtual)\//.test(inner) || listed.has(rel.toLowerCase())) continue;
    sources.push(rel);
    listed.add(rel.toLowerCase());
  }
  for (const file of await listFiles(paths.assets))
    sources.push(posix(path.relative(paths.root, file)));
  // GLSL a recoverer pulled out of string literals; the modules import them with `?raw`.
  for (const file of await listFiles(path.join(paths.unbundled, "shaders")))
    if (/\.glsl$/i.test(file)) sources.push(posix(path.relative(paths.root, file)));
  const texts = new Map<string, string>();
  const moves = new Map<string, string>();
  for (const file of sources) {
    const text = /\.(?:m?jsx?|cjs|tsx?|vue|svelte|css|scss|sass|less)$/i.test(file)
      ? await readFile(path.join(paths.root, file), "utf8").catch(() => undefined)
      : undefined;
    if (text !== undefined) texts.set(file, text);
    const jsx = /\.js$/i.test(file) && text !== undefined && hasJsx(text);
    moves.set(file.toLowerCase(), projectPath(file, jsx));
  }
  let notes = 0;
  const written = new Map<string, string | undefined>();
  const requirePackages = new Set<string>();
  const requireHelpers = new Set<string>();
  for (const file of sources) {
    signal?.throwIfAborted();
    const next = moves.get(file.toLowerCase()) as string;
    const out = path.join(paths.root, next);
    await mkdir(path.dirname(out), { recursive: true });
    const text = texts.get(file);
    if (text === undefined) {
      await copyFile(path.join(paths.root, file), out);
      written.set(next, undefined);
      continue;
    }
    // Vite injects its own `__vitePreload` and `__vite__mapDeps` into modules with a dynamic
    // `import()`; the site's recovered copies of those helpers must not collide with them.
    const relocated = relocateReferences(text, file, next, moves).replace(
      /(?<![\w$])(__vitePreload|__vite__mapDeps)(?![\w$])/g,
      (_, name: string) => `__recovered${name.replace(/^__vite_?_?/, "Vite_")}`,
    );
    notes += relocated.match(/\/\/ s2s:/g)?.length ?? 0;
    if (/\.(?:m?jsx?|cjs)$/.test(next)) {
      for (const m of relocated.matchAll(/(?<![\w$.])require\s*\(\s*["']([^"'./][^"']*)["']\s*\)/g))
        requirePackages.add(m[1] as string);
      for (const m of relocated.matchAll(/(?<![\w$.])require\.(\w+)\b/g))
        requireHelpers.add(m[1] as string);
      if (/(?<![\w$.])require\s*\(\s*["']\./.test(relocated))
        warn(`${next}: requires a local file with require(); convert it to an import.`);
    }
    await writeFileAtomic(out, relocated);
    written.set(next, relocated);
  }
  // The site's own monorepo packages, imported by name, resolve to their recovered folders. Only
  // Stage 3's evidence counts as installed: package.json also holds what an earlier scaffold added.
  const installed = new Set(packagesFile.packages.map((p) => p.name));
  const workspace = findWorkspacePackages(
    graph.modules.flatMap((m) => m.packageImports),
    written.keys(),
    installed,
  );
  // Chunks the unbundler split, with the export list each ends with, for imports of their
  // entry module that no map recovered.
  const bodyOf = new Map<string, string>();
  for (const r of await readRequestLog(paths.requests).catch(() => [] as RequestRecord[]))
    if (r.bodyHash && r.status >= 200 && r.status < 300) bodyOf.set(r.url, r.bodyHash);
  const partsOf = new Map<string, string[]>();
  for (const m of report.modules) {
    const moved = moves.get(m.file.toLowerCase());
    if (!moved) continue;
    const list = partsOf.get(m.chunk) ?? [];
    list.push(moved);
    partsOf.set(m.chunk, list);
  }
  const chunks: SplitChunk[] = [];
  for (const [url, parts] of partsOf) {
    const stem = chunkStem(url);
    const hash = bodyOf.get(url);
    if (!stem || !hash) continue;
    const code = await readFile(path.join(paths.bodies, hash), "utf8").catch(() => "");
    const exports = chunkExports(code);
    if (exports.length > 0) chunks.push({ stem, exports, parts });
  }
  // Barrels, stylesheets and chunk entries the code imports that no map could hold.
  const synthesized = synthesizeMissing(written, workspace, chunks);
  for (const file of synthesized)
    await writeFileAtomic(path.join(paths.root, file.path), file.content);
  const barrelCount = synthesized.filter((f) => f.kind === "barrel").length;
  const stubCount = synthesized.filter((f) => f.kind === "style-stub").length;
  const standIns = synthesized.filter((f) => f.kind === "chunk-stand-in");
  if (barrelCount > 0)
    warn(
      `Rebuilt ${barrelCount} barrel index file(s) no source map held; see analysis/scaffold.json.`,
    );
  if (standIns.length > 0)
    warn(
      `Pointed ${standIns.length} import(s) of chunks split without a map at their split parts (${standIns.map((f) => path.posix.basename(f.path)).join(", ")}).`,
    );
  for (const file of synthesized) written.set(file.path, file.content);
  const projectFiles = new Set(written.keys());
  const aliases = workspace.map((w) => ({
    name: w.name,
    entry: `./${workspaceEntry(w, projectFiles).replace(/^project\//, "")}`,
    root: `./${w.root.replace(/^project\//, "")}`,
  }));
  if (aliases.length > 0)
    warn(
      `Aliased ${aliases.length} package(s) to the site's own recovered workspace folders: ${aliases.map((a) => a.name).join(", ")}.`,
    );
  // Plugin virtual modules (`virtual:pwa-register`) whose generated code a map kept.
  const virtuals = await virtualModules(paths, moves, written);
  for (const v of virtuals) {
    await writeFileAtomic(path.join(paths.root, v.file), v.content);
    written.set(v.file, v.content);
    aliases.push({ name: v.name, entry: `./${v.file.replace(/^project\//, "")}`, root: "." });
  }
  if (virtuals.length > 0)
    warn(
      `Aliased ${virtuals.length} plugin virtual module(s) to the code their map kept: ${virtuals.map((v) => v.name).join(", ")}.`,
    );
  if (stubCount > 0)
    warn(
      `Wrote ${stubCount} empty stylesheet(s) the code imports but no source map held; their rules come from the captured CSS.`,
    );

  // 3. The entry: what the first page's own scripts and stylesheets ran, in document order.
  const pages = await readPages(paths);
  const page =
    pages.find((p) => p.url === targetUrl || p.finalUrl === targetUrl) ?? pages[0] ?? null;
  const pageUrl = page?.finalUrl ?? targetUrl;
  const abs = (href: string) => {
    try {
      return new URL(href, pageUrl).href.replace(/#.*$/, "");
    } catch {
      return href;
    }
  };
  const scripts = (page?.tags ?? [])
    .filter((t) => t.tag === "script" && t.attributes.src)
    .map((t) => abs(t.attributes.src as string));
  const links = (page?.tags ?? [])
    .filter(
      (t) =>
        t.tag === "link" && /\bstylesheet\b/i.test(t.attributes.rel ?? "") && t.attributes.href,
    )
    .map((t) => abs(t.attributes.href as string));
  const sheets = (report.styles ?? []).filter((s) => s.kind === "sheet");
  const styles = links
    .map((url) => sheets.find((s) => s.url === url))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => s.file);

  const chunkOf = new Map<string, string>();
  for (const m of report.modules) chunkOf.set(m.file, m.chunk);
  for (const e of report.exactSources ?? []) chunkOf.set(e.file, e.chunk);
  const startOf = new Map(report.modules.map((m) => [m.file, m.range.start]));
  const importedBy = new Set(graph.modules.flatMap((m) => m.imports));
  const dynamicTargets = new Set(graph.modules.flatMap((m) => m.dynamicImports));
  const code = graph.modules.filter((m) => m.kind !== "style");
  // Per script, in document order: the chunk's modules nothing imports. When every module in a
  // chunk is imported (they import each other), the one that ends the chunk: importing it runs
  // its dependencies first, which is the order the chunk ran them.
  const byStart = (a: (typeof code)[number], b: (typeof code)[number]) =>
    (startOf.get(a.file) ?? 0) - (startOf.get(b.file) ?? 0) || a.file.localeCompare(b.file);
  let entryModules: typeof code = [];
  for (const script of scripts) {
    const inChunk = code.filter((m) => chunkOf.get(m.file) === script).sort(byStart);
    if (inChunk.length === 0) continue;
    const roots = inChunk.filter((m) => !importedBy.has(m.id));
    entryModules.push(...(roots.length > 0 ? roots : [inChunk.at(-1) as (typeof code)[number]]));
  }
  if (entryModules.length === 0 && code.length > 0) {
    entryModules = code.filter((m) => !importedBy.has(m.id) && !dynamicTargets.has(m.id));
    warn(
      "No recovered module belongs to a script the page loads; the entry imports every module nothing else imports.",
    );
  }
  const fromMain = (file: string) => {
    const moved = moves.get(file.toLowerCase()) ?? file;
    return `./${moved.slice("project/src/".length)}`;
  };
  const runtimePackages = [...requirePackages]
    .filter((name) => {
      const base = packageName(name);
      const ok = base in (pkg.dependencies ?? {}) || base in (pkg.devDependencies ?? {});
      if (!ok) warn(`Recovered code calls require("${name}"), which is not in package.json.`);
      return ok;
    })
    .sort();
  for (const helper of [...requireHelpers].sort())
    if (!SHIM_HELPERS.includes(helper))
      warn(
        `Recovered code calls the webpack helper require.${helper}, which the runtime shim does not provide.`,
      );
  const runtime = runtimePackages.length > 0 || requireHelpers.size > 0;
  if (runtime) {
    await writeFileAtomic(
      path.join(paths.project, "src", "_s2s", "runtime.ts"),
      runtimeShim(runtimePackages, [...requireHelpers].sort()),
    );
  }
  const mainStyles = styles.map(fromMain);
  const mainModules = entryModules.map((m) => fromMain(m.file));
  await writeFileAtomic(
    path.join(paths.project, "src", "main.ts"),
    mainTs({ runtime, styles: mainStyles, modules: mainModules }),
  );

  // 4. index.html from the captured page; an SSR site's hydrated DOM instead of its server HTML.
  let removedFromHtml: string[] = [];
  if (page) {
    const dir = path.join(paths.pages, page.slug);
    const ssr = await readFile(path.join(dir, "ssr.html"), "utf8").catch(() => undefined);
    const dom = await readFile(path.join(dir, "dom.html"), "utf8").catch(() => undefined);
    const source = fallbackFrom ? (dom ?? ssr) : (ssr ?? dom);
    // Every first-party JS chunk (a webpack runtime chunk has no modules but still goes).
    const bundlerFile = await readJson<{ chunks: { url: string }[] }>(paths.bundlerReport);
    const replaced = new Set<string>([
      ...(bundlerFile?.chunks ?? []).map((c) => c.url),
      ...report.modules.map((m) => m.chunk),
      ...(report.exactSources ?? []).map((e) => e.chunk),
      ...sheets.map((s) => s.url),
    ]);
    const built = buildIndexHtml({
      html: source ?? "<!doctype html>\n<html>\n<body>\n</body>\n</html>\n",
      pageUrl,
      replaced,
      dropInlineScripts: fallbackFrom !== null,
      entry: "/src/main.ts",
    });
    removedFromHtml = built.removed;
    // The site bundled the browser `process` polyfill, as webpack 4 and browserify did on their
    // own; installed packages (`util`) now read the global, so define it before the app runs.
    // The polyfill itself may have been dropped as library code: look in the captured bundles too.
    const marker = /process\.title\s*=\s*["'`]browser["'`]/;
    let polyfilled = [...written.values()].some((t) => marker.test(t ?? ""));
    for (const hash of polyfilled ? [] : new Set(bodyOf.values())) {
      const body = await readFile(path.join(paths.bodies, hash), "utf8").catch(() => "");
      if (marker.test(body)) {
        polyfilled = true;
        break;
      }
    }
    const html = polyfilled
      ? built.html.replace(
          /<head([^>]*)>/i,
          `<head$1>\n    <script>/* s2s: the browser process shim the site's bundler provided */ window.process ??= { env: {}, browser: true, version: "", versions: {}, argv: [], nextTick: (f, ...a) => queueMicrotask(() => f(...a)) };</script>`,
        )
      : built.html;
    await writeFileAtomic(path.join(paths.project, "index.html"), html);
  } else {
    warn("No page snapshot was captured; index.html is a blank page.");
    await writeFileAtomic(
      path.join(paths.project, "index.html"),
      '<!doctype html>\n<html>\n  <body>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n',
    );
  }

  // 5. Project config.
  await writeFileAtomic(
    path.join(paths.project, "vite.config.ts"),
    viteConfig(target, aliases, { wasm: needsWasmPlugin(pkg) }),
  );
  await writeFileAtomic(path.join(paths.project, "tsconfig.json"), tsconfig(target, aliases));
  // Inferred versions often disagree on peers; every npm install in the project, the agent's
  // included, should get past that the way the scaffold's own install does.
  if (pm === "npm")
    await writeFileAtomic(path.join(paths.project, ".npmrc"), "legacy-peer-deps=true\n");
  addMissingImports(pkg, graph, packagesFile, warn, new Set(aliases.map((a) => a.name)));
  await writeJsonAtomic(paths.packageJson, scaffoldPackageJson(pkg, target));

  // 5b. The recoverer's own files (three: assets, shaders, layout), before install and build.
  const framework = await readFramework(paths);
  const recoverer = recovererByName(framework.recoverer);
  const recovererStats: Record<string, number> = {};
  const recovererDetails: Record<string, string | number | boolean | null> = {};
  if (recoverer.scaffold) {
    signal?.throwIfAborted();
    await recoverer.scaffold({
      paths,
      framework,
      options: options.recoverer ?? {},
      warn,
      stats: recovererStats,
      details: recovererDetails,
    });
  }

  // 6. Agent files and the analysis record of where everything went.
  const files = graph.modules.map((m) => ({
    module: m.id,
    original: m.file,
    file: (moves.get(m.file.toLowerCase()) ?? m.file).replace(/^project\//, ""),
  }));
  const scaffoldFile: ScaffoldFile = {
    target,
    fallbackFrom,
    page: page?.slug ?? "",
    entry: { styles: mainStyles, modules: mainModules, runtime },
    removedFromHtml,
    files,
    synthesized: synthesized.map(({ content: _, ...rest }) => ({
      ...rest,
      path: rest.path.replace(/^project\//, ""),
    })),
  };
  await writeJsonAtomic(path.join(paths.analysis, "scaffold.json"), scaffoldFile);
  if (!existsSync(paths.config)) await writeFileAtomic(paths.config, configTs());
  const thresholds = await loadThresholds(paths.config).catch((e: Error) => {
    warn(`${e.message}; AGENTS.md lists the default thresholds.`);
    return DEFAULT_THRESHOLDS;
  });
  const facts = await gatherFacts(paths, targetUrl, {
    thresholds,
    target,
    fallbackFrom,
    pm,
    graph,
    packagesFile,
    reviewFile,
    pages,
    moves,
    notes,
  });
  const notesLines = recoverer.agentNotes?.(framework) ?? [];
  if (notesLines.length > 0) facts.framework = { name: framework.recoverer, lines: notesLines };
  await writeAgentFiles(paths, facts);
  await writeFileAtomic(paths.gitignore, WORKSPACE_GITIGNORE);

  // 7. Install and build once.
  let install = "skipped";
  let lockfile: string | null = null;
  let build = "skipped";
  let buildOutput: string | undefined;
  if (options.install !== false) {
    signal?.throwIfAborted();
    progress({ kind: "step", step: "install" });
    const result = await installProject(
      paths.project,
      { name: pm, version: packagesFile.packageManager?.version ?? undefined },
      signal,
    );
    lockfile = result.lockfile;
    install = result.exitCode === 0 ? "passed" : "failed";
    await writeFileAtomic(path.join(paths.analysis, "scaffold-install.log"), result.output);
    if (result.exitCode !== 0)
      warn(`${pm} install exited with ${result.exitCode}; see analysis/scaffold-install.log.`);
  }
  // With the packages installed, name what the recovered code used of each inlined library.
  let namedBindings = 0;
  if (install === "passed") {
    const files: { file: string; bundle: string }[] = [];
    for (const m of report.modules) {
      const moved = moves.get(m.file.toLowerCase());
      const hash = bodyOf.get(m.chunk);
      if (moved && hash)
        files.push({ file: path.join(paths.root, moved), bundle: path.join(paths.bodies, hash) });
    }
    const unique = [...new Map(files.map((f) => [f.file, f])).values()];
    const inline = (await readJson<{ inlined: { name: string; text: string; file?: string }[] }>(
      path.join(paths.analysis, "vendor-inline.json"),
    )) ?? { inlined: [] };
    const urlOf = new Map([...bodyOf].map(([url, hash]) => [hash, url]));
    const chunkOf = (bundle: string, spec: string) => {
      const url = urlOf.get(path.basename(bundle));
      if (!url) return undefined;
      const hash = bodyOf.get(new URL(spec, url).href);
      return hash ? path.join(paths.bodies, hash) : undefined;
    };
    const named = await resolveVendorNames(paths.project, unique, inline.inlined, chunkOf);
    // Bindings still read as a library's whole namespace may be a package Stage 3 left in review
    // (Lenis inlined next to gsap): install the ones the registry has, try them, keep what fits.
    const candidates = packagesFile.packages.filter(
      (p) =>
        p.status === "review" &&
        p.version &&
        p.registry?.exists !== false &&
        p.registry?.versionPublished !== false,
    );
    if (candidates.length > 0 && (await hasUnnamedAliases(unique.map((f) => f.file)))) {
      const added = await tryReviewPackages(paths, pm, packagesFile, candidates, signal, () =>
        resolveVendorNames(
          paths.project,
          unique,
          inline.inlined,
          chunkOf,
          candidates.map((c) => c.name),
        ),
      );
      named.push(...added.named);
      lockfile = added.lockfile ?? lockfile;
      if (added.kept.length > 0) {
        for (const p of added.kept) {
          facts.packages.push({
            name: p.name,
            version: p.version,
            confidence: p.confidence,
            dev: false,
          });
          facts.review = facts.review.filter((r) => r.name !== p.name);
        }
        facts.packages.sort((a, b) => a.name.localeCompare(b.name));
        await writeAgentFiles(paths, facts);
        warn(
          `Added ${added.kept.map((p) => `${p.name}@${p.version}`).join(", ")} from review: the recovered code reads its exports; see analysis/vendor-names.json.`,
        );
      }
    }
    namedBindings = named.length;
    await writeJsonAtomic(path.join(paths.analysis, "vendor-names.json"), {
      named: named.map((n) => ({ ...n, file: posix(path.relative(paths.root, n.file)) })),
    });
    if (named.length > 0)
      warn(
        `Named ${named.filter((n) => n.package).length} binding(s) of inlined libraries after install (${[...new Set(named.flatMap((n) => (n.package ? [n.package] : [])))].join(", ")})${named.some((n) => !n.package) ? `, and copied ${named.filter((n) => !n.package).length} internal helper(s) from the bundle` : ""}; see analysis/vendor-names.json.`,
      );
  }
  if (options.build !== false && install !== "failed") {
    signal?.throwIfAborted();
    progress({ kind: "step", step: "build" });
    const result = await runScript(paths.project, pm, "build", signal);
    build = result.exitCode === 0 ? "passed" : "failed";
    await writeFileAtomic(path.join(paths.analysis, "scaffold-build.log"), result.output);
    if (result.exitCode !== 0) {
      buildOutput = buildFailureExcerpt(result.output);
      warn("The untouched scaffold does not build; see analysis/scaffold-build.log.");
    }
  }

  // A Ctrl+C reaches the child process, which then just exits non-zero; stop here, partial.
  signal?.throwIfAborted();

  // 8. Git: a repo at the workspace root with everything but bodies and build output.
  let committed = false;
  let fallbackIdentity = false;
  if (options.git !== false) {
    progress({ kind: "step", step: "git" });
    const fresh = !existsSync(path.join(paths.root, ".git"));
    const init = fresh ? await git(["init", "-q"], paths.root) : { exitCode: 0, output: "" };
    if (init.exitCode !== 0) {
      warn(`git init failed: ${init.output.trim().split("\n")[0] ?? ""}`);
    } else {
      const email = await git(["config", "user.email"], paths.root);
      fallbackIdentity = email.exitCode !== 0 || email.output.trim() === "";
      await git(["add", "-A"], paths.root);
      const message = fresh ? "s2s scaffold" : "s2s scaffold (regenerated)";
      const commit = await git(["commit", "-q", "-m", message], paths.root, fallbackIdentity);
      committed = commit.exitCode === 0;
      if (!committed && fresh)
        warn(`git commit failed: ${commit.output.trim().split("\n")[0] ?? ""}`);
    }
  }

  return {
    target,
    fallbackFrom,
    install,
    build,
    lockfile,
    committed,
    fallbackIdentity,
    recoverer: framework.recoverer,
    recovererDetails,
    ...(buildOutput ? { buildOutput } : {}),
    stats: {
      ...recovererStats,
      modules: code.length,
      styles: graph.modules.length - code.length,
      assets: sources.filter((s) => s.startsWith("assets/")).length,
      groups: graph.groups.length,
      entryModules: mainModules.length,
      notes,
      namedBindings,
    },
  };
}

/**
 * The version spec for a missing package that Stage 3 only saw as its companion. From React
 * Router 7 on, react-router-dom is a thin re-export of react-router that stopped tracking its
 * versions, so it becomes an npm alias of the react-router actually found.
 */
function companionSpec(name: string, deps: Record<string, string>, packagesFile: PackagesFile) {
  if (name !== "react-router-dom") return undefined;
  const version =
    deps["react-router"] ?? packagesFile.packages.find((p) => p.name === "react-router")?.version;
  if (!version) return undefined;
  const major = Number.parseInt(version.replace(/^[^\d]*/, ""), 10);
  return major >= 7 ? "npm:react-router@" + version : version;
}

/**
 * Add packages the recovered code imports that `package.json` lacks, so the untouched scaffold
 * builds. The version comes from Stage 3 when it saw the package (any status), else from a
 * companion package, else `latest`; each one is a warning for the agent to confirm.
 */
export function addMissingImports(
  pkg: PackageJson,
  graph: ModulesFile,
  packagesFile: PackagesFile,
  warn: (message: string) => void,
  local: Set<string> = new Set(),
): void {
  const deps = { ...(pkg.dependencies ?? {}) };
  // An earlier scaffold may have installed a local package from npm by mistake.
  for (const name of local) delete deps[name];
  const known = (name: string) => name in deps || name in (pkg.devDependencies ?? {});
  const imported = new Set(graph.modules.flatMap((m) => m.packageImports));
  for (const name of [...imported].sort()) {
    if (known(name) || local.has(name) || name.startsWith("node:")) continue;
    const seen = packagesFile.packages.find((p) => p.name === name);
    const version = seen?.version ?? companionSpec(name, deps, packagesFile) ?? "latest";
    deps[name] = version;
    warn(
      "Recovered code imports " +
        name +
        ", which package.json lacked; added " +
        name +
        "@" +
        version +
        ". Confirm it.",
    );
  }
  pkg.dependencies = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Sources named `.../virtual:<name>` in the maps: a Vite plugin's generated module. Each is
 * written next to its recovered copy with a `.js` name, so the bundler can parse it, and is
 * aliased under its specifier. Only specifiers the code imports count.
 */
async function virtualModules(
  paths: WorkspacePaths,
  moves: Map<string, string>,
  written: Map<string, string | undefined>,
): Promise<{ name: string; file: string; content: string }[]> {
  const report = await readJson<{ maps: { sources: { raw: string; output: string | null }[] }[] }>(
    paths.sourcemapsReport,
  );
  const imported = new Set<string>();
  for (const text of written.values())
    for (const m of text?.matchAll(/["'](virtual:[^"'\n]+)["']/g) ?? [])
      imported.add(m[1] as string);
  const out = new Map<string, { name: string; file: string; content: string }>();
  for (const source of report?.maps.flatMap((m) => m.sources) ?? []) {
    const name = /(?:^|\/)(virtual:[^/]+)$/.exec(source.raw)?.[1];
    if (!name || !source.output || out.has(name) || !imported.has(name)) continue;
    const moved = moves.get(`recovered/sourcemap/${source.output}`.toLowerCase());
    if (!moved) continue;
    // Without an extension it was copied as a binary file, so its text is not in `written`.
    const content =
      written.get(moved) ??
      (await readFile(path.join(paths.root, moved), "utf8").catch(() => undefined));
    if (content === undefined) continue;
    const file = /\.[mc]?[jt]sx?$/i.test(moved) ? moved : `${moved}.js`;
    out.set(name, { name, file, content });
  }
  return [...out.values()];
}

async function writeAgentFiles(paths: WorkspacePaths, facts: AgentFacts): Promise<void> {
  await writeFileAtomic(paths.agents, agentsMd(facts));
  await writeFileAtomic(paths.claude, CLAUDE_MD);
  await writeFileAtomic(paths.prompt, promptMd(facts));
  // PROGRESS.md is the agent's own record once work starts; a rerun only writes it if missing.
  if (!existsSync(paths.progress)) await writeFileAtomic(paths.progress, progressMd(facts));
  await writeFileAtomic(
    path.join(paths.root, ".claude", "commands", "s2s.md"),
    slashCommandMd(facts),
  );
  await writeFileAtomic(path.join(paths.root, ".claude", "settings.json"), claudeSettings(facts));
}

const CONFIDENCE_WORD = (n: number) => (n >= 0.8 ? "high" : n >= 0.5 ? "medium" : "low");

async function gatherFacts(
  paths: WorkspacePaths,
  site: string,
  input: {
    thresholds: Thresholds;
    target: Target;
    fallbackFrom: string | null;
    pm: PackageManager;
    graph: ModulesFile;
    packagesFile: PackagesFile;
    reviewFile: ReviewFile;
    pages: PageInfo[];
    moves: Map<string, string>;
    notes: number;
  },
): Promise<AgentFacts> {
  const { graph, packagesFile } = input;
  const hints = await readJson<{
    language: { value: string; confidence: number } | null;
    styling: { value: string; confidence: number }[];
  }>(paths.projectHints);
  const styling = await readJson<Record<string, { detected?: boolean }>>(paths.stylingReport);
  const bundler = await readJson<{ bundler: string; version: string | null; confidence: string }>(
    paths.bundlerReport,
  );
  const manifest = await readManifest(paths.manifest);

  const stack: StackFact[] = [];
  const lib = { react: "react", vue: "vue", preact: "preact" }[
    input.target as "react" | "vue" | "preact"
  ];
  const libPkg = lib ? packagesFile.packages.find((p) => p.name === lib) : undefined;
  stack.push({
    label: "UI library",
    value: libPkg ? `${libPkg.name}${libPkg.version ? ` ${libPkg.version}` : ""}` : "none detected",
    confidence: libPkg ? `${libPkg.confidence} confidence` : "no evidence",
    source: "analysis/packages.json",
  });
  if (input.fallbackFrom)
    stack.push({
      label: "Framework",
      value: input.fallbackFrom,
      confidence: "detected",
      source: "analysis/packages.json",
    });
  stack.push(
    hints?.language
      ? {
          label: "Language",
          value: hints.language.value,
          confidence: `${CONFIDENCE_WORD(hints.language.confidence)} confidence`,
          source: "analysis/project-hints.json",
        }
      : {
          label: "Language",
          value: "unknown (no source maps); write TypeScript",
          confidence: "no evidence",
          source: "analysis/project-hints.json",
        },
  );
  const styleNames = [
    ...Object.entries(styling ?? {})
      .filter(([, v]) => v?.detected)
      .map(([k]) => k),
    ...(hints?.styling ?? []).map((s) => s.value),
  ];
  stack.push({
    label: "Styling",
    value: styleNames.length > 0 ? [...new Set(styleNames)].sort().join(", ") : "plain CSS",
    confidence: styleNames.length > 0 ? "detected" : "nothing else detected",
    source: "analysis/styling.json",
  });
  stack.push({
    label: "Original bundler",
    value: bundler
      ? `${bundler.bundler}${bundler.version ? ` ${bundler.version}` : ""}`
      : "unknown",
    confidence: bundler ? `${bundler.confidence} confidence` : "no evidence",
    source: "analysis/bundler.json",
  });
  stack.push({
    label: "Package manager",
    value: input.pm,
    confidence: packagesFile.packageManager?.source ?? "default",
    source: "analysis/packages.json",
  });

  const count = (origin: string) => graph.modules.filter((m) => m.origin === origin).length;
  const byId = new Map(graph.modules.map((m) => [m.id, m]));
  const groups: GroupFact[] = graph.groups
    .map((g) => ({
      id: g.id,
      bytes: g.bytes,
      modules: g.modules
        .map((id) => byId.get(id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined && m.kind !== "style")
        .map((m) => ({
          file: input.moves.get(m.file.toLowerCase()) ?? m.file,
          original: m.file,
          kind: m.kind,
          origin: m.origin,
        })),
    }))
    .filter((g) => g.modules.length > 0);
  const viewports = Array.isArray(manifest?.options.viewports)
    ? (manifest.options.viewports as string[])
    : ["desktop"];
  return {
    site,
    pages: input.pages.map((p) => ({ slug: p.slug, url: p.url })),
    viewports,
    target: input.target,
    fallbackFrom: input.fallbackFrom,
    stack,
    packageManager: input.pm,
    packages: packagesFile.packages
      .filter((p) => p.status === "dependency" || p.status === "devDependency")
      .map((p) => ({
        name: p.name,
        version: p.version,
        confidence: p.confidence,
        dev: p.status === "devDependency",
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    review: input.reviewFile.packages
      .map((p) => ({
        name: p.name,
        version: p.version,
        confidence: p.confidence,
        reason: p.reason,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    modules: {
      total: graph.modules.filter((m) => m.kind !== "style").length,
      exact: count("sourcemap-exact"),
      renamed: count("renamed"),
      unbundled: count("unbundled"),
      obfuscated: graph.modules.filter((m) => m.obfuscated).length,
      styles: graph.modules.filter((m) => m.kind === "style").length,
    },
    groups,
    notes: input.notes,
    thresholds: input.thresholds,
  };
}
