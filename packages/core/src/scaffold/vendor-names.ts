import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type * as t from "@babel/types";
import { applyEdits, parseCode, type TextEdit } from "../unbundle/ast.js";

/**
 * Stage 4 drops a library's inlined code and points what the site used of it at
 * `import * as e from "pkg"` plus `const Q = e`: the bundle never says which export `Q` was. After
 * install the package is on disk, so each such binding can be named: compare its declaration in the
 * bundle with every export of the installed package by shape (method and property names, the
 * strings it holds), which minifiers leave alone, and import the one that matches.
 */

export type Shape = Set<string>;

const KEEP_STRING = /^[\w$.\- ]{2,40}$/;

const keyName = (k: t.Node): string | null =>
  k.type === "Identifier" ? k.name : k.type === "StringLiteral" ? k.value : null;
const nameOf = (n: t.Identifier | t.StringLiteral) => (n.type === "Identifier" ? n.name : n.value);

/** Method and property names and short strings anywhere inside a declaration. */
export function shapeOf(node: t.Node): Shape {
  const tokens = new Set<string>();
  const visit = (n: t.Node | null | undefined, depth: number) => {
    if (!n || depth > 60) return;
    switch (n.type) {
      case "ClassMethod":
      case "ClassPrivateMethod":
      case "ObjectMethod": {
        const k = n.key.type === "PrivateName" ? null : keyName(n.key);
        if (k) tokens.add(`m:${k}`);
        break;
      }
      case "ClassProperty":
      case "ObjectProperty": {
        const k = keyName(n.key);
        if (k) tokens.add(`p:${k}`);
        break;
      }
      case "MemberExpression":
        if (n.property.type === "Identifier" && !n.computed) tokens.add(`p:${n.property.name}`);
        break;
      case "StringLiteral":
        if (KEEP_STRING.test(n.value)) tokens.add(`s:${n.value}`);
        break;
      case "TemplateLiteral":
        if (n.expressions.length === 0) {
          const v = n.quasis[0]?.value.cooked ?? "";
          if (KEEP_STRING.test(v)) tokens.add(`s:${v}`);
        }
        break;
    }
    for (const key of Object.keys(n) as (keyof typeof n)[]) {
      if (key === "loc" || key === "start" || key === "end" || key === "leadingComments") continue;
      const value = n[key] as unknown;
      if (Array.isArray(value)) {
        for (const v of value)
          if (v && typeof v === "object" && "type" in v) visit(v as t.Node, depth + 1);
      } else if (value && typeof value === "object" && "type" in value)
        visit(value as t.Node, depth + 1);
    }
  };
  visit(node, 0);
  return tokens;
}

const jaccard = (a: Shape, b: Shape) => {
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / (a.size + b.size - common || 1);
};

/** Top-level declarations by binding name. */
function declarations(ast: t.File): Map<string, t.Node> {
  const out = new Map<string, t.Node>();
  for (const node of ast.program.body) {
    const decl =
      (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") &&
      node.declaration
        ? node.declaration
        : node;
    if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id)
      out.set(decl.id.name, decl);
    else if (decl.type === "VariableDeclaration")
      for (const d of decl.declarations)
        if (d.id.type === "Identifier" && d.init) out.set(d.id.name, d.init);
  }
  return out;
}

/** Parse a bundle once and keep its top-level declarations. */
export function bundleDeclarations(code: string): Map<string, t.Node> {
  try {
    return declarations(parseCode(code));
  } catch {
    return new Map();
  }
}

export const MIN_SIMILARITY = 0.55;
const MIN_TOKENS = 3;

export interface Candidate {
  name: string;
  shape: Shape;
}

/** The export a bundle declaration is, when one stands out. */
export function bestExport(
  shape: Shape,
  exports: Candidate[],
): { name: string; score: number } | null {
  if (shape.size < MIN_TOKENS - 1) return null;
  const scored = exports
    .filter((e) => e.shape.size >= MIN_TOKENS - 1)
    .map((e) => ({ ...e, score: jaccard(shape, e.shape) }))
    .sort(
      (a, b) => b.score - a.score || Number(a.name === "default") - Number(b.name === "default"),
    );
  const best = scored[0];
  if (!best || best.score < MIN_SIMILARITY) return null;
  // One value exported under two names (`gsap` and `default`) is one candidate, not a tie.
  const rival = scored.find((e) => e !== best && jaccard(e.shape, best.shape) < 1);
  if (rival && best.score - rival.score < 0.05) return null;
  // A tiny shape (`{ clone, merge }`) only counts as an exact match nothing else comes near.
  if (
    (shape.size < MIN_TOKENS || best.shape.size < MIN_TOKENS) &&
    (best.score < 1 || (rival?.score ?? 0) >= 0.6)
  )
    return null;
  return { name: best.name, score: best.score };
}

