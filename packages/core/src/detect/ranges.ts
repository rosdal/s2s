import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import type { MapEntry } from "../capture/discovery/run.js";
import { inlineMap, type LogicalMap, loadMap, parseMapText } from "../maps/load.js";
import { parseVendorPath } from "../maps/packages.js";
import { normalizeSource } from "../maps/paths.js";
import { lineStartsOf } from "../maps/rename.js";
import type { DetectContext } from "./context.js";
import { ByteIndex, type Evidence } from "./evidence.js";

/**
 * How a range was found, most exact first:
 * - `sourcemap`: mappings point every byte at a file under `node_modules`
 * - `cdn-file`: the whole file came from a CDN URL naming the package
 * - `module`: a banner or version string sits inside one bundler module (a webpack module or a
 *   CommonJS wrapper), and the range is that module
 * - `banner-to-boundary`: a banner at the top level of a scope-hoisted bundle, up to the next
 *   banner or module; less certain, since nothing marks where the package's code ends
 */
export type RangeMethod = "sourcemap" | "cdn-file" | "module" | "banner-to-boundary";
const PRIORITY: Record<RangeMethod, number> = {
  sourcemap: 0,
  "cdn-file": 1,
  module: 2,
  "banner-to-boundary": 3,
};

export interface ModuleRef {
  kind: "webpack-module" | "cjs-wrapper" | "esbuild-cjs";
  id: string;
}

export interface VendorRange {
  package: string;
  version: string | null;
  /** UTF-8 byte offsets into the body; `end` is exclusive. */
  start: number;
  end: number;
  method: RangeMethod;
  module: ModuleRef | null;
  evidence: string[];
}

export interface BundleRanges {
  url: string;
  bodyHash: string;
  size: number;
  vendorBytes: number;
  ranges: VendorRange[];
}

interface Span {
  start: number;
  end: number;
}

export interface ModuleFactory extends Span, ModuleRef {}

export interface ModuleLayout {
  /**
   * Module functions, nested ones included, sorted by start (outer before inner). A module that
   * contains other modules is a scope, like webpack's concatenated entry module: it holds
   * several packages and first-party code side by side. String indices.
   */
  factories: (ModuleFactory & { leaf: boolean })[];
  /** Statements at the bundle's top level (inside a whole-file wrapper, if there is one). */
  statements: Span[];
}

type AnyNode = { type: string; start?: number | null; end?: number | null } & Record<
  string,
  unknown
>;

const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "comments",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "range",
]);

const isFunction = (node: AnyNode | undefined): boolean =>
  node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression";

function keyName(node: AnyNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return String(node.value);
  return undefined;
}

/**
 * Find the module functions in a bundle: webpack's module map (`{123:(e,t,n)=>{…}}` or an
 * array of functions), CommonJS wrappers (`var x=__commonJS((e,t)=>{…})`, webpack 5's and
 * Rolldown's lazy-init helpers) and esbuild's `__commonJS({"path"(e,t){…}})`. The whole-file
 * IIFE webpack wraps everything in is looked through, not reported.
 */
export function findModules(code: string): ModuleLayout {
  let program: AnyNode;
  try {
    program = parse(code, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
    }).program as unknown as AnyNode;
  } catch {
    return { factories: [], statements: [] };
  }
  const candidates: Candidate[] = [];
  let statements: Span[] = spans(program.body as AnyNode[]);
  const whole = code.length * 0.5;

  // Every candidate is collected, nested ones too: a candidate that is later thrown out must not
  // hide the real modules inside it.
  // `depth` counts the functions between a node and its scope: the program, the whole-file
  // wrapper, or a webpack module. CommonJS wrappers only count at depth 0; deeper, the same
  // shape is a library calling its own helpers.
  const visit = (
    node: AnyNode,
    parent: AnyNode | undefined,
    grand: AnyNode | undefined,
    depth: number,
  ) => {
    const candidate = candidateOf(node, parent, grand);
    if (candidate && (!candidate.helper || depth === 0)) candidates.push(candidate);
    let inner = depth;
    if (isFunction(node) || node.type === "ObjectMethod") {
      inner = depth + 1;
      if (candidate && !candidate.helper) inner = 0;
      // A function that wraps most of the file and is called right away: its body is the real
      // top level.
      if (
        (node.end ?? 0) - (node.start ?? 0) > whole &&
        parent?.type === "CallExpression" &&
        parent.callee === node
      ) {
        inner = 0;
        const body = node.body as AnyNode;
        if (body?.type === "BlockStatement") statements = spans(body.body as AnyNode[]);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key) || !value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child === "object" && "type" in child)
            visit(child as AnyNode, node, parent, inner);
      } else if ("type" in value) {
        visit(value as AnyNode, node, parent, inner);
      }
    }
  };
  visit(program, undefined, undefined, 0);

  // A CommonJS helper wraps every CommonJS module in the bundle; a call seen once is more likely
  // an ordinary higher-order function than a module wrapper.
  const helperUses = new Map<string, number>();
  for (const c of candidates)
    if (c.helper) helperUses.set(c.helper, (helperUses.get(c.helper) ?? 0) + 1);
  const kept = candidates
    .filter((c) => !c.helper || (helperUses.get(c.helper) ?? 0) >= 2)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const factories = kept.map((c) => ({
    start: c.start,
    end: c.end,
    kind: c.kind,
    id: c.id,
    leaf: !kept.some((o) => o !== c && o.start >= c.start && o.end <= c.end),
  }));
  return { factories, statements };
}

