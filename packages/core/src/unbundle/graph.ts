import path from "node:path";
import type { Boundary } from "./types.js";

export type ModuleKind = "component" | "hook" | "route" | "style" | "util" | "entry";
export type ModuleOrigin = "sourcemap-exact" | "renamed" | "unbundled";

/** What the graph needs to know about one written module. */
export interface GraphInput {
  id: string;
  /** Workspace-relative path. */
  file: string;
  origin: ModuleOrigin;
  boundary: Boundary;
  chunk: string;
  code: string;
  pages: string[];
  entry: boolean;
  obfuscated: boolean;
  source: string | null;
  range: { start: number; end: number } | null;
}

export interface ModuleEntry {
  id: string;
  file: string;
  origin: ModuleOrigin;
  boundary: Boundary;
  chunk: string;
  bytes: number;
  imports: string[];
  packageImports: string[];
  dynamicImports: string[];
  pages: string[];
  kind: ModuleKind;
  obfuscated: boolean;
  group: string;
  order: number;
  source: string | null;
  range: { start: number; end: number } | null;
}

export interface ModulesFile {
  modules: ModuleEntry[];
  groups: { id: string; modules: string[]; bytes: number }[];
}

interface Specifiers {
  static: string[];
  dynamic: string[];
}

/** Module specifiers in a file, found by pattern so any language Stage 2 recovered works. */
export function specifiersOf(code: string): Specifiers {
  const stat = new Set<string>();
  const dyn = new Set<string>();
  const add = (set: Set<string>, s: string | undefined) => {
    if (s) set.add(s);
  };
  for (const m of code.matchAll(
    /(?:^|[;\n}])\s*(?:import|export)\s[^;'"`]*?\bfrom\s*(['"])([^'"]+)\1/g,
  ))
    add(stat, m[2]);
  for (const m of code.matchAll(/(?:^|[;\n}])\s*import\s*(['"])([^'"]+)\1/g)) add(stat, m[2]);
  for (const m of code.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) add(stat, m[2]);
  for (const m of code.matchAll(/\bimport\(\s*(['"`])([^'"`]+)\1\s*\)/g)) add(dyn, m[2]);
  return { static: [...stat], dynamic: [...dyn] };
}

/** `react-dom/client` → `react-dom`, `@scope/pkg/x` → `@scope/pkg`. */
export function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

const EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"];

function guessKind(input: GraphInput, isRoute: boolean, styleOnly: boolean): ModuleKind {
  if (/\.(?:css|scss|sass|less)$/.test(input.file) || styleOnly) return "style";
  if (isRoute) return "route";
  if (input.entry) return "entry";
  const jsx = /<[A-Za-z][\w.]*[\s/>]|<>/.test(input.code) && /return\s*\(?\s*</.test(input.code);
  if (jsx || /\.(?:jsx|tsx|vue|svelte)$/.test(input.file)) return "component";
  if (/\buse[A-Z]\w*\s*\(/.test(input.code)) return "hook";
  return "util";
}

/**
 * Build `modules.json`: local, package and dynamic imports per module, a kind guess, the work
 * order (strongly connected components kept together, dependencies before the modules that use
 * them) and groups of up to `maxGroupBytes` for agent passes.
 */
export function buildGraph(inputs: GraphInput[], maxGroupBytes: number): ModulesFile {
  const byFile = new Map(inputs.map((m) => [m.file.toLowerCase(), m]));
  const resolve = (from: GraphInput, spec: string): GraphInput | undefined => {
    if (!spec.startsWith(".") && !spec.startsWith("/")) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from.file), spec));
    const candidates = [
      base,
      ...EXTENSIONS.map((e) => base + e),
      ...EXTENSIONS.map((e) => `${base}/index${e}`),
    ];
    for (const c of candidates) {
      const hit = byFile.get(c.toLowerCase());
      if (hit) return hit;
    }
    return undefined;
  };
  const edges = new Map<
    string,
    { imports: Set<string>; dynamic: Set<string>; packages: Set<string> }
  >();
  const dynamicTargets = new Set<string>();
  for (const m of inputs) {
    const specs = specifiersOf(m.code);
    const e = {
      imports: new Set<string>(),
      dynamic: new Set<string>(),
      packages: new Set<string>(),
    };
    for (const s of specs.static) {
      const target = resolve(m, s);
      if (target) e.imports.add(target.id);
      else if (!s.startsWith(".") && !s.startsWith("/") && !/^[a-z]+:/i.test(s))
        e.packages.add(packageName(s));
    }
    for (const s of specs.dynamic) {
      const target = resolve(m, s);
      if (target) {
        e.dynamic.add(target.id);
        dynamicTargets.add(target.id);
      } else if (!s.startsWith(".") && !s.startsWith("/")) e.packages.add(packageName(s));
    }
    edges.set(m.id, e);
  }

  // Strongly connected components (Tarjan), then dependencies first.
  const ids = inputs.map((m) => m.id).sort();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccs: string[][] = [];
  let counter = 0;
  const neighbours = (id: string) =>
    [...(edges.get(id)?.imports ?? []), ...(edges.get(id)?.dynamic ?? [])].sort();
  const strong = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of neighbours(v)) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc.sort());
    }
  };
  for (const id of ids) if (!index.has(id)) strong(id);
  // Tarjan emits components in reverse topological order of the "imports" relation, which is
  // exactly leaves (dependencies) first.
  const ordered = sccs.flat();
  const order = new Map(ordered.map((id, i) => [id, i + 1]));

  const byId = new Map(inputs.map((m) => [m.id, m]));
  const bytesOf = (id: string) => Buffer.byteLength(byId.get(id)?.code ?? "");
  const groups: ModulesFile["groups"] = [];
  let current: { id: string; modules: string[]; bytes: number } | undefined;
  for (const scc of sccs) {
    const size = scc.reduce((n, id) => n + bytesOf(id), 0);
    if (!current || (current.bytes + size > maxGroupBytes && current.modules.length > 0)) {
      current = { id: `g${groups.length + 1}`, modules: [], bytes: 0 };
      groups.push(current);
    }
    current.modules.push(...scc);
    current.bytes += size;
  }
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const id of g.modules) groupOf.set(id, g.id);

  const modules: ModuleEntry[] = inputs
    .map((m) => {
      const e = edges.get(m.id);
      const styleOnly =
        !/\.(?:css|scss|sass|less)$/.test(m.file) &&
        specifiersOf(m.code).static.some((s) => /\.css$/.test(s)) &&
        m.code.split("\n").filter((l) => l.trim() && !/^\s*(?:import|export)\b/.test(l)).length ===
          0;
      return {
        id: m.id,
        file: m.file,
        origin: m.origin,
        boundary: m.boundary,
        chunk: m.chunk,
        bytes: bytesOf(m.id),
        imports: [...(e?.imports ?? [])].sort(),
        packageImports: [...(e?.packages ?? [])].sort(),
        dynamicImports: [...(e?.dynamic ?? [])].sort(),
        pages: [...m.pages].sort(),
        kind: guessKind(m, dynamicTargets.has(m.id), styleOnly),
        obfuscated: m.obfuscated,
        group: groupOf.get(m.id) ?? "g1",
        order: order.get(m.id) ?? 0,
        source: m.source,
        range: m.range,
      };
    })
    .sort((a, b) => a.order - b.order);
  return { modules, groups };
}