interface Module {
  ast: t.File;
  decls: Map<string, t.Node>;
  imports: Map<string, { source: string; name: string | "*" }>;
}

/** Reads an installed package's modules and the shape behind each export. */
export class PackageReader {
  readonly dir: string;
  readonly name: string;
  #manifest: Record<string, unknown> | undefined;
  #modules = new Map<string, Promise<Module | null>>();
  #exports = new Map<string, Promise<Map<string, Shape>>>();

  constructor(projectDir: string, name: string) {
    this.name = name;
    this.dir = path.join(projectDir, "node_modules", name);
  }

  async manifest(): Promise<Record<string, unknown> | undefined> {
    this.#manifest ??= await readFile(path.join(this.dir, "package.json"), "utf8")
      .then((x) => JSON.parse(x) as Record<string, unknown>)
      .catch(() => ({}));
    return this.#manifest;
  }

  #load(file: string): Promise<Module | null> {
    let known = this.#modules.get(file);
    if (!known) {
      known = (async () => {
        try {
          const ast = parseCode(await readFile(file, "utf8"));
          const imports = new Map<string, { source: string; name: string | "*" }>();
          for (const n of ast.program.body)
            if (n.type === "ImportDeclaration")
              for (const s of n.specifiers)
                imports.set(s.local.name, {
                  source: n.source.value,
                  name:
                    s.type === "ImportSpecifier"
                      ? nameOf(s.imported)
                      : s.type === "ImportDefaultSpecifier"
                        ? "default"
                        : "*",
                });
          return { ast, decls: declarations(ast), imports };
        } catch {
          return null;
        }
      })();
      this.#modules.set(file, known);
    }
    return known;
  }

  #resolve(from: string, spec: string): string | undefined {
    if (!spec.startsWith(".")) return undefined;
    const base = path.resolve(path.dirname(from), spec);
    return [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")].find((f) =>
      existsSync(f),
    );
  }

  /** The shape a module binding stands for, looking through `a || b`, aliases and imports. */
  async #binding(file: string, local: string, depth: number): Promise<Shape | null> {
    if (depth > 12) return null;
    const mod = await this.#load(file);
    if (!mod) return null;
    const decl = mod.decls.get(local);
    if (decl) return this.#deref(file, decl, depth + 1);
    const imp = mod.imports.get(local);
    if (!imp || imp.name === "*") return null;
    const next = this.#resolve(file, imp.source);
    return next ? ((await this.exportsOf(next, depth + 1)).get(imp.name) ?? null) : null;
  }

  async #deref(file: string, node: t.Node, depth: number): Promise<Shape | null> {
    if (node.type === "Identifier") return this.#binding(file, node.name, depth);
    if (node.type === "LogicalExpression" && (node.operator === "||" || node.operator === "??"))
      return this.#deref(file, node.right, depth);
    if (node.type === "SequenceExpression") {
      const last = node.expressions.at(-1);
      return last ? this.#deref(file, last, depth) : null;
    }
    return shapeOf(node);
  }

  /** Every export of a module, by exported name. */
  exportsOf(file: string, depth = 0): Promise<Map<string, Shape>> {
    let known = this.#exports.get(file);
    if (!known) {
      known = (async () => {
        const out = new Map<string, Shape>();
        const mod = depth > 12 ? null : await this.#load(file);
        if (!mod) return out;
        for (const node of mod.ast.program.body) {
          if (node.type === "ExportAllDeclaration") {
            const next = this.#resolve(file, node.source.value);
            if (!next) continue;
            for (const [k, v] of await this.exportsOf(next, depth + 1))
              if (k !== "default" && !out.has(k)) out.set(k, v);
          } else if (node.type === "ExportNamedDeclaration") {
            if (node.source) {
              const next = this.#resolve(file, node.source.value);
              const theirs = next
                ? await this.exportsOf(next, depth + 1)
                : new Map<string, Shape>();
              for (const s of node.specifiers) {
                if (s.type !== "ExportSpecifier") continue;
                const shape = theirs.get(nameOf(s.local));
                if (shape) out.set(nameOf(s.exported), shape);
              }
            } else if (node.declaration) {
              const d = node.declaration;
              const locals =
                d.type === "VariableDeclaration"
                  ? d.declarations.flatMap((x) => (x.id.type === "Identifier" ? [x.id.name] : []))
                  : (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id
                    ? [d.id.name]
                    : [];
              for (const local of locals) {
                const shape = await this.#binding(file, local, depth + 1);
                if (shape) out.set(local, shape);
              }
            } else {
              for (const s of node.specifiers) {
                if (s.type !== "ExportSpecifier") continue;
                const shape = await this.#binding(file, nameOf(s.local), depth + 1);
                if (shape) out.set(nameOf(s.exported), shape);
              }
            }
          } else if (node.type === "ExportDefaultDeclaration") {
            const shape = await this.#deref(file, node.declaration as t.Node, depth + 1);
            if (shape) out.set("default", shape);
          }
        }
        return out;
      })();
      this.#exports.set(file, known);
    }
    return known;
  }

  /** The browser ESM entry. */
  async entry(): Promise<string | undefined> {
    const pkg = await this.manifest();
    if (!pkg) return undefined;
    const rel =
      pickTarget(
        typeof pkg.exports === "object" && pkg.exports
          ? ((pkg.exports as Record<string, unknown>)["."] ??
              (isConditions(pkg.exports) ? pkg.exports : undefined))
          : pkg.exports,
      ) ??
      (pkg.module as string | undefined) ??
      (pkg.main as string | undefined);
    if (!rel) return undefined;
    const file = path.join(this.dir, rel);
    return existsSync(file) ? file : undefined;
  }

  /**
   * Other modules a site can import (`three/addons/loaders/GLTFLoader.js`, `gsap/ScrollTrigger`),
   * as `[specifier, file]`, only those whose text holds at least two of `hints`.
   */
  async subpaths(hints: string[]): Promise<[string, string][]> {
    const pkg = await this.manifest();
    if (!pkg) return [];
    const files: [string, string][] = [];
    const exp = pkg.exports;
    if (exp && typeof exp === "object" && !isConditions(exp)) {
      for (const [key, value] of Object.entries(exp as Record<string, unknown>)) {
        if (key === "." || !key.startsWith("./")) continue;
        const target = pickTarget(value);
        if (!target) continue;
        if (key.split("*").length === 2 && target.split("*").length === 2) {
          const [pre = "", post = ""] = target.replace(/^\.\//, "").split("*");
          const [keyPre = "", keyPost = ""] = key.slice(2).split("*");
          for (const file of await listJs(path.join(this.dir, pre))) {
            const rel = path.relative(path.join(this.dir, pre), file).split(path.sep).join("/");
            if (post && !rel.endsWith(post)) continue;
            const stem = post ? rel.slice(0, rel.length - post.length) : rel;
            files.push([`${this.name}/${keyPre}${stem}${keyPost}`, file]);
          }
        } else if (!key.includes("*"))
          files.push([`${this.name}/${key.slice(2)}`, path.join(this.dir, target)]);
      }
    } else {
      // No exports map: top-level ESM files are what `pkg/File` imports reach (gsap/ScrollTrigger).
      for (const file of await listJs(this.dir, false))
        files.push([`${this.name}/${path.basename(file).replace(/\.m?js$/, "")}`, file]);
    }
    // One specifier per file: the documented `addons/` over `examples/jsm/`, the shortest otherwise.
    const byFile = new Map<string, string>();
    for (const [spec, file] of files) {
      const known = byFile.get(file);
      const rank = (x: string) => (x.includes("/addons/") ? 0 : 1) * 1000 + x.length;
      if (!known || rank(spec) < rank(known)) byFile.set(file, spec);
    }
    files.length = 0;
    for (const [file, spec] of byFile) files.push([spec, file]);
    const out: [string, string][] = [];
    const strong = hints.filter((h) => h.length >= 6).slice(0, 40);
    for (const [spec, file] of files) {
      const text = await readFile(file, "utf8").catch(() => "");
      if (strong.filter((h) => text.includes(h)).length >= Math.min(2, strong.length))
        out.push([spec, file]);
    }
    return out;
  }
}

function isConditions(v: unknown): boolean {
  return Boolean(
    v && typeof v === "object" && Object.keys(v as object).some((k) => !k.startsWith(".")),
  );
}

function pickTarget(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["browser", "import", "module", "default"]) {
      const r = pickTarget(o[k]);
      if (r) return r;
    }
  }
  return undefined;
}