/** The innermost module around a position, or `undefined` at the bundle's top level. */
export function moduleAt(
  layout: ModuleLayout,
  at: number,
): ModuleLayout["factories"][number] | undefined {
  let best: ModuleLayout["factories"][number] | undefined;
  for (const f of layout.factories) {
    if (f.start > at) break;
    if (at < f.end && (!best || f.end - f.start < best.end - best.start)) best = f;
  }
  return best;
}

function spans(nodes: AnyNode[] | undefined): Span[] {
  return (nodes ?? []).map((n) => ({ start: n.start ?? 0, end: n.end ?? 0 }));
}

interface Candidate extends ModuleFactory {
  /** The wrapping helper's name, for CommonJS wrappers. */
  helper?: string;
}

/** A literal key (`123`, `"./src/x.js"`), as module ids are; identifier keys are plain methods. */
function literalKey(node: AnyNode | undefined, computed: unknown): string | undefined {
  if (computed) return undefined;
  if (node?.type === "StringLiteral" || node?.type === "NumericLiteral") return String(node.value);
  return undefined;
}

function moduleMapSize(object: AnyNode): number {
  return (object.properties as AnyNode[]).filter(
    (p) =>
      literalKey(p.key as AnyNode, p.computed) !== undefined &&
      (p.type === "ObjectMethod" || isFunction(p.value as AnyNode)),
  ).length;
}

function candidateOf(
  node: AnyNode,
  parent: AnyNode | undefined,
  grand: AnyNode | undefined,
): Candidate | undefined {
  const span = { start: node.start ?? 0, end: node.end ?? 0 };
  // webpack module map: two or more functions keyed by module id, as `123:(e,t,n)=>{…}` or,
  // since webpack 5.100, the method shorthand `123(e,t,n){…}`. One literal-keyed method on its
  // own is esbuild's `__commonJS({"node_modules/x/index.js"(exports, module){…}})`.
  if (node.type === "ObjectMethod" && parent?.type === "ObjectExpression") {
    const id = literalKey(node.key as AnyNode, node.computed);
    if (id === undefined) return undefined;
    const size = moduleMapSize(parent);
    if (size >= 2) return { ...span, kind: "webpack-module", id };
    if ((parent.properties as AnyNode[]).length === 1 && grand?.type === "CallExpression")
      return { ...span, kind: "esbuild-cjs", id };
    return undefined;
  }
  if (isFunction(node) && parent?.type === "ObjectProperty" && grand?.type === "ObjectExpression") {
    const id = literalKey(parent.key as AnyNode, parent.computed);
    if (id !== undefined && moduleMapSize(grand) >= 2)
      return { ...span, kind: "webpack-module", id };
    return undefined;
  }
  // webpack module array: `[function(e,t,n){…}, …]`.
  if (isFunction(node) && parent?.type === "ArrayExpression") {
    const elements = (parent.elements as (AnyNode | null)[]) ?? [];
    if (elements.filter((e) => e && isFunction(e)).length >= 2)
      return { ...span, kind: "webpack-module", id: String(elements.indexOf(node)) };
    return undefined;
  }
  // CommonJS wrapper: `var x = helper((exports, module) => {…})`.
  const callee = parent?.callee as AnyNode | undefined;
  if (
    isFunction(node) &&
    parent?.type === "CallExpression" &&
    (parent.arguments as AnyNode[]).includes(node) &&
    (callee?.type === "Identifier" || callee?.type === "MemberExpression")
  ) {
    const helper =
      callee.type === "Identifier"
        ? (callee.name as string)
        : `.${keyName(callee.property as AnyNode) ?? "?"}`;
    const id =
      grand?.type === "VariableDeclarator"
        ? keyName(grand.id as AnyNode)
        : grand?.type === "AssignmentExpression"
          ? keyName(grand.left as AnyNode)
          : undefined;
    if (id !== undefined) return { ...span, kind: "cjs-wrapper", id, helper };
  }
  return undefined;
}

