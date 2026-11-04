import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BodyStore } from "../capture/body-store.js";
import type { MapEntry } from "../capture/discovery/run.js";
import {
  type Manifest,
  readManifest,
  type StageState,
  writeManifest,
} from "../capture/manifest.js";
import { assetKind } from "../capture/recorder.js";
import { type RequestRecord, readRequestLog } from "../capture/request-log.js";
import { type WorkspacePaths, workspacePaths } from "../capture/workspace.js";
import { breathe, writeJsonAtomic } from "../fs-util.js";
import {
  addTotals,
  type Confidence,
  type CoverageTotals,
  coverageOf,
  emptyTotals,
  share,
} from "./coverage.js";
import { projectHints } from "./hints.js";
import { type InlinedFile, recoverInlined } from "./inlined.js";
import { inlineMap, type LogicalMap, loadMap, MapError, parseMapText } from "./load.js";
import { detectPackageManager, type PackageLayout, parseVendorPath } from "./packages.js";
import {
  findProjectRoot,
  normalizeSource,
  relativeTo,
  type SourceKind,
  vendorPath,
} from "./paths.js";
import { lineStartsOf, renameFromMap, type SkippedRename, shiftPosition } from "./rename.js";
import { escapeOf, inferFolderNames, placeSource, renameFolders, urlDirectory } from "./reroot.js";

export interface MapsOptions {
  /** Workspace folder written by `s2s capture`. */
  workspace: string;
  cwd?: string;
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: MapsProgress) => void;
}

export type MapsProgress =
  | { kind: "start"; workspace: string }
  | { kind: "skip"; workspace: string; reason: string }
  | { kind: "warning"; message: string }
  | { kind: "done"; status: StageState["status"]; summary: string };

export interface MapsResult {
  workspace: string;
  status: StageState["status"];
  skipped: boolean;
  stats: Record<string, number>;
  warnings: string[];
  summary: string;
  error?: string;
}

export class WorkspaceError extends Error {
  override name = "WorkspaceError";
}

interface Asset {
  hash: string;
  kind: "js" | "css";
  urls: string[];
}

interface LoadedMap {
  file: string;
  mapUrl: string | null;
  via: string;
  mapHash: string;
  /** Body hash of the generated file, when the capture holds it. */
  generatedHash: string | null;
  map: LogicalMap;
  sources: SourceInfo[];
}

interface SourceInfo {
  raw: string;
  kind: SourceKind | null;
  /** Normalized path, before the project root is cut. */
  normalized: string | null;
  absolute: boolean;
  /** Folders above the served root the raw path climbed (see `reroot.ts`). */
  escape: number;
  rejected?: string;
  content: string | null;
  /** Path under `recovered/sourcemap/`, once written. */
  output?: string;
}

interface Conflict {
  path: string;
  variants: { output: string; contentHash: string; from: string[] }[];
}

const sha256 = (text: string) => BodyStore.hash(Buffer.from(text));

/**
 * Stage 2: turn every source map in a capture into recovered original files, package evidence
 * and project hints, rename minified chunks whose maps carry names but no sources, and measure
 * how much first-party code is now explained. Reads only `raw/`; writes `recovered/` and
 * `analysis/`. Re-running on a complete stage is a no-op unless `force`.
 */