async function listJs(dir: string, recursive = true): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.m?js$/.test(e.name) && !/\.min\.js$|\.cjs$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => !path.relative(dir, f).split(path.sep).includes("node_modules"))
    .sort();
}

export interface Resolution {
  specifier: string;
  name: string;
  score: number;
}

/** Resolve one bundle binding of `pkg`: the package entry first, then its other modules. */
export async function resolveBinding(
  reader: PackageReader,
  shape: Shape,
): Promise<Resolution | null> {
  const entry = await reader.entry();
  if (entry) {
    const exports = [...(await reader.exportsOf(entry))].map(([name, s]) => ({ name, shape: s }));
    const hit = bestExport(shape, exports);
    if (hit) return { specifier: reader.name, ...hit };
  }
  const hints = [...shape].map((s) => s.slice(2));
  let best: Resolution | null = null;
  for (const [specifier, file] of await reader.subpaths(hints)) {
    const exports = [...(await reader.exportsOf(file))].map(([name, s]) => ({ name, shape: s }));
    const hit = bestExport(shape, exports);
    // On a tie the module that defines it beats a barrel that re-exports it (`Addons.js`).
    if (
      hit &&
      (!best ||
        hit.score > best.score ||
        (hit.score === best.score && specifier.length > best.specifier.length))
    )
      best = { specifier, ...hit };
  }
  return best;
}