/** Mapped runs of generated code whose source sits under `node_modules`, as string indices. */
export function sourcemapRuns(
  code: string,
  map: LogicalMap,
): { package: string; version: string | null; start: number; end: number }[] {
  const owner = map.sources.map((raw) => {
    const normalized = normalizeSource(raw);
    if (!normalized.ok || normalized.kind !== "vendor") return null;
    const pkg = parseVendorPath(normalized.path);
    return pkg ? { name: pkg.name, version: pkg.version } : null;
  });
  const lineStarts = lineStartsOf(code);
  const runs: { package: string; version: string | null; start: number; end: number }[] = [];
  let open: (typeof runs)[number] | undefined;
  const close = (at: number) => {
    if (open && at > open.start) {
      open.end = at;
      const last = runs.at(-1);
      if (last && last.package === open.package && last.end === open.start) last.end = open.end;
      else runs.push(open);
    }
    open = undefined;
  };
  for (const [line, segments] of map.mappings.entries()) {
    const lineStart = lineStarts[line];
    if (lineStart === undefined) break;
    for (const segment of segments) {
      const at = lineStart + segment[0];
      const pkg = segment.length > 1 ? owner[segment[1] as number] : null;
      if (open && pkg && open.package === pkg.name) continue;
      close(at);
      if (pkg) open = { package: pkg.name, version: pkg.version, start: at, end: at };
    }
  }
  close(code.length);
  return runs;
}

/** Remove the parts of `range` already covered by `taken` (both sorted, non-overlapping). */
function subtract(range: Span, taken: Span[]): Span[] {
  const pieces: Span[] = [];
  let cursor = range.start;
  for (const t of taken) {
    if (t.end <= cursor) continue;
    if (t.start >= range.end) break;
    if (t.start > cursor) pieces.push({ start: cursor, end: Math.min(t.start, range.end) });
    cursor = Math.max(cursor, t.end);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end) pieces.push({ start: cursor, end: range.end });
  return pieces;
}

function insertSorted(list: Span[], span: Span): void {
  const at = list.findIndex((s) => s.start > span.start);
  if (at === -1) list.push(span);
  else list.splice(at, 0, span);
}

interface RangeCandidate {
  package: string;
  version: string | null;
  /** String indices. */
  start: number;
  end: number;
  method: RangeMethod;
  module: ModuleRef | null;
  evidence: string[];
}

export interface RangeInput {
  ctx: DetectContext;
  evidence: Evidence[];
  /** Packages whose code may be dropped, with the version they resolved to. */
  accepted: Map<string, string | null>;
}

/**
 * Mark the byte ranges of each bundle that belong to an accepted package. Source maps give exact
 * boundaries; banners and version strings give a module (or, at the top level of a hoisted
 * bundle, the stretch up to the next boundary); CDN files are vendor code end to end. Where
 * methods overlap, the more exact one keeps the bytes.
 */