export async function maps(options: MapsOptions): Promise<MapsResult> {
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
      `Capture in ${root} is ${captureStatus}. Run "s2s capture" again before "s2s maps".`,
    );
  }
  if (manifest.stages.maps.status === "complete" && !options.force) {
    progress({ kind: "skip", workspace: root, reason: "maps is already complete" });
    return {
      workspace: root,
      status: "complete",
      skipped: true,
      stats: manifest.stages.maps.stats,
      warnings: manifest.stages.maps.warnings,
      summary: summaryLine(manifest.stages.maps.stats),
    };
  }

  const startedAt = new Date();
  manifest.stages.maps = {
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
  if (captureStatus === "partial") warn("Capture is partial; maps it missed cannot be recovered.");

  let status: StageState["status"] = "failed";
  let stats: Record<string, number> = {};
  let error: string | undefined;
  try {
    stats = await run(paths, warn, options.signal);
    status = "complete";
  } catch (caught) {
    if (options.signal?.aborted) {
      status = "partial";
      error = "Interrupted";
    } else {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  await finish(manifest);
  const summary = summaryLine(stats);
  progress({ kind: "done", status, summary });
  return {
    workspace: root,
    status,
    skipped: false,
    stats,
    warnings,
    summary,
    ...(error ? { error } : {}),
  };

  async function finish(m: Manifest): Promise<void> {
    m.stages.maps = {
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      stats,
      warnings,
      ...(error ? { error } : {}),
    };
    await writeManifest(paths.manifest, m);
  }
}

/** For example "38 maps, 214 sources recovered, 71% of first-party JS covered". */
export function summaryLine(stats: Record<string, number>): string {
  const pct = (n: number | undefined) => `${Math.round((n ?? 0) * 100)}%`;
  const count = (n: number | undefined, word: string) => `${n ?? 0} ${word}${n === 1 ? "" : "s"}`;
  const renamed = stats.coverageJsRenamed ? ` (${pct(stats.coverageJsRenamed)} more renamed)` : "";
  return `${count(stats.maps, "map")}, ${count(stats.sourcesRecovered, "source")} recovered, ${pct(stats.coverageJs)} of first-party JS covered${renamed}`;
}

async function run(
  paths: WorkspacePaths,
  warn: (message: string) => void,
  signal: AbortSignal | undefined,
): Promise<Record<string, number>> {
  // A rerun starts from scratch: nothing from an earlier run may linger.
  await Promise.all(
    [
      paths.recoveredSourcemap,
      paths.renamed,
      paths.sourcemapsReport,
      paths.sourcemapBoundaries,
      paths.projectHints,
      paths.sourcemapPackages,
    ].map((p) => rm(p, { recursive: true, force: true })),
  );

  const records = await readRequestLog(paths.requests).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [] as RequestRecord[];
    throw e;
  });
  const bodyOf = new Map<string, string>();
  const assets = new Map<string, Asset>();
  for (const record of records) {
    if (!record.bodyHash || record.status < 200 || record.status >= 300) continue;
    bodyOf.set(record.url, record.bodyHash);
    const kind = assetKind(record.mimeType, record.url);
    if (record.origin !== "first-party" || (kind !== "js" && kind !== "css")) continue;
    const asset = assets.get(record.bodyHash) ?? { hash: record.bodyHash, kind, urls: [] };
    if (!asset.urls.includes(record.url)) asset.urls.push(record.url);
    assets.set(record.bodyHash, asset);
  }
  const readBody = (hash: string) => readFile(path.join(paths.bodies, hash), "utf8");

  // 1. Collect maps: the capture's index, plus inline maps the capture did not save.
  let entries: MapEntry[] = [];
  try {
    entries = JSON.parse(await readFile(path.join(paths.maps, "index.json"), "utf8")) as MapEntry[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const mapped = new Set(entries.map((e) => e.file));
  const pending: { entry: Omit<MapEntry, "size">; text: () => Promise<string> }[] = entries.map(
    (entry) => ({
      entry,
      text: () =>
        readFile(path.join(paths.maps, `${entry.hash}.map`), "utf8").catch(() =>
          readBody(entry.hash),
        ),
    }),
  );
  for (const asset of assets.values()) {
    if (asset.urls.some((u) => mapped.has(u))) continue;
    const text = inlineMap(await readBody(asset.hash).catch(() => ""));
    if (!text) continue;
    const file = asset.urls[0] ?? "";
    pending.push({
      entry: { file, mapUrl: null, via: "inline", hash: sha256(text) },
      text: async () => text,
    });
  }
  pending.sort(
    (a, b) => a.entry.file.localeCompare(b.entry.file) || a.entry.hash.localeCompare(b.entry.hash),
  );

  const loaded: LoadedMap[] = [];
  const errors: { file: string; mapUrl: string | null; reason: string }[] = [];
  for (const { entry, text } of pending) {
    signal?.throwIfAborted();
    try {
      const map = loadMap(parseMapText(await text()));
      const mapDirectory = urlDirectory(entry.mapUrl ?? entry.file);
      const sources = map.sources.map((raw, i): SourceInfo => {
        const normalized = normalizeSource(raw);
        const content = map.sourcesContent[i] ?? null;
        return normalized.ok
          ? {
              raw,
              kind: normalized.kind,
              normalized: normalized.path,
              absolute: normalized.absolute,
              escape: escapeOf(normalized.climb, mapDirectory),
              content,
            }
          : {
              raw,
              kind: null,
              normalized: null,
              absolute: false,
              escape: 0,
              rejected: normalized.reason,
              content,
            };
      });
      loaded.push({
        file: entry.file,
        mapUrl: entry.mapUrl,
        via: entry.via,
        mapHash: entry.hash,
        generatedHash: bodyOf.get(entry.file) ?? null,
        map,
        sources,
      });
    } catch (e) {
      const reason =
        e instanceof MapError ? e.message : `could not read map (${(e as Error).message})`;
      errors.push({ file: entry.file, mapUrl: entry.mapUrl, reason });
    }
  }
  if (errors.length > 0)
    warn(`${errors.length} source map(s) were unusable; see analysis/sourcemaps.json.`);

  // 2. Normalize paths: keep how deep relative sources sat, then cut the project root shared by
  // first-party sources.
  const firstParty = loaded.flatMap((m) => m.sources).filter((s) => s.kind === "first-party");
  const relativeFirstParty = firstParty.filter((s) => !s.absolute && s.normalized);
  const deepest = Math.max(0, ...relativeFirstParty.map((s) => s.escape));
  if (relativeFirstParty.some((s) => s.escape < deepest)) {
    const placed = new Map<SourceInfo, string>();
    for (const s of relativeFirstParty)
      placed.set(s, placeSource(s.normalized as string, s.escape, deepest));
    const names = inferFolderNames(
      [...placed.entries()].map(([s, p]) => ({ path: p, content: s.content })),
    );
    for (const [s, p] of placed) s.normalized = renameFolders(p, names);
  }
  const projectRoot = findProjectRoot(
    firstParty.map((s) => ({ path: s.normalized ?? "", absolute: s.absolute })),
  );

  // 3. Write exact sources, deduped by path and content.
  const outDir = paths.recoveredSourcemap;
  const byPath = new Map<string, { contentHash: string; output: string; from: string[] }[]>();
  const rejected: { file: string; source: string; reason: string }[] = [];
  let written = 0;
  // Captured asset bodies by file name, and by file name without a bundler hash.
  const assetBodies = new Map<string, string | null>();
  for (const record of records) {
    if (!record.bodyHash || record.status < 200 || record.status >= 300) continue;
    const name = record.url
      .replace(/[?#].*$/, "")
      .split("/")
      .pop()
      ?.toLowerCase();
    if (!name || !ASSET_FILE.test(name)) continue;
    for (const key of new Set([name, withoutHash(name)])) {
      const seen = assetBodies.get(key);
      // Two different files under one name cannot tell which one a source was.
      assetBodies.set(key, seen === undefined || seen === record.bodyHash ? record.bodyHash : null);
    }
  }
  const capturedAsset = (file: string) => {
    const name = (file.split("/").pop() ?? "").toLowerCase();
    return assetBodies.get(name) ?? assetBodies.get(withoutHash(name)) ?? undefined;
  };
  const assetsFilled: string[] = [];
  const assetsMissing: string[] = [];
  for (const map of loaded) {
    for (const source of map.sources) {
      if (source.rejected) {
        rejected.push({ file: map.file, source: source.raw, reason: source.rejected });
        continue;
      }
      if (source.content === null || !source.normalized) continue;
      const base =
        source.kind === "virtual"
          ? `_virtual/${source.normalized}`
          : source.kind === "vendor"
            ? `_vendor/${vendorPath(source.normalized)}`
            : projectPath(projectRoot, source);
      // Vite's map holds an asset's intermediate module, not its bytes; the capture may have them.
      let bytes: Buffer | string = source.content;
      if (VITE_ASSET.test(source.content) && ASSET_FILE.test(base)) {
        const hash = capturedAsset(base);
        bytes = hash ? await readFile(path.join(paths.bodies, hash)) : Buffer.alloc(0);
        (hash ? assetsFilled : assetsMissing).push(base);
      }
      const contentHash = typeof bytes === "string" ? sha256(bytes) : BodyStore.hash(bytes);
      // Keyed case-insensitively: `App.js` and `app.js` are one file on Windows and macOS.
      const key = base.toLowerCase();
      const variants = byPath.get(key) ?? [];
      byPath.set(key, variants);
      const same = variants.find((v) => v.contentHash === contentHash);
      if (same) {
        if (!same.from.includes(map.file)) same.from.push(map.file);
        source.output = same.output;
        continue;
      }
      const output = variants.length === 0 ? base : withSuffix(base, contentHash.slice(0, 8));
      const file = path.resolve(outDir, output);
      if (!file.startsWith(outDir + path.sep)) {
        rejected.push({
          file: map.file,
          source: source.raw,
          reason: `path escapes the output folder: ${output}`,
        });
        continue;
      }
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes, { flag: "wx" });
      } catch (error) {
        // A path that clashes with a folder or file already written (`src/utils` and
        // `src/utils/index.js`), or that the file system refuses, skips this source only.
        const code = (error as NodeJS.ErrnoException).code ?? "error";
        rejected.push({
          file: map.file,
          source: source.raw,
          reason: `cannot write ${output} (${code})`,
        });
        continue;
      }
      variants.push({ contentHash, output, from: [map.file] });
      source.output = output;
      written++;
    }
  }
  const conflicts: Conflict[] = [...byPath.entries()]
    .filter(([, variants]) => variants.length > 1)
    .map(([key, variants]) => ({ path: variants[0]?.output ?? key, variants }));
  if (rejected.length > 0)
    warn(`${rejected.length} source path(s) rejected; see analysis/sourcemaps.json.`);
  if (assetsMissing.length > 0)
    warn(
      `${assetsMissing.length} asset source(s) held only Vite's placeholder and were not captured (${assetsFilled.length} were); they are written empty.`,
    );
  if (conflicts.length > 0)
    warn(
      `${conflicts.length} source path(s) had different content in different maps; kept every version.`,
    );

  // 3b. Data the bundle inlined without mappings (JSON imports, tree-shaken namespaces).
  const known = new Set([...byPath.values()].flat().map((v) => v.output.toLowerCase()));
  const inlined: InlinedFile[] = [];
  for (const map of loaded) {
    signal?.throwIfAborted();
    await breathe();
    if (!map.generatedHash) continue;
    const sources = map.sources
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => s.kind === "first-party" && s.output && s.content)
      .map(({ s, index }) => ({ index, output: s.output as string, content: s.content as string }));
    if (sources.length === 0) continue;
    const code = await readBody(map.generatedHash).catch(() => undefined);
    if (code === undefined) continue;
    for (const file of recoverInlined(map.map, code, sources, known)) {
      const target = path.resolve(outDir, file.path);
      if (!target.startsWith(outDir + path.sep)) continue;
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, { flag: "wx" });
      } catch {
        continue;
      }
      known.add(file.path.toLowerCase());
      inlined.push(file);
    }
  }
  if (inlined.length > 0)
    warn(
      `Rebuilt ${inlined.length} module(s) the bundle inlined without mappings (${inlined
        .map((f) => posixBase(f.path))
        .join(", ")}); see analysis/sourcemaps.json.`,
    );

  // 4. Package evidence from vendor paths.
  const packages = new Map<
    string,
    {
      name: string;
      version: string | null;
      parents: string[];
      files: string[];
      bytes: number;
      layout: PackageLayout;
    }
  >();
  const layouts: { layout: PackageLayout; path: string }[] = [];
  for (const map of loaded) {
    for (const source of map.sources) {
      if (source.kind !== "vendor" || !source.normalized) continue;
      const pkg = parseVendorPath(source.normalized);
      if (!pkg) continue;
      layouts.push({ layout: pkg.layout, path: source.normalized });
      const key = `${pkg.name}@${pkg.version ?? ""}`;
      const entry = packages.get(key) ?? {
        name: pkg.name,
        version: pkg.version,
        parents: [],
        files: [],
        bytes: 0,
        layout: pkg.layout,
      };
      packages.set(key, entry);
      if (pkg.parent && !entry.parents.includes(pkg.parent)) entry.parents.push(pkg.parent);
      if (!entry.files.includes(source.normalized)) {
        entry.files.push(source.normalized);
        entry.bytes += source.content ? Buffer.byteLength(source.content) : 0;
      }
    }
  }
  const packageManager = detectPackageManager(layouts);
  await writeJsonAtomic(paths.sourcemapPackages, {
    packageManager: packageManager ?? null,
    packages: [...packages.values()]
      .sort(
        (a, b) => a.name.localeCompare(b.name) || (a.version ?? "").localeCompare(b.version ?? ""),
      )
      .map((p) => ({
        name: p.name,
        version: p.version,
        parents: p.parents,
        layout: p.layout,
        files: p.files.length,
        totalBytes: p.bytes,
        source: "sourcemap",
        paths: p.files.slice(0, 20),
      })),
  });

  // 5. Partial maps: rename the chunk from the map's names and record file boundaries.
  const renamedChunks: {
    file: string;
    bodyHash: string;
    output: string | null;
    renamed: number;
    skipped: SkippedRename[];
    error?: string;
  }[] = [];
  const boundaries: unknown[] = [];
  const renamedBodies = new Set<string>();
  const renamedDone = new Set<string>();
  for (const map of loaded) {
    signal?.throwIfAborted();
    const hash = map.generatedHash;
    if (!hash || renamedDone.has(hash)) continue;
    const kind = assets.get(hash)?.kind ?? assetKind(null, map.file);
    if (kind !== "js" || !map.sources.some((s) => s.kind === "first-party" && s.content === null))
      continue;
    renamedDone.add(hash);
    const code = await readBody(hash).catch(() => undefined);
    if (code === undefined) continue;
    let output: string | null = null;
    let renamedCode = code;
    let edits: ReturnType<typeof renameFromMap>["edits"] = [];
    try {
      const result = renameFromMap(code, map.map);
      edits = result.edits;
      if (result.renamed.length > 0) {
        await mkdir(paths.renamed, { recursive: true });
        output = `recovered/renamed/${hash}.js`;
        await writeFile(path.join(paths.renamed, `${hash}.js`), result.code);
        renamedBodies.add(hash);
        renamedCode = result.code;
      }
      renamedChunks.push({
        file: map.file,
        bodyHash: hash,
        output,
        renamed: result.renamed.length,
        skipped: result.skipped,
      });
    } catch (e) {
      renamedChunks.push({
        file: map.file,
        bodyHash: hash,
        output: null,
        renamed: 0,
        skipped: [],
        error: (e as Error).message,
      });
      warn(`Could not parse ${map.file} for renaming: ${(e as Error).message.split("\n")[0]}`);
    }
    const lineStarts = lineStartsOf(code);
    const ranges = rangesOf(map, code).map((range) => ({
      ...range,
      ...(output
        ? {
            renamedStart: shiftPosition(lineStarts, edits, range.start.line, range.start.column),
            renamedEnd: shiftPosition(lineStarts, edits, range.end.line, range.end.column),
          }
        : {}),
    }));
    boundaries.push({
      file: map.file,
      bodyHash: hash,
      renamed: output,
      lines: lineStartsOf(renamedCode).length,
      ranges,
    });
  }
  await writeJsonAtomic(paths.sourcemapBoundaries, boundaries);
  const skippedRenames = renamedChunks.reduce((n, c) => n + c.skipped.length, 0);
  if (skippedRenames > 0)
    warn(`Skipped ${skippedRenames} rename(s) that were unsafe; see analysis/sourcemaps.json.`);

  // 7. Coverage of every first-party JS and CSS byte.
  const mapForBody = new Map<string, LoadedMap>();
  for (const map of loaded) if (map.generatedHash) mapForBody.set(map.generatedHash, map);
  const totals = { js: emptyTotals(), css: emptyTotals(), all: emptyTotals() };
  const files: ({
    url: string;
    kind: "js" | "css";
    bodyHash: string;
    map: boolean;
  } & CoverageTotals)[] = [];
  for (const asset of [...assets.values()].sort((a, b) =>
    (a.urls[0] ?? "").localeCompare(b.urls[0] ?? ""),
  )) {
    const code = await readBody(asset.hash).catch(() => undefined);
    if (code === undefined) continue;
    const map = mapForBody.get(asset.hash);
    const labelOf = (index: number): Confidence => {
      const source = map?.sources[index];
      if (!source) return "none";
      if (source.output) return "exact";
      return renamedBodies.has(asset.hash) && !source.rejected ? "renamed" : "none";
    };
    const result = coverageOf(code, map?.map, labelOf);
    files.push({
      url: asset.urls[0] ?? "",
      kind: asset.kind,
      bodyHash: asset.hash,
      map: Boolean(map),
      ...result,
    });
    addTotals(totals[asset.kind], result);
    addTotals(totals.all, result);
  }

  // 6. Project hints from first-party sources.
  const hintSources = loaded
    .flatMap((m) => m.sources)
    .filter((s) => s.kind === "first-party" && s.normalized)
    .map((s) => ({ path: projectPath(projectRoot, s), content: s.content }));
  const uniqueHints = [...new Map(hintSources.map((s) => [s.path, s])).values()];
  const hints = projectHints(
    uniqueHints,
    [...packages.values()].map((p) => p.name),
    packageManager,
  );
  await writeJsonAtomic(paths.projectHints, hints);

  const sourcesTotal = loaded.reduce((n, m) => n + m.sources.length, 0);
  await writeJsonAtomic(paths.sourcemapsReport, {
    projectRoot,
    maps: loaded.map((m) => ({
      file: m.file,
      mapUrl: m.mapUrl,
      via: m.via,
      mapHash: m.mapHash,
      generatedHash: m.generatedHash,
      sources: m.sources.map((s) => ({
        raw: s.raw,
        kind: s.kind,
        output: s.output ?? null,
        confidence: s.output
          ? "exact"
          : s.rejected
            ? "none"
            : renamedBodies.has(m.generatedHash ?? "")
              ? "renamed"
              : "none",
        ...(s.rejected ? { rejected: s.rejected } : {}),
      })),
    })),
    errors,
    rejected,
    conflicts,
    inlined: inlined.map(({ content: _, ...rest }) => rest),
    assetPlaceholders: { filled: assetsFilled, missing: assetsMissing },
    renamed: renamedChunks,
    coverage: {
      overall: { ...totals.all, share: share(totals.all) },
      js: { ...totals.js, share: share(totals.js) },
      css: { ...totals.css, share: share(totals.css) },
      files: files.map((f) => ({ ...f, share: share(f) })),
    },
  });

  return {
    maps: loaded.length,
    mapErrors: errors.length,
    sources: sourcesTotal,
    sourcesRecovered: written,
    firstPartyRecovered: [...byPath.values()]
      .flat()
      .filter((v) => !/^_(?:virtual|vendor)\//.test(v.output)).length,
    rejected: rejected.length,
    conflicts: conflicts.length,
    inlinedRecovered: inlined.length,
    assetsFromCapture: assetsFilled.length,
    assetsMissing: assetsMissing.length,
    packages: packages.size,
    renamedChunks: renamedBodies.size,
    renamedBindings: renamedChunks.reduce((n, c) => n + c.renamed, 0),
    skippedRenames,
    coverage: share(totals.all),
    coverageJs: share(totals.js),
    coverageJsRenamed:
      totals.js.total === 0
        ? 0
        : Math.round((totals.js.renamed / totals.js.total) * 10_000) / 10_000,
    coverageCss: share(totals.css),
  };
}

