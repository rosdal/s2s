import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import postcss, { type Root } from "postcss";
import { readManifest, type StageState, writeManifest } from "../capture/manifest.js";
import { type WorkspacePaths, workspacePaths } from "../capture/workspace.js";
import { loadContext } from "../detect/context.js";
import { writeFileAtomic, writeJsonAtomic } from "../fs-util.js";
import { WorkspaceError } from "../maps/run.js";
import { defaultAdapter, type LibraryAdapter } from "./adapter.js";
import { assetIndex, planAssets, relativeFile, rewriteCssUrls, rewriteJsAssets } from "./assets.js";
import { applyEdits, MODULE_PREFIX, parses, quote } from "./ast.js";
import { unpackBrowserify } from "./browserify.js";
import { type BundlerReport, bundlerPackage, summarizeBundlers } from "./bundler.js";
import { type ClassMap, classesOf, detectStyling, extractModules, findClassMaps } from "./css.js";
import { buildGraph, type GraphInput, type ModulesFile } from "./graph.js";
import { chunkName, loadInputs } from "./inputs.js";
import { fixDefaultImports } from "./interop.js";
import { PASSES, type PassName, type PassResult, transform } from "./passes.js";
import { type ChunkTable, splitScope } from "./split.js";
import type { ChunkInput, Draft, ImportLine, UnpackContext } from "./types.js";
import { vendorNamespaceLines } from "./vendor.js";
import { unpackWebpack } from "./webpack.js";

export interface UnbundleOptions {
  /** Workspace folder written by `s2s capture`. */
  workspace: string;
  cwd?: string;
  force?: boolean;
  /** Transform passes to leave out. */
  skip?: PassName[];
  /** Keep vendor code instead of replacing it with package imports. */
  keepVendor?: boolean;
  /** Keep scope-hoisted chunks whole instead of guessing module boundaries. */
  noHeuristicSplit?: boolean;
  /** Largest agent work group, in KB of code. Defaults to 40. */
  maxGroupKb?: number;
  /** Library adapter; tests pass one that records calls. */
  adapter?: LibraryAdapter;
  signal?: AbortSignal;
  onProgress?: (event: UnbundleProgress) => void;
}

export type UnbundleProgress =
  | { kind: "start"; workspace: string }
  | { kind: "skip"; workspace: string; reason: string }
  | { kind: "warning"; message: string }
  | { kind: "module"; done: number; total: number }
  | { kind: "done"; status: StageState["status"]; summary: string };

export interface UnbundleResult {
  workspace: string;
  status: StageState["status"];
  skipped: boolean;
  stats: Record<string, number>;
  warnings: string[];
  summary: string;
  error?: string;
}

export const DEFAULT_MAX_GROUP_KB = 40;
/** Heuristic parts smaller than this merge into a neighbour. */
const MIN_PART_BYTES = 1024;

/**
 * Stage 4: split the site's own JS into modules, drop vendor code for package imports, undo
 * minification and transpilation, restore JSX and ES module syntax, format it all, sort out CSS
 * and assets, and write the module graph Stage 5 plans from. Every step is deterministic; a
 * rerun of a complete stage is a no-op unless `force` or an option that changes the output.
 */