export async function vendorRanges(input: RangeInput): Promise<BundleRanges[]> {
  const { ctx, evidence, accepted } = input;
  const mapFor = await mapLoader(ctx);
  const out: BundleRanges[] = [];
  for (const asset of ctx.assets) {
    const url = asset.urls[0] ?? "";
    const text = await ctx.text(asset.hash);
    if (text === undefined) continue;
    const candidates: RangeCandidate[] = [];

    // Loaded one at a time: a site's maps can be many megabytes each.
    const map = await mapFor(asset);
    if (map) {
      for (const run of sourcemapRuns(text, map)) {
        if (!accepted.has(run.package)) continue;
        candidates.push({
          ...run,
          version: accepted.get(run.package) ?? run.version,
          method: "sourcemap",
          module: null,
          evidence: [],
        });
      }
    }

    const here = evidence.filter((e) => e.location.bodyHash === asset.hash);
    for (const item of here.filter((e) => e.signal === "cdn-url")) {
      if (!accepted.has(item.package)) continue;
      candidates.push({
        package: item.package,
        version: accepted.get(item.package) ?? null,
        start: 0,
        end: text.length,
        method: "cdn-file",
        module: null,
        evidence: [item.id],
      });
    }

    const positioned = here.filter(
      (e) =>
        (e.signal === "banner" || e.signal === "version-string") &&
        e.location.offset !== null &&
        accepted.has(e.package),
    );
    if (positioned.length > 0 && asset.kind === "js") {
      const layout = findModules(text);
      const toIndex = indexer(text);
      const bannerStarts = here
        .filter((e) => e.signal === "banner" && e.location.offset !== null)
        .map((e) => toIndex(e.location.offset ?? 0))
        .sort((a, b) => a - b);
      for (const item of positioned) {
        const at = toIndex(item.location.offset ?? 0);
        const factory = moduleAt(layout, at);
        const base = {
          package: item.package,
          version: accepted.get(item.package) ?? item.version,
          evidence: [item.id],
        };
        if (factory?.leaf) {
          candidates.push({
            ...base,
            start: factory.start,
            end: factory.end,
            method: "module",
            module: { kind: factory.kind, id: factory.id },
          });
          continue;
        }
        // In a scope that mixes packages (the top level of a hoisted bundle, or a concatenated
        // module), only a banner marks where a package starts; it runs to the next banner or
        // module. A version string there says nothing about where the package ends.
        if (item.signal !== "banner") continue;
        const scopeEnd = factory?.end ?? text.length;
        const nextBanner = bannerStarts.find((b) => b > at);
        const nextFactory = layout.factories.find((f) => f.start > at && f !== factory)?.start;
        const bounds = [nextBanner, nextFactory].filter(
          (n): n is number => n !== undefined && n <= scopeEnd,
        );
        const end =
          bounds.length > 0
            ? Math.min(...bounds)
            : factory
              ? undefined
              : layout.statements.find((s) => s.start >= at)?.end;
        if (end === undefined || end <= at) continue;
        candidates.push({ ...base, start: at, end, method: "banner-to-boundary", module: null });
      }
    } else if (positioned.length > 0) {
      // CSS: a banner owns the stylesheet up to the next banner.
      const toIndex = indexer(text);
      // Every banner bounds the one before it, accepted or not, so no other CSS is swallowed.
      const starts = here
        .filter((e) => e.signal === "banner" && e.location.offset !== null)
        .map((e) => toIndex(e.location.offset ?? 0))
        .sort((a, b) => a - b);
      for (const item of positioned.filter((e) => e.signal === "banner")) {
        const at = toIndex(item.location.offset ?? 0);
        candidates.push({
          package: item.package,
          version: accepted.get(item.package) ?? item.version,
          start: at,
          end: starts.find((s) => s > at) ?? text.length,
          method: "banner-to-boundary",
          module: null,
          evidence: [item.id],
        });
      }
    }

    if (candidates.length === 0) continue;
    const taken: Span[] = [];
    const ranges: RangeCandidate[] = [];
    candidates.sort((a, b) => PRIORITY[a.method] - PRIORITY[b.method] || a.start - b.start);
    for (const candidate of candidates) {
      const same = ranges.find(
        (r) =>
          r.package === candidate.package &&
          r.method === candidate.method &&
          r.start === candidate.start &&
          r.end === candidate.end,
      );
      if (same) {
        for (const id of candidate.evidence)
          if (!same.evidence.includes(id)) same.evidence.push(id);
        continue;
      }
      for (const piece of subtract(candidate, taken)) {
        ranges.push({ ...candidate, ...piece });
        insertSorted(taken, piece);
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    const bytes = new ByteIndex(text);
    const toBytes = (index: number) => bytes.bytes(index);
    const finished = ranges.map((r) => ({ ...r, start: toBytes(r.start), end: toBytes(r.end) }));
    out.push({
      url,
      bodyHash: asset.hash,
      size: Buffer.byteLength(text),
      vendorBytes: finished.reduce((n, r) => n + r.end - r.start, 0),
      ranges: finished,
    });
  }
  return out;
}

function indexer(text: string): (byteOffset: number) => number {
  if (Buffer.byteLength(text) === text.length) return (b) => b;
  const buffer = Buffer.from(text);
  return (b) => buffer.subarray(0, b).toString("utf8").length;
}

/** Loads the source map (saved or inline) of one captured body on demand. */
async function mapLoader(
  ctx: DetectContext,
): Promise<(asset: DetectContext["assets"][number]) => Promise<LogicalMap | undefined>> {
  const entries = (await ctx.readJson<MapEntry[]>(path.join(ctx.paths.maps, "index.json"))) ?? [];
  const byFile = new Map(entries.map((e) => [e.file, e]));
  return async (asset) => {
    const entry = asset.urls.map((u) => byFile.get(u)).find((e) => e !== undefined);
    let text: string | undefined;
    if (entry) {
      text = await readFile(path.join(ctx.paths.maps, `${entry.hash}.map`), "utf8").catch(
        () => undefined,
      );
    } else {
      const body = await ctx.text(asset.hash);
      text = body ? inlineMap(body) : undefined;
    }
    if (!text) return undefined;
    try {
      return loadMap(parseMapText(text));
    } catch {
      // Stage 2 already reported unusable maps.
      return undefined;
    }
  };
}