export interface NamedBinding {
  file: string;
  package: string;
  local: string;
  specifier: string;
  export: string;
  score: number;
}

/**
 * Rewrite one recovered module: each `const Q = e` (and `e` itself) that names an export of the
 * package `e` was imported from becomes `import { Scene as Q } from "three"`. Bindings that stay
 * unnamed keep reading the namespace.
 */
export async function nameVendorBindings(
  code: string,
  bundle: Map<string, t.Node>,
  readerOf: (pkg: string) => PackageReader,
): Promise<{ code: string; named: Omit<NamedBinding, "file">[] }> {
  let ast: t.File;
  try {
    ast = parseCode(code);
  } catch {
    return { code, named: [] };
  }
  const namespaces = new Map<string, { pkg: string; node: t.ImportDeclaration }>();
  for (const node of ast.program.body) {
    const spec = node.type === "ImportDeclaration" ? node.specifiers[0] : undefined;
    if (
      node.type === "ImportDeclaration" &&
      node.specifiers.length === 1 &&
      spec?.type === "ImportNamespaceSpecifier" &&
      !node.source.value.startsWith(".")
    )
      namespaces.set(spec.local.name, { pkg: node.source.value, node });
  }
  if (namespaces.size === 0) return { code, named: [] };
  const aliases: {
    decl: t.VariableDeclaration;
    parts: { id: string; ns: string | null; text: string }[];
  }[] = [];
  for (const node of ast.program.body) {
    if (node.type !== "VariableDeclaration") continue;
    const parts = node.declarations.map((d) => {
      const ns = d.init?.type === "Identifier" && namespaces.has(d.init.name) ? d.init.name : null;
      return {
        id: d.id.type === "Identifier" ? d.id.name : "",
        ns,
        text: code.slice(d.start ?? 0, d.end ?? 0),
      };
    });
    if (parts.some((p) => p.ns && p.id)) aliases.push({ decl: node, parts });
  }
  const resolved = new Map<string, Resolution>();
  // `var gsap = core.registerPlugin(css) || core`: the binding is what the right side holds.
  const deref = (node: t.Node | undefined, depth = 0): t.Node | undefined => {
    if (!node || depth > 8) return node;
    if (node.type === "Identifier") return deref(bundle.get(node.name), depth + 1);
    if (node.type === "LogicalExpression" && (node.operator === "||" || node.operator === "??"))
      return deref(node.right, depth + 1);
    return node;
  };
  const tryName = async (local: string, pkg: string) => {
    const decl = deref(bundle.get(local));
    if (!decl) return;
    const hit = await resolveBinding(readerOf(pkg), shapeOf(decl));
    if (hit) resolved.set(local, hit);
  };
  for (const [local, { pkg }] of namespaces) await tryName(local, pkg);
  for (const a of aliases)
    for (const p of a.parts)
      if (p.ns && p.id) await tryName(p.id, (namespaces.get(p.ns) as { pkg: string }).pkg);
  if (resolved.size === 0) return { code, named: [] };

  const edits: TextEdit[] = [];
  const named: Omit<NamedBinding, "file">[] = [];
  const stillRead = new Set<string>();
  for (const a of aliases) {
    let changed = false;
    const kept: string[] = [];
    for (const p of a.parts) {
      if (p.ns && p.id && resolved.has(p.id)) {
        changed = true;
        continue;
      }
      if (p.ns && resolved.has(p.ns)) {
        // The namespace's own name now holds a named import; read the namespace under another.
        kept.push(`${p.id} = ${p.ns}$ns`);
        stillRead.add(p.ns);
        changed = true;
      } else {
        if (p.ns) stillRead.add(p.ns);
        kept.push(p.text);
      }
    }
    if (changed)
      edits.push({
        start: a.decl.start ?? 0,
        end: a.decl.end ?? 0,
        text: kept.length === 0 ? "" : `${a.decl.kind} ${kept.join(",\n  ")};`,
      });
  }
  for (const [local, { pkg, node }] of namespaces) {
    const lines: string[] = [];
    const bySpec = new Map<string, string[]>();
    const add = (id: string) => {
      const r = resolved.get(id) as Resolution;
      named.push({
        package: pkg,
        local: id,
        specifier: r.specifier,
        export: r.name,
        score: r.score,
      });
      bySpec.set(r.specifier, [
        ...(bySpec.get(r.specifier) ?? []),
        r.name === "default" ? `default as ${id}` : `${r.name} as ${id}`,
      ]);
    };
    if (resolved.has(local)) add(local);
    for (const a of aliases)
      for (const p of a.parts) if (p.ns === local && resolved.has(p.id)) add(p.id);
    if (bySpec.size === 0) continue;
    if (!resolved.has(local)) lines.push(code.slice(node.start ?? 0, node.end ?? 0));
    else if (stillRead.has(local))
      lines.push(`import * as ${local}$ns from ${JSON.stringify(pkg)};`);
    for (const [spec, names] of bySpec)
      lines.push(`import { ${names.join(", ")} } from ${JSON.stringify(spec)};`);
    edits.push({ start: node.start ?? 0, end: node.end ?? 0, text: lines.join("\n") });
  }
  return { code: applyEdits(code, edits), named };
}