export async function unbundle(options: UnbundleOptions): Promise<UnbundleResult> {
  const root = path.resolve(options.cwd ?? process.cwd(), options.workspace);
  const paths = workspacePaths(root);
  const progress = options.onProgress ?? (() => {});
  const manifest = await readManifest(paths.manifest).catch((error: Error) => {
    throw new WorkspaceError(`${paths.manifest} is unreadable: ${error.message.split("\n")[0]}`);
  });
  if (!manifest)
    throw new WorkspaceError(`No workspace at ${root}. Run "s2s capture <url>" first.`);
  const captureStatus = manifest.stages.capture.status;
  if (captureStatus === "pending" || captureStatus === "failed") {
    throw new WorkspaceError(
      `Capture in ${root} is ${captureStatus}. Run "s2s capture" again before "s2s unbundle".`,
    );
  }
  const settings = {
    skip: [...new Set(options.skip ?? [])]
      .filter((p) => (PASSES as readonly string[]).includes(p))
      .sort()
      .join(","),
    keepVendor: Boolean(options.keepVendor),
    heuristicSplit: !options.noHeuristicSplit,
    maxGroupKb: options.maxGroupKb ?? DEFAULT_MAX_GROUP_KB,
  };
  const previous = manifest.stages.unbundle.details ?? {};
  const changed = Object.entries(settings).some(
    ([k, v]) => (previous[k] ?? defaults[k as keyof typeof defaults]) !== v,
  );
  if (manifest.stages.unbundle.status === "complete" && !options.force && !changed) {
    progress({ kind: "skip", workspace: root, reason: "unbundle is already complete" });
    const stats = manifest.stages.unbundle.stats;
    return {
      workspace: root,
      status: "complete",
      skipped: true,
      stats,
      warnings: manifest.stages.unbundle.warnings,
      summary: summaryLine(stats, String(manifest.stages.unbundle.details?.bundler ?? "unknown")),
    };
  }

  const startedAt = new Date();
  manifest.stages.unbundle = {
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
  if (captureStatus === "partial")
    warn("Capture is partial; modules it missed cannot be unbundled.");
  if (manifest.stages.detect.status !== "complete")
    warn('Stage 3 has not run, so vendor code cannot be told apart. Run "s2s detect" first.');

  let status: StageState["status"] = "failed";
  let outcome: Outcome = { stats: {}, bundler: "unknown" };
  let error: string | undefined;
  try {
    outcome = await run(paths, options, settings, warn, progress);
    status = "complete";
  } catch (caught) {
    if (options.signal?.aborted) {
      status = "partial";
      error = "Interrupted";
    } else {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  manifest.stages.unbundle = {
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    stats: outcome.stats,
    warnings,
    details: { ...settings, bundler: outcome.bundler },
    ...(error ? { error } : {}),
  };
  await writeManifest(paths.manifest, manifest);
  const summary = summaryLine(outcome.stats, outcome.bundler);
  progress({ kind: "done", status, summary });
  return {
    workspace: root,
    status,
    skipped: false,
    stats: outcome.stats,
    warnings,
    summary,
    ...(error ? { error } : {}),
  };
}

const defaults = {
  skip: "",
  keepVendor: false,
  heuristicSplit: true,
  maxGroupKb: DEFAULT_MAX_GROUP_KB,
};

/** For example "webpack 5 · 312 modules · 64% vendor dropped · 41 groups". */
export function summaryLine(stats: Record<string, number>, bundler: string): string {
  const n = (k: string) => stats[k] ?? 0;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const pct =
    n("totalBytes") === 0 ? 0 : Math.round((n("vendorDroppedBytes") / n("totalBytes")) * 100);
  const version = stats.bundlerVersion ? ` ${stats.bundlerVersion}` : "";
  // Exact sources from maps are modules too; Stage 5 counts both, so the total has to match it.
  const total = n("modules") + n("exactModules");
  const split =
    n("exactModules") > 0 ? ` (${n("exactModules")} from source maps, ${n("modules")} split)` : "";
  return `${bundler}${version} · ${plural(total, "module")}${split} · ${pct}% vendor dropped · ${plural(n("groups"), "group")}`;
}

interface Outcome {
  stats: Record<string, number>;
  bundler: string;
}

interface Settings {
  skip: string;
  keepVendor: boolean;
  heuristicSplit: boolean;
  maxGroupKb: number;
}

interface Placed {
  draft: Draft;
  /** Workspace-relative path. */
  file: string;
  id: string;
}

async function run(
  paths: WorkspacePaths,
  options: UnbundleOptions,
  settings: Settings,
  warn: (message: string) => void,
  progress: (event: UnbundleProgress) => void,
): Promise<Outcome> {
  const signal = options.signal;
  const adapter = options.adapter ?? defaultAdapter;
  await Promise.all(
    [
      paths.unbundled,
      paths.assets,
      paths.bundlerReport,
      paths.stylingReport,
      paths.modules,
      paths.unbundleReport,
    ].map((p) => rm(p, { recursive: true, force: true })),
  );
  const ctx = await loadContext(paths);
  const inputs = await loadInputs(ctx);
  const unpackCtx: UnpackContext = {
    keepVendor: settings.keepVendor,
    heuristicSplit: settings.heuristicSplit,
    minPartBytes: MIN_PART_BYTES,
    warn,
  };

  // 1. Bundler.
  const bundler: BundlerReport = summarizeBundlers(
    inputs.chunks.map((c) => ({ url: c.url, size: c.code.length, result: c.bundler })),
  );
  await writeJsonAtomic(paths.bundlerReport, bundler);
  await addBundlerDevDependency(paths, bundler, warn);
  for (const name of bundler.others)
    warn(`Some chunks look like ${name} output; each chunk is split by its own bundler.`);
  if (bundler.bundler === "parcel" || bundler.bundler === "turbopack")
    warn(`${bundler.bundler} output is kept as whole chunks; full unpacking is not supported yet.`);

  // 2. Unpack every chunk by its own bundler.
  signal?.throwIfAborted();
  const drafts: Draft[] = [];
  const tables = new Map<string, ChunkTable>();
  const webpack = inputs.chunks.filter((c) => c.bundler.bundler === "webpack");
  const handled = new Set<ChunkInput>();
  if (webpack.length > 0) {
    try {
      const result = unpackWebpack(webpack, unpackCtx);
      drafts.push(...result.drafts);
      for (const [url, table] of result.tables) tables.set(url, table);
      // A chunk with a module map (even one whose modules another chunk already defined) or the
      // runtime is done; anything else falls through to the generic split below.
      for (const chunk of webpack) if (result.handled.has(chunk.url)) handled.add(chunk);
    } catch (error) {
      warn(
        `webpack chunks could not be unpacked (${(error as Error).message.split("\n")[0]}); kept whole`,
      );
    }
  }
  for (const chunk of inputs.chunks) {
    if (handled.has(chunk)) continue;
    signal?.throwIfAborted();
    const mode = chunk.bundler.bundler;
    try {
      if (mode === "browserify") {
        const result = unpackBrowserify(chunk, unpackCtx);
        if (result.drafts.length > 0) {
          drafts.push(...result.drafts);
          tables.set(chunk.url, result.table);
          continue;
        }
      }
      // A chunk with no signature of its own (a tiny shared chunk) follows the site's bundler.
      const family = mode === "unknown" ? bundler.bundler : mode;
      const split = splitScope(
        chunk,
        unpackCtx,
        family === "esbuild"
          ? "esbuild"
          : family === "vite" || family === "rollup"
            ? "rollup"
            : "whole",
      );
      drafts.push(...split.drafts);
      tables.set(chunk.url, split.table);
    } catch (error) {
      warn(
        `${chunk.url}: could not be split (${(error as Error).message.split("\n")[0]}); kept whole`,
      );
      const whole = wholeChunk(chunk);
      drafts.push(whole);
      tables.set(chunk.url, { entry: whole.key, exports: new Map() });
    }
  }
  const kept = drafts.filter((d) => !d.vendor);
  const byKey = new Map(drafts.map((d) => [d.key, d]));

  // 3. Place files: `<chunk-name>/<module-id>.js`.
  const taken = new Set<string>();
  const placed: Placed[] = kept.map((draft) => {
    const stem = draft.id.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[.]+/, "") || "module";
    let file = `recovered/unbundled/${draft.chunk.name}/${stem}.js`;
    for (let n = 2; taken.has(file.toLowerCase()); n++)
      file = `recovered/unbundled/${draft.chunk.name}/${stem}-${n}.js`;
    taken.add(file.toLowerCase());
    return { draft, file, id: file.slice("recovered/unbundled/".length, -3) };
  });
  const fileOf = new Map(placed.map((p) => [p.draft.key, p.file]));

  // 4. CSS: format each stylesheet, restore CSS Modules, point url() at copied assets.
  const assets = planAssets(ctx.records);
  const findAsset = assetIndex(assets);
  const cssAssets = ctx.assets.filter((a) => a.kind === "css" && a.origin === "first-party");
  const sheets: { url: string; root: Root | null; text: string; file: string; pages: string[] }[] =
    [];
  const cssNames = new Set<string>(["styles"]);
  for (const asset of cssAssets) {
    const text = (await ctx.text(asset.hash)) ?? "";
    const url = asset.urls[0] ?? "";
    const name = chunkName(url.replace(/\.css(?=$|[?#])/, ".js"), cssNames);
    let root: Root | null = null;
    try {
      root = postcss.parse(text, { from: undefined });
    } catch (error) {
      warn(`${url}: CSS does not parse (${(error as Error).message.split("\n")[0]}); copied as is`);
    }
    sheets.push({
      url,
      root,
      text,
      file: `recovered/unbundled/styles/${name}.css`,
      pages: asset.pages,
    });
  }
  const cssClasses = new Set<string>();
  for (const s of sheets) for (const c of classesOf(s.text)) cssClasses.add(c);
  const classMaps: ClassMap[] = [];
  for (const p of placed) classMaps.push(...findClassMaps(p.draft, cssClasses));
  const parsed = sheets.filter((s) => s.root !== null);
  const moduleCss = extractModules(
    parsed.map((s) => s.root as Root),
    classMaps,
  );
  const moduleFiles = new Map<ClassMap, string>();
  for (const map of classMaps) {
    let file = `recovered/unbundled/styles/${map.name}.module.css`;
    for (
      let n = 2;
      [...moduleFiles.values()].includes(file) || sheets.some((s) => s.file === file);
      n++
    )
      file = `recovered/unbundled/styles/${map.name}-${n}.module.css`;
    moduleFiles.set(map, file);
  }
  // Class map objects become `styles` from the CSS Module.
  for (const p of placed) {
    const maps = classMaps.filter((m) => m.draft === p.draft).sort((a, b) => b.start - a.start);
    if (maps.length === 0) continue;
    let code = p.draft.code;
    for (const [i, map] of maps.entries()) {
      const local =
        maps.length === 1
          ? freshLocal(code, "styles")
          : freshLocal(code, `styles${maps.length - i}`);
      code = applyEdits(code, [{ start: map.start, end: map.end, text: local }]);
      p.draft.head.push({
        target: { kind: "file", path: moduleFiles.get(map) as string },
        names: [],
        defaultName: local,
      });
    }
    p.draft.code = code;
  }
  let cssUrlRewrites = 0;
  const cssOut: {
    file: string;
    text: string;
    pages: string[];
    url: string;
    kind: "sheet" | "module";
  }[] = [];
  for (const sheet of sheets) {
    if (sheet.root) cssUrlRewrites += rewriteCssUrls(sheet.root, sheet.url, sheet.file, findAsset);
    cssOut.push({
      file: sheet.file,
      text: sheet.root ? sheet.root.toString() : sheet.text,
      pages: sheet.pages,
      url: sheet.url,
      kind: "sheet",
    });
  }
  for (const [map, extracted] of moduleCss) {
    const root = postcss.parse(extracted.css);
    // url() resolves against the stylesheet the rules came from.
    const url = parsed[extracted.sheet]?.url ?? "";
    const file = moduleFiles.get(map) as string;
    cssUrlRewrites += rewriteCssUrls(root, url, file, findAsset);
    cssOut.push({
      file,
      text: root.toString(),
      pages: map.draft.chunk.pages,
      url,
      kind: "module",
    });
  }
  let jsAssetRewrites = 0;
  for (const p of placed) jsAssetRewrites += rewriteJsAssets(p.draft, findAsset);

  // 5. Resolve module references, then run the transform passes.
  const skip = new Set(settings.skip ? (settings.skip.split(",") as PassName[]) : []);
  const reportModules: {
    id: string;
    file: string;
    chunk: string;
    boundary: string;
    range: { start: number; end: number };
    vendorBytesRemoved: number;
    passes: PassResult[];
    errors: string[];
  }[] = [];
  const graphInputs: GraphInput[] = [];
  let done = 0;
  const outputs: {
    p: Placed;
    file: string;
    code: string;
    result: Awaited<ReturnType<typeof transform>>;
  }[] = [];
  for (const p of placed) {
    signal?.throwIfAborted();
    const resolved = renderModule(p, byKey, fileOf, tables, warn);
    const result = await transform(resolved, adapter, skip);
    let code = result.code;
    if (!parses(code)) {
      warn(`${p.file}: does not parse after its transforms; written as unpacked`);
      code = resolved;
    }
    outputs.push({ p, file: p.file, code, result });
    progress({ kind: "module", done: ++done, total: placed.length });
  }
  const interopFixes = fixDefaultImports(outputs);
  for (const { p, code, result } of outputs) {
    await writeFileAtomic(path.join(paths.root, p.file), code);
    const range = {
      start: p.draft.chunk.bodyOffset(p.draft.start),
      end: p.draft.chunk.bodyOffset(p.draft.end),
    };
    reportModules.push({
      id: p.id,
      file: p.file,
      chunk: p.draft.chunk.url,
      boundary: p.draft.boundary,
      range,
      vendorBytesRemoved: p.draft.vendorBytesRemoved,
      passes: result.passes,
      errors: result.passes.filter((r) => r.error).map((r) => `${r.pass}: ${r.error}`),
    });
    graphInputs.push({
      id: p.id,
      file: p.file,
      origin: p.draft.chunk.origin,
      boundary: p.draft.boundary,
      chunk: p.draft.chunk.name,
      code,
      pages: p.draft.chunk.pages,
      entry: p.draft.entry,
      obfuscated: result.obfuscated,
      source: p.draft.source,
      range,
    });
  }
  for (const css of cssOut) {
    let text = css.text;
    if (!skip.has("prettier")) {
      try {
        text = await adapter.format(text, "css");
      } catch (error) {
        warn(`${css.file}: could not be formatted (${(error as Error).message.split("\n")[0]})`);
      }
    }
    await writeFileAtomic(path.join(paths.root, css.file), text);
    graphInputs.push({
      id: css.file.slice("recovered/unbundled/".length),
      file: css.file,
      origin: "unbundled",
      boundary: "real",
      chunk: "styles",
      code: text,
      pages: css.pages,
      entry: false,
      obfuscated: false,
      source: null,
      range: null,
    });
  }

  // 6. Assets.
  for (const asset of assets) {
    const target = path.join(paths.root, asset.file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(paths.bodies, asset.bodyHash), target);
  }

  // 7. Exact sources from Stage 2 join the graph as they are.
  for (const source of inputs.exact) {
    const code = await readFile(path.join(paths.root, source.file), "utf8").catch(() => "");
    graphInputs.push({
      id: source.file.slice("recovered/sourcemap/".length),
      file: source.file,
      origin: "sourcemap-exact",
      boundary: "real",
      chunk: chunkName(source.chunkUrl, new Set()),
      code,
      pages: source.pages,
      entry: false,
      obfuscated: false,
      source: source.file.slice("recovered/sourcemap/".length),
      range: null,
    });
  }
  const graph: ModulesFile = buildGraph(graphInputs, settings.maxGroupKb * 1024);
  await writeJsonAtomic(paths.modules, graph);

  // 8. Styling, report, totals.
  const dom: string[] = [];
  for (const page of await readdir(paths.pages).catch(() => [] as string[])) {
    const html = await readFile(path.join(paths.pages, page, "dom.html"), "utf8").catch(() => "");
    if (html) dom.push(html);
  }
  await writeJsonAtomic(
    paths.stylingReport,
    detectStyling({ css: sheets.map((s) => s.text), dom, classMaps: classMaps.length }),
  );

  const totalBytes = inputs.chunks.reduce((n, c) => n + Buffer.byteLength(c.code), 0);
  const spanBytes = (d: Draft) =>
    (d.spans ?? [[d.start, d.end]]).reduce(
      (n, [s, e]) => n + d.chunk.bodyOffset(e) - d.chunk.bodyOffset(s),
      0,
    );
  const vendorModuleBytes = drafts.filter((d) => d.vendor).reduce((n, d) => n + spanBytes(d), 0);
  const vendorInside = kept.reduce((n, d) => n + d.vendorBytesRemoved, 0);
  const vendorDroppedBytes = vendorModuleBytes + vendorInside;
  const keptBytes = kept.reduce((n, d) => n + spanBytes(d), 0) - vendorInside;
  const passTotals = Object.fromEntries(
    PASSES.map((pass) => {
      const runs = reportModules.map((m) => m.passes.find((r) => r.pass === pass));
      return [
        pass,
        {
          applied: runs.filter((r) => r?.status === "applied").length,
          changes: runs.reduce((n, r) => n + (r?.changes ?? 0), 0),
          errors: runs.filter((r) => r?.status === "error").length,
        },
      ];
    }),
  );
  await writeJsonAtomic(paths.unbundleReport, {
    bundler: { name: bundler.bundler, version: bundler.version },
    totals: {
      chunks: inputs.chunks.length,
      exactChunks: inputs.exactChunks.length,
      modules: placed.length,
      exactSources: inputs.exact.length,
      totalBytes,
      keptBytes,
      vendorDroppedBytes,
      runtimeBytes: Math.max(0, totalBytes - keptBytes - vendorDroppedBytes),
      vendorModules: drafts.filter((d) => d.vendor).length,
    },
    passes: passTotals,
    vendorModules: drafts
      .filter((d) => d.vendor)
      .map((d) => ({
        chunk: d.chunk.url,
        id: d.id,
        package: d.vendor?.package,
        bytes: spanBytes(d),
      })),
    modules: reportModules,
    // Where each stylesheet and exact source came from, so Stage 5 can wire them to the page.
    styles: cssOut.map((c) => ({ file: c.file, url: c.url, kind: c.kind, pages: c.pages })),
    exactSources: inputs.exact.map((e) => ({ file: e.file, chunk: e.chunkUrl, pages: e.pages })),
  });

  const errors = reportModules.reduce((n, m) => n + m.errors.length, 0);
  if (errors > 0) warn(`${errors} transform error(s); see analysis/unbundle-report.json.`);
  return {
    bundler: bundler.bundler,
    stats: {
      chunks: inputs.chunks.length,
      modules: graph.modules.filter(
        (m) => m.origin !== "sourcemap-exact" && !m.file.endsWith(".css"),
      ).length,
      exactModules: inputs.exact.length,
      styles: cssOut.length,
      cssModules: classMaps.length,
      assets: assets.length,
      assetRewrites: cssUrlRewrites + jsAssetRewrites,
      interopFixes,
      groups: graph.groups.length,
      totalBytes,
      keptBytes,
      vendorDroppedBytes,
      transformErrors: errors,
      obfuscated: graphInputs.filter((m) => m.obfuscated).length,
      ...(bundler.version && /^\d+$/.test(bundler.version)
        ? { bundlerVersion: Number(bundler.version) }
        : {}),
    },
  };
}

function wholeChunk(chunk: ChunkInput): Draft {
  return {
    key: `${chunk.name}/index`,
    id: "index",
    chunk,
    start: 0,
    end: chunk.code.length,
    boundary: "real",
    code: chunk.code,
    head: [],
    entry: true,
    source: null,
    notes: [],
    vendor: null,
    vendorBytesRemoved: 0,
  };
}

function freshLocal(code: string, wanted: string): string {
  let name = wanted;
  while (new RegExp(`\\b${name}\\b`).test(code)) name = `_${name}`;
  return name;
}

/** The module's text with its import lines and every `s2s-module:`/`s2s-chunk:` reference resolved. */
function renderModule(
  p: Placed,
  byKey: Map<string, Draft>,
  fileOf: Map<string, string>,
  tables: Map<string, ChunkTable>,
  warn: (m: string) => void,
): string {
  const notes = [...p.draft.notes];
  const toSpec = (key: string | null | undefined): string | undefined => {
    if (!key) return undefined;
    const target = byKey.get(key);
    if (target?.vendor) return target.vendor.package;
    const file = fileOf.get(key);
    return file ? relativeFile(p.file, file) : undefined;
  };
  const missing = (what: string) => {
    notes.push(`${what} was not captured, so this import cannot be resolved`);
    warn(`${p.file}: ${what} was not captured`);
    return `./missing/${what.replace(/[^\w.-]+/g, "_")}.js`;
  };
  let code = p.draft.code.replace(
    /(["'])(s2s-module:|s2s-chunk:)([^"']+)\1/g,
    (_, _q, kind: string, ref: string) => {
      if (kind === MODULE_PREFIX) return quote(toSpec(ref) ?? missing(`module ${ref}`));
      const table = tables.get(ref);
      return quote(toSpec(table?.entry) ?? missing(ref.split("/").pop() ?? ref));
    },
  );

  const lines: string[] = [];
  const named = new Map<string, Map<string, string>>();
  const order: string[] = [];
  const add = (line: string) => {
    if (!lines.includes(line)) lines.push(line);
  };
  for (const line of p.draft.head) {
    if (line.note) notes.push(line.note);
    const spec = specOf(line, p, toSpec, tables, missing);
    if (!spec) continue;
    if (line.namespace) {
      if (line.target.kind === "package")
        for (const text of vendorNamespaceLines(line.namespace, spec.from, line.version)) add(text);
      else add(`import * as ${line.namespace} from ${quote(spec.from)};`);
    }
    if (line.defaultName) add(`import ${line.defaultName} from ${quote(spec.from)};`);
    const names = spec.names;
    if (names.length > 0) {
      if (!named.has(spec.from)) {
        named.set(spec.from, new Map());
        order.push(spec.from);
      }
      for (const n of names) named.get(spec.from)?.set(n.local, n.imported);
    }
    if (!line.namespace && !line.defaultName && names.length === 0)
      add(`import ${quote(spec.from)};`);
  }
  for (const from of order) {
    const items = [...(named.get(from) ?? [])].map(([local, imported]) =>
      imported === local
        ? local
        : imported === "default"
          ? `default as ${local}`
          : `${imported} as ${local}`,
    );
    add(`import { ${items.join(", ")} } from ${quote(from)};`);
  }
  const head = [...new Set(notes)].map((n) => `// s2s: ${n}`);
  code = [...head, ...lines, code].join("\n");
  return code.endsWith("\n") ? code : `${code}\n`;
}

function specOf(
  line: ImportLine,
  p: Placed,
  toSpec: (key: string | null | undefined) => string | undefined,
  tables: Map<string, ChunkTable>,
  missing: (what: string) => string,
): { from: string; names: { imported: string; local: string }[] } | undefined {
  const target = line.target;
  switch (target.kind) {
    case "package":
      return { from: target.name, names: line.names };
    case "file":
      return { from: relativeFile(p.file, target.path), names: line.names };
    case "module":
      return { from: toSpec(target.key) ?? missing(`module ${target.key}`), names: line.names };
    case "chunk-export": {
      const table = tables.get(target.url);
      if (!table)
        return { from: missing(target.url.split("/").pop() ?? target.url), names: line.names };
      if (target.name === "" || target.name === "*")
        return { from: toSpec(table.entry) ?? missing(target.url), names: [] };
      const hit = table.exports.get(target.name);
      if (!hit) return { from: toSpec(table.entry) ?? missing(target.url), names: line.names };
      return {
        from: toSpec(hit.key) ?? missing(target.url),
        names: line.names.map((n) => ({ imported: hit.local, local: n.local })),
      };
    }
  }
}

async function addBundlerDevDependency(
  paths: WorkspacePaths,
  bundler: BundlerReport,
  warn: (m: string) => void,
): Promise<void> {
  const pkg = bundlerPackage(bundler);
  if (!pkg) return;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(await readFile(paths.packageJson, "utf8")) as Record<string, unknown>;
  } catch {
    warn(
      'project/package.json is missing (run "s2s detect"); the bundler devDependency was not added.',
    );
    return;
  }
  const dev = { ...((json.devDependencies as Record<string, string> | undefined) ?? {}) };
  const deps = (json.dependencies as Record<string, string> | undefined) ?? {};
  if (pkg.name in dev || pkg.name in deps) return;
  dev[pkg.name] = pkg.range;
  json.devDependencies = Object.fromEntries(
    Object.entries(dev).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeJsonAtomic(paths.packageJson, json);
}