function projectPath(
  root: { absolute: string; relative: string },
  source: { normalized: string | null; absolute: boolean },
): string {
  return relativeTo(source.absolute ? root.absolute : root.relative, source.normalized ?? "");
}

/** Vite's stand-in module for an imported asset, which its maps keep as the asset's content. */
const VITE_ASSET = /^\s*export default\s*["']__VITE_ASSET__[\w$]+__["'];?\s*$/;
const ASSET_FILE =
  /\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|ico|bmp|mp3|mp4|webm|ogg|wav|wasm)$/i;
/** `font-a88b72a2.woff2` gives `font.woff2`: the name before the bundler appended its hash. */
const withoutHash = (name: string) => name.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/i, "$1");

const posixBase = (file: string) => file.slice(file.lastIndexOf("/") + 1);

function withSuffix(file: string, suffix: string): string {
  const slash = file.lastIndexOf("/");
  const dot = file.lastIndexOf(".");
  // `.module.css` keeps both parts of its extension.
  const module = file.lastIndexOf(".module.");
  const at = module > slash ? module : dot > slash ? dot : file.length;
  return `${file.slice(0, at)}.${suffix}${file.slice(at)}`;
}

/** Runs of consecutive mappings that point at the same source, as generated-position ranges. */
function rangesOf(map: LoadedMap, code: string) {
  const lines = code.split("\n");
  const ranges: {
    source: string;
    start: { line: number; column: number };
    end: { line: number; column: number };
  }[] = [];
  let open: (typeof ranges)[number] | undefined;
  let openIndex = -1;
  const label = (index: number) => {
    const s = map.sources[index];
    return s?.output ?? s?.normalized ?? s?.raw ?? String(index);
  };
  for (const [line, segments] of map.map.mappings.entries()) {
    for (const segment of segments) {
      const index = segment.length === 1 ? -1 : segment[1];
      const at = { line: line + 1, column: segment[0] };
      if (index === openIndex && open) continue;
      if (open) open.end = at;
      open = undefined;
      openIndex = index;
      if (index >= 0) {
        open = { source: label(index), start: at, end: at };
        ranges.push(open);
      }
    }
  }
  if (open) {
    const lastLine = lines.length;
    open.end = { line: lastLine, column: lines[lastLine - 1]?.length ?? 0 };
  }
  return ranges;
}