/**
 * Name the vendor bindings in every recovered module of the project, given the bundle each one
 * came from. Rewrites the files in place and returns what it named.
 */
export async function resolveVendorNames(
  projectDir: string,
  files: { file: string; bundle: string }[],
  /** Library classes Stage 4 found inlined into site statements (`analysis/vendor-inline.json`). */
  inlined: { name: string; text: string }[] = [],
): Promise<NamedBinding[]> {
  const extra = new Map<string, t.Node>();
  for (const i of inlined) {
    try {
      const stmt = parseCode(`(${i.text});`).program.body[0];
      if (stmt?.type === "ExpressionStatement") extra.set(i.name, stmt.expression);
    } catch {
      // A fragment that no longer parses alone stays unnamed.
    }
  }
  const bundles = new Map<string, Map<string, t.Node>>();
  const readers = new Map<string, PackageReader>();
  const readerOf = (pkg: string) => {
    let r = readers.get(pkg);
    if (!r) {
      r = new PackageReader(projectDir, pkg);
      readers.set(pkg, r);
    }
    return r;
  };
  const out: NamedBinding[] = [];
  for (const { file, bundle } of files) {
    const code = await readFile(file, "utf8").catch(() => undefined);
    if (code === undefined || !/import \* as [\w$]+ from "[^.]/.test(code)) continue;
    let decls = bundles.get(bundle);
    if (!decls) {
      decls = bundleDeclarations(await readFile(bundle, "utf8").catch(() => ""));
      for (const [k, v] of extra) decls.set(k, v);
      bundles.set(bundle, decls);
    }
    const result = await nameVendorBindings(code, decls, readerOf);
    if (result.named.length === 0) continue;
    await writeFile(file, result.code);
    for (const n of result.named) out.push({ file, ...n });
  }
  return out;
}
