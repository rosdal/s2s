import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type * as t from "@babel/types";
import { applyEdits, parseCode, type TextEdit, traverse } from "../unbundle/ast.js";

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
  for (const x of statics.get(node) ?? []) tokens.add(x);
  // Only a function or class has structure enough to tell it apart (`require_x()` and
  // `createColorManagement()` are both just a call).
  if (tokens.size === 0 && /Function|Class|Arrow/.test(node.type))
    for (const x of structureOf(node)) tokens.add(x);
  return tokens;
}

/**
 * For a declaration with no names or strings to go on (`useThree(selector = (s) => s, eq)`):
 * its parameter count and the parent-child pairs of its node types, which survive minifying
 * better than names. Only used when nothing else is there to compare.
 */
function structureOf(node: t.Node): Set<string> {
  const out = new Set<string>();
  const params = (node as { params?: unknown[] }).params;
  if (Array.isArray(params)) out.add(`n:${params.length}`);
  const visit = (n: t.Node, parent: string, depth: number) => {
    if (depth > 30) return;
    out.add(`t:${parent}>${n.type}`);
    for (const key of Object.keys(n) as (keyof typeof n)[]) {
      if (key === "loc" || key === "start" || key === "end" || key === "leadingComments") continue;
      const value = n[key] as unknown;
      const kids = Array.isArray(value) ? value : [value];
      for (const v of kids)
        if (v && typeof v === "object" && "type" in v) visit(v as t.Node, n.type, depth + 1);
    }
  };
  visit(node, "", 0);
  return out;
}

/**
 * What a function's top-level static assignments (`useGLTF.preload = (path, draco) => …`) add to
 * its shape: the property names, and the parameter counts of the function and each static, as a
 * hook's body alone is often too small to tell it from its siblings (`useFBX.preload`).
 */
const statics = new WeakMap<t.Node, Set<string>>();

const arity = (n: t.Node | null | undefined): number | null =>
  n &&
  (n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression")
    ? n.params.length
    : null;

function collectStatics(body: t.Statement[], out: Map<string, t.Node>): void {
  const assignments = (e: t.Expression): t.AssignmentExpression[] =>
    e.type === "SequenceExpression"
      ? e.expressions.flatMap(assignments)
      : e.type === "AssignmentExpression"
        ? [e]
        : [];
  for (const node of body) {
    if (node.type !== "ExpressionStatement") continue;
    for (const a of assignments(node.expression)) {
      const left = a.left;
      if (
        left.type !== "MemberExpression" ||
        left.computed ||
        left.object.type !== "Identifier" ||
        left.property.type !== "Identifier"
      )
        continue;
      const decl = out.get(left.object.name);
      const own = arity(decl);
      if (!decl || own === null) continue;
      const set = statics.get(decl) ?? new Set<string>([`n:${own}`]);
      set.add(`p:${left.property.name}`);
      const theirs = arity(a.right);
      if (theirs !== null) set.add(`n:${left.property.name}:${theirs}`);
      statics.set(decl, set);
    }
  }
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
  // `var kK; … kK = EK.createRoot`: a binding declared bare stands for what it is first assigned.
  for (const node of ast.program.body) {
    if (node.type !== "ExpressionStatement") continue;
    const all = (e: t.Expression): t.Expression[] =>
      e.type === "SequenceExpression" ? e.expressions.flatMap(all) : [e];
    for (const e of all(node.expression))
      if (
        e.type === "AssignmentExpression" &&
        e.operator === "=" &&
        e.left.type === "Identifier" &&
        !out.has(e.left.name)
      )
        out.set(e.left.name, e.right);
  }
  collectStatics(ast.program.body, out);
  return out;
}

/** Parse a bundle once and keep its top-level declarations. */
export function bundleDeclarations(code: string): Map<string, t.Node> {
  try {
    const out = declarations(parseCode(code));
    for (const node of out.values()) homeOf.set(node, out);
    return out;
  } catch {
    return new Map();
  }
}

/** The bundle's declarations each declaration came from, for ordering look-alikes. */
const homeOf = new WeakMap<t.Node, Map<string, t.Node>>();

/** A bundle's imports of other chunks (`import { k as j } from "./vendor.js"`) and its exports. */
export function bundleLinks(code: string): {
  imports: { local: string; imported: string; source: string }[];
  exports: Map<string, string>;
} {
  const imports: { local: string; imported: string; source: string }[] = [];
  const exports = new Map<string, string>();
  try {
    for (const node of parseCode(code).program.body) {
      if (node.type === "ImportDeclaration" && node.source.value.startsWith("."))
        for (const s of node.specifiers)
          if (s.type === "ImportSpecifier")
            imports.push({
              local: s.local.name,
              imported: nameOf(s.imported),
              source: node.source.value,
            });
      if (node.type === "ExportNamedDeclaration" && !node.source)
        for (const s of node.specifiers)
          if (s.type === "ExportSpecifier") exports.set(nameOf(s.exported), nameOf(s.local));
    }
  } catch {
    // An unparsable bundle links nothing.
  }
  return { imports, exports };
}

export const MIN_SIMILARITY = 0.55;
/** A binding named from a library other than the one Stage 4 filed it under needs a closer match. */
export const CROSS_PACKAGE_SIMILARITY = 0.8;
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
  // A structure-only shape (`(fn) => push(fn, list)`) is shared by look-alike exports
  // (`addEffect`, `addTail`): an identical one there is a tie.
  const structural = [...best.shape].every((x) => x.startsWith("t:") || x.startsWith("n:"));
  const rival = scored.find(
    (e) => e !== best && (structural ? e.name !== "default" : jaccard(e.shape, best.shape) < 1),
  );
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
        if (out.size === 0) await this.#commonJs(file, mod.ast.program.body, out, depth);
        return out;
      })();
      this.#exports.set(file, known);
    }
    return known;
  }

  /**
   * A CommonJS module's exports: `module.exports = …` is the default (a `require` of a sibling
   * passes through, taking the production branch of a `NODE_ENV` check), `exports.x = …` a name.
   */
  async #commonJs(
    file: string,
    body: t.Statement[],
    out: Map<string, Shape>,
    depth: number,
  ): Promise<void> {
    for (const node of body) {
      if (node.type === "IfStatement") {
        const test = node.test;
        if (
          test.type !== "BinaryExpression" ||
          ![test.left, test.right].some(
            (x) => x.type === "StringLiteral" && x.value === "production",
          )
        )
          continue;
        const branch =
          test.operator === "===" || test.operator === "==" ? node.consequent : node.alternate;
        if (branch)
          await this.#commonJs(
            file,
            branch.type === "BlockStatement" ? branch.body : [branch],
            out,
            depth,
          );
        continue;
      }
      if (node.type !== "ExpressionStatement") continue;
      const e = node.expression;
      if (e.type !== "AssignmentExpression" || e.operator !== "=") continue;
      const left = e.left;
      if (left.type !== "MemberExpression" || left.computed) continue;
      const target =
        left.object.type === "Identifier" &&
        left.object.name === "module" &&
        left.property.type === "Identifier" &&
        left.property.name === "exports"
          ? "default"
          : left.object.type === "Identifier" &&
              left.object.name === "exports" &&
              left.property.type === "Identifier"
            ? left.property.name
            : null;
      if (!target) continue;
      const right = e.right;
      if (
        target === "default" &&
        right.type === "CallExpression" &&
        right.callee.type === "Identifier" &&
        right.callee.name === "require" &&
        right.arguments[0]?.type === "StringLiteral"
      ) {
        const next = this.#resolve(file, right.arguments[0].value);
        if (next) for (const [k, v] of await this.exportsOf(next, depth + 1)) out.set(k, v);
        continue;
      }
      const shape = await this.#deref(file, right, depth + 1);
      if (shape) out.set(target, shape);
    }
  }

  /**
   * `names` in the order the package's source declares them, looking through the entry and the
   * modules it imports from; null when one isn't found.
   */
  async declarationOrder(names: string[]): Promise<string[] | null> {
    const entry = await this.entry();
    if (!entry) return null;
    const files = [entry];
    const text = await readFile(entry, "utf8").catch(() => "");
    for (const m of text.matchAll(/from\s*["'](\.[^"']+)["']/g)) {
      const next = this.#resolve(entry, m[1] as string);
      if (next && !files.includes(next)) files.push(next);
    }
    const found: { name: string; file: number; at: number }[] = [];
    for (const name of names) {
      const re = new RegExp(`\\b(?:const|let|var|function)\\s+${name.replace(/\$/g, "\\$")}\\b`);
      let hit: { name: string; file: number; at: number } | undefined;
      for (const [i, file] of files.entries()) {
        const at = (await readFile(file, "utf8").catch(() => "")).search(re);
        if (at >= 0) {
          hit = { name, file: i, at };
          break;
        }
      }
      if (!hit) return null;
      found.push(hit);
    }
    return found.sort((a, b) => a.file - b.file || a.at - b.at).map((f) => f.name);
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
        // Raw source files (`three/src/*`) are a second copy of what the entry bundles; importing
        // from them would load the library twice.
        if (/^\.\/src(?:\/|$)/.test(String(pickTarget(value) ?? ""))) continue;
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
  /** The project's other dependencies, tried by their entry when no imported library fits. */
  projectPkgs: string[] = [],
  /** The bundle's text, to copy small helpers no package exports, and names not to copy. */
  bundleCode = "",
  notCopied: Set<string> = new Set(),
): Promise<{ code: string; named: Omit<NamedBinding, "file">[]; copied: string[] }> {
  let ast: t.File;
  try {
    ast = parseCode(code);
  } catch {
    return { code, named: [], copied: [] };
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
  if (namespaces.size === 0) return { code, named: [], copied: [] };
  // `const ns = { ...ns$0, ...ns$1 }`: one library read through its entry and a subpath.
  const merged = new Map<string, { pkgs: string[]; node: t.VariableDeclaration }>();
  for (const node of ast.program.body) {
    if (node.type !== "VariableDeclaration" || node.declarations.length !== 1) continue;
    const d = node.declarations[0] as t.VariableDeclarator;
    if (d.id.type !== "Identifier" || d.init?.type !== "ObjectExpression") continue;
    const parts = d.init.properties.map((p) =>
      p.type === "SpreadElement" && p.argument.type === "Identifier"
        ? namespaces.get(p.argument.name)?.pkg
        : undefined,
    );
    if (parts.length > 0 && parts.every(Boolean))
      merged.set(d.id.name, { pkgs: parts as string[], node });
  }
  // `const __vendor_x$chunk = __vendor_x`: another chunk's view of a library, read as the library.
  for (const node of ast.program.body) {
    if (node.type !== "VariableDeclaration" || node.declarations.length !== 1) continue;
    const d = node.declarations[0] as t.VariableDeclarator;
    if (
      d.id.type !== "Identifier" ||
      !d.id.name.startsWith("__vendor") ||
      d.init?.type !== "Identifier"
    )
      continue;
    const target = d.init.name;
    const pkgs =
      merged.get(target)?.pkgs ??
      (namespaces.has(target) ? [namespaces.get(target)?.pkg as string] : null);
    if (pkgs) merged.set(d.id.name, { pkgs, node });
  }
  const pkgsOf = (ns: string): string[] =>
    merged.get(ns)?.pkgs ?? [(namespaces.get(ns) as { pkg: string }).pkg];
  const aliases: {
    decl: t.VariableDeclaration;
    parts: { id: string; ns: string | null; text: string }[];
  }[] = [];
  for (const node of ast.program.body) {
    if (node.type !== "VariableDeclaration") continue;
    const parts = node.declarations.map((d) => {
      const ns =
        d.init?.type === "Identifier" && (namespaces.has(d.init.name) || merged.has(d.init.name))
          ? d.init.name
          : null;
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
  const pkgs = [...new Set([...namespaces.values()].map((n) => n.pkg))];
  const tryName = async (local: string, own: string[]) => {
    const decl = deref(bundle.get(local));
    if (!decl) return;
    // `EK.createRoot`: a library object's member is that export, by name.
    if (decl.type === "MemberExpression" && !decl.computed && decl.property.type === "Identifier") {
      const name = decl.property.name;
      for (const pkg of own) {
        const root = pkg.startsWith("@") ? pkg.split("/").slice(0, 2).join("/") : pkg.split("/")[0];
        const reader = readerOf(root as string);
        // The entry first, then the library's other modules (`jsx` is `react/jsx-runtime`'s).
        const entry = pkg === root ? await reader.entry() : undefined;
        const others = await reader.subpaths([name]);
        const files: [string, string][] = [
          ...(entry ? [[pkg, entry] as [string, string]] : []),
          ...others.filter(([spec]) => spec === pkg),
          ...(pkg === root ? others : []),
        ];
        for (const [specifier, file] of files)
          if ((await reader.exportsOf(file)).has(name)) {
            resolved.set(local, { specifier, name, score: 1 });
            return;
          }
      }
    }
    const shape = shapeOf(decl);
    for (const pkg of own) {
      const hit =
        (await resolveBinding(readerOf(pkg), shape)) ??
        (await byOrder(readerOf(pkg), decl, shape, bundle));
      if (hit) {
        resolved.set(local, hit);
        return;
      }
    }
    // Stage 4 can file a binding under the wrong library when two were inlined side by side
    // (three's `LoadingManager` under react-dom): try the module's other libraries, on a closer
    // match.
    let best: Resolution | null = null;
    for (const other of pkgs) {
      if (own.includes(other)) continue;
      const alt = await resolveBinding(readerOf(other), shape);
      if (alt && alt.score >= CROSS_PACKAGE_SIMILARITY && (!best || alt.score > best.score))
        best = alt;
    }
    if (!best)
      for (const other of projectPkgs) {
        if (own.includes(other) || pkgs.includes(other)) continue;
        const reader = readerOf(other);
        const entry = await reader.entry();
        if (!entry) continue;
        const exports = [...(await reader.exportsOf(entry))].map(([name, s]) => ({
          name,
          shape: s,
        }));
        const hit = bestExport(shape, exports);
        if (hit && hit.score >= CROSS_PACKAGE_SIMILARITY && (!best || hit.score > best.score))
          best = { specifier: other, ...hit };
      }
    if (best) resolved.set(local, best);
  };
  for (const [local, { pkg }] of namespaces) await tryName(local, [pkg]);
  for (const a of aliases)
    for (const p of a.parts) if (p.ns && p.id) await tryName(p.id, pkgsOf(p.ns));
  // A library's internal helper (supabase's `resolveFetch`) is no export: copy its definition from
  // the bundle when it is a small function whose free names are globals or this module's own.
  const copies = new Map<string, string>();
  // Helpers copied only as another copy's dependency, declared before the alias that needs them.
  const helpers = new Map<string, string>();
  const before = new Map<t.VariableDeclaration, string[]>();
  // Copies that run on load (a call), and where each top-level name of the module is declared.
  const eager = new Set<string>();
  const eagerDeps: { name: string; decl: t.VariableDeclaration }[] = [];
  const declaredEnd = new Map<string, number>();
  for (const node of ast.program.body) {
    const names =
      node.type === "VariableDeclaration"
        ? node.declarations.flatMap((d) => (d.id.type === "Identifier" ? [d.id.name] : []))
        : (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id
          ? [node.id.name]
          : [];
    for (const n of names) declaredEnd.set(n, node.end ?? 0);
  }
  if (bundleCode) {
    const own = new Set<string>();
    for (const node of ast.program.body) {
      if (node.type === "ImportDeclaration") {
        for (const sp of node.specifiers) own.add(sp.local.name);
      } else if (node.type === "VariableDeclaration") {
        for (const d of node.declarations) if (d.id.type === "Identifier") own.add(d.id.name);
      } else if (
        (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
        node.id
      ) {
        own.add(node.id.name);
      }
    }
    const helperText = (name: string): string | null => {
      if (notCopied.has(name)) return null;
      const decl = bundle.get(name);
      // A class without `extends` is as lazy as a function (`class Semver {…}`).
      const fn =
        decl?.type === "ArrowFunctionExpression" ||
        decl?.type === "FunctionExpression" ||
        decl?.type === "FunctionDeclaration" ||
        ((decl?.type === "ClassDeclaration" || decl?.type === "ClassExpression") &&
          !decl.superClass);
      // `var _w = Object.prototype.hasOwnProperty`: a global's member, safe to read again.
      const globalMember = (n: t.Node): boolean =>
        n.type === "MemberExpression"
          ? !n.computed && globalMember(n.object)
          : n.type === "Identifier" && !bundle.has(n.name);
      // `UM = React.createContext(null)`: a library's own singleton nothing exports. It runs on
      // load, so it is placed after what it reads (see `eager`).
      // Not the bundler's own helpers (`__exportAll({...})` is a package's namespace object).
      const call =
        (decl?.type === "CallExpression" || decl?.type === "NewExpression") &&
        !(decl.callee.type === "Identifier" && decl.callee.name.startsWith("__"));
      // `var PREFIX = "tp"`: a constant, safe to have twice.
      const literal =
        decl?.type === "StringLiteral" ||
        decl?.type === "NumericLiteral" ||
        decl?.type === "BooleanLiteral" ||
        (decl?.type === "TemplateLiteral" && decl.expressions.length === 0);
      if (
        !decl ||
        !(fn || call || literal || globalMember(decl)) ||
        decl.start == null ||
        decl.end == null
      )
        return null;
      const text = bundleCode.slice(decl.start, decl.end);
      if (text.length > MAX_COPIED_HELPER) return null;
      if (call) eager.add(name);
      return text;
    };
    // The helper and the bundle helpers it reads that this module lacks (`__spreadValues` reads
    // `__defNormalProp`), dependencies first; null when any of them can't be copied.
    const closure = (name: string, stack: Set<string>): string[] | null => {
      const text = helperText(name);
      const free = text === null ? null : freeNames(text);
      if (!free) return null;
      const order: string[] = [];
      for (const n of free) {
        if (n === name || own.has(n) || !bundle.has(n) || stack.has(n) || order.includes(n))
          continue;
        const sub = closure(n, new Set([...stack, name]));
        if (!sub || order.length + sub.length > MAX_COPIED_DEPS) return null;
        for (const x of sub) if (!order.includes(x)) order.push(x);
      }
      order.push(name);
      return order;
    };
    for (const a of aliases)
      for (const p of a.parts) {
        if (!p.ns || !p.id || resolved.has(p.id)) continue;
        const order = closure(p.id, new Set());
        if (!order) continue;
        for (const n of order) {
          if (n === p.id || own.has(n)) continue;
          helpers.set(n, helperText(n) as string);
          own.add(n);
          if (eager.has(n)) eagerDeps.push({ name: n, decl: a.decl });
          else before.set(a.decl, [...(before.get(a.decl) ?? []), n]);
        }
        copies.set(p.id, helperText(p.id) as string);
      }
  }
  if (resolved.size === 0 && copies.size === 0) return { code, named: [], copied: [] };

  const edits: TextEdit[] = [];
  const named: Omit<NamedBinding, "file">[] = [];
  // A copy's on-load dependencies (`JM = createContext(null)` under `wP = () => useContext(JM)`)
  // go after what they read: in the alias statement's own rewrite when that is late enough (an
  // insert right behind it would collide with the next alias's rewrite), else after the
  // statement that declares the last name they read.
  const inlineEager = new Map<t.VariableDeclaration, string[]>();
  const lateEager: { name: string; at: number }[] = [];
  for (const { name, decl } of eagerDeps) {
    const at = Math.max(
      0,
      ...(freeNames(helpers.get(name) as string) ?? []).map((n) => declaredEnd.get(n) ?? 0),
    );
    if (at <= (decl.end ?? 0)) inlineEager.set(decl, [...(inlineEager.get(decl) ?? []), name]);
    else lateEager.push({ name, at });
  }
  const stillRead = new Set<string>();
  for (const a of aliases) {
    let changed = false;
    const kept: string[] = [];
    // A copied `function en() { return en = … }` stays a declaration: it may reassign itself.
    const declared: string[] = [];
    for (const p of a.parts) {
      if (p.ns && p.id && resolved.has(p.id)) {
        changed = true;
        continue;
      }
      const copy = copies.get(p.id);
      if (copy && eager.has(p.id)) {
        // After the last statement declaring a name it reads, so those are set when it runs.
        const at = Math.max(
          a.decl.end ?? 0,
          ...(freeNames(copy) ?? []).map((n) => declaredEnd.get(n) ?? 0),
        );
        if (at > (a.decl.end ?? 0)) {
          edits.push({ start: at, end: at, text: `\nconst ${p.id} = ${copy};` });
          changed = true;
          continue;
        }
      }
      if (copy) {
        if (/^(Function|Class)Declaration$/.test(bundle.get(p.id)?.type ?? "")) declared.push(copy);
        else kept.push(`${p.id} = ${copy}`);
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
        text: [
          ...(before.get(a.decl) ?? []).map((n) => {
            const text = helpers.get(n) as string;
            return /^(Function|Class)Declaration$/.test(bundle.get(n)?.type ?? "")
              ? text
              : `const ${n} = ${text};`;
          }),
          kept.length === 0 ? "" : `${a.decl.kind} ${kept.join(",\n  ")};`,
          ...declared,
          ...(inlineEager.get(a.decl) ?? []).map(
            (n) => `const ${n} = ${helpers.get(n) as string};`,
          ),
        ]
          .filter(Boolean)
          .join("\n"),
      });
  }
  for (const { name, at } of lateEager)
    edits.push({ start: at, end: at, text: `\nconst ${name} = ${helpers.get(name) as string};` });
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
  for (const [local, { pkgs: own, node }] of merged) {
    const bySpec = new Map<string, string[]>();
    for (const a of aliases)
      for (const p of a.parts) {
        const r = p.ns === local ? resolved.get(p.id) : undefined;
        if (!r) continue;
        named.push({
          package: own[0] as string,
          local: p.id,
          specifier: r.specifier,
          export: r.name,
          score: r.score,
        });
        bySpec.set(r.specifier, [
          ...(bySpec.get(r.specifier) ?? []),
          r.name === "default" ? `default as ${p.id}` : `${r.name} as ${p.id}`,
        ]);
      }
    if (bySpec.size === 0) continue;
    const lines = [code.slice(node.start ?? 0, node.end ?? 0)];
    for (const [spec, names] of bySpec)
      lines.push(`import { ${names.join(", ")} } from ${JSON.stringify(spec)};`);
    edits.push({ start: node.start ?? 0, end: node.end ?? 0, text: lines.join("\n") });
  }
  return {
    code: applyEdits(code, edits),
    named,
    copied: [...copies.keys(), ...[...before.values()].flat(), ...eagerDeps.map((d) => d.name)],
  };
}

/**
 * Look-alike exports with one structure (`addEffect`, `addAfterEffect`, `addTail` are each
 * `(cb) => createSubs(cb, list)`) can't be told apart by shape, but a bundle keeps them in source
 * order: the n-th look-alike in the bundle is the n-th in the package's source.
 */
async function byOrder(
  reader: PackageReader,
  decl: t.Node,
  shape: Shape,
  bundle: Map<string, t.Node>,
): Promise<Resolution | null> {
  if (![...shape].every((x) => x.startsWith("t:") || x.startsWith("n:"))) return null;
  const entry = await reader.entry();
  if (!entry) return null;
  const same = (a: Shape, b: Shape) => a.size === b.size && [...a].every((x) => b.has(x));
  const tied = [...(await reader.exportsOf(entry))]
    .filter(([name, s]) => name !== "default" && same(s, shape))
    .map(([name]) => name);
  if (tied.length < 2) return null;
  const mine = [...new Set((homeOf.get(decl) ?? bundle).values())]
    .filter((n) => same(shapeOf(n), shape))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const at = mine.indexOf(decl);
  if (at < 0 || mine.length > tied.length) return null;
  const positions = await reader.declarationOrder(tied);
  if (!positions) return null;
  const name = positions[at];
  return name ? { specifier: reader.name, name, score: 1 } : null;
}

/** Longest helper copied from the bundle, in characters. */
const MAX_COPIED_HELPER = 2000;
/** Most helpers one copy may bring along. */
const MAX_COPIED_DEPS = 8;

/** The names a function's text reads without declaring, or null when it does not parse alone. */
function freeNames(text: string): string[] | null {
  try {
    const ast = parseCode(`(${text});`);
    let names: string[] = [];
    // A copy that assigns a binding it doesn't declare (wasm-bindgen's heap counter `d`) would
    // write the module's own, possibly `const`, binding: not copied.
    let writes = false;
    const written = (p: { node: t.Node; scope: { hasBinding(n: string): boolean } }) => {
      if (p.node.type === "Identifier" && !p.scope.hasBinding(p.node.name)) writes = true;
    };
    traverse(ast, {
      Program(path) {
        names = Object.keys(path.scope.globals);
      },
      AssignmentExpression(path) {
        written(path.get("left") as never);
      },
      UpdateExpression(path) {
        written(path.get("argument") as never);
      },
    });
    return writes ? null : names;
  } catch {
    return null;
  }
}

/**
 * Name the vendor bindings in every recovered module of the project, given the bundle each one
 * came from. Rewrites the files in place and returns what it named.
 */
export async function resolveVendorNames(
  projectDir: string,
  files: { file: string; bundle: string }[],
  /** Library classes Stage 4 found inlined into site statements (`analysis/vendor-inline.json`). */
  inlined: { name: string; text: string; file?: string }[] = [],
  /** The bundle a chunk import of `bundle` (`./vendor.c4.js`) loads, when it was captured. */
  chunkOf: (bundle: string, spec: string) => string | undefined = () => undefined,
): Promise<NamedBinding[]> {
  const extra = new Map<string, t.Node>();
  // Fragments named by one module's import of another chunk: that module's names alone (the
  // vendor chunk's own `le` is not the index chunk's `le`).
  const local: { module: string; name: string; node: t.Node }[] = [];
  for (const i of inlined) {
    try {
      const stmt = parseCode(`(${i.text});`).program.body[0];
      if (stmt?.type !== "ExpressionStatement") continue;
      if (i.file)
        local.push({
          module: i.file.replace(/^recovered\/unbundled\//, "").replace(/\.[jt]sx?$/, ""),
          name: i.name,
          node: stmt.expression,
        });
      else extra.set(i.name, stmt.expression);
    } catch {
      // A fragment that no longer parses alone stays unnamed.
    }
  }
  const bundles = new Map<string, Map<string, t.Node>>();
  const texts = new Map<string, string>();
  const own = new Map<string, Map<string, t.Node>>();
  const ownDecls = async (bundle: string) => {
    let d = own.get(bundle);
    if (!d) {
      const text = await readFile(bundle, "utf8").catch(() => "");
      texts.set(bundle, text);
      d = bundleDeclarations(text);
      own.set(bundle, d);
    }
    return d;
  };
  // Names a bundle imports from another chunk, which declares them: not copied, as the text
  // lives in that chunk.
  const borrowed = new Map<string, Set<string>>();
  const exportsOf = new Map<string, Map<string, string>>();
  const readers = new Map<string, PackageReader>();
  const readerOf = (pkg: string) => {
    let r = readers.get(pkg);
    if (!r) {
      r = new PackageReader(projectDir, pkg);
      readers.set(pkg, r);
    }
    return r;
  };
  const manifest = await readFile(path.join(projectDir, "package.json"), "utf8")
    .then((x) => JSON.parse(x) as { dependencies?: Record<string, string> })
    .catch(() => ({}) as { dependencies?: Record<string, string> });
  const projectPkgs = Object.keys(manifest.dependencies ?? {});
  const out: NamedBinding[] = [];
  for (const { file, bundle } of files) {
    const code = await readFile(file, "utf8").catch(() => undefined);
    if (code === undefined || !/import \* as [\w$]+ from "[^.]/.test(code)) continue;
    let decls = bundles.get(bundle);
    if (!decls) {
      decls = new Map(await ownDecls(bundle));
      const links = bundleLinks(texts.get(bundle) ?? "");
      const names = new Set<string>();
      for (const i of links.imports) {
        const other = chunkOf(bundle, i.source);
        if (!other || decls.has(i.local)) continue;
        const theirs = await ownDecls(other);
        let exported = exportsOf.get(other);
        if (!exported) {
          exported = bundleLinks(texts.get(other) ?? "").exports;
          exportsOf.set(other, exported);
        }
        const local = exported.get(i.imported);
        const decl = local ? theirs.get(local) : undefined;
        if (decl) {
          decls.set(i.local, decl);
          names.add(i.local);
        }
      }
      borrowed.set(bundle, names);
      // An inlined fragment stands in for a declaration Stage 4 cut out; one another chunk still
      // declares in full (with its statics, `useGLTF.preload = …`) says more.
      for (const [k, v] of extra) if (!names.has(k)) decls.set(k, v);
      bundles.set(bundle, decls);
    }
    const posixFile = file
      .split(path.sep)
      .join("/")
      .replace(/\.[jt]sx?$/, "");
    const mine = local.filter((l) => posixFile.endsWith(`_recovered/${l.module}`));
    let fileDecls = decls;
    if (mine.length > 0) {
      fileDecls = new Map(decls);
      for (const l of mine) if (!borrowed.get(bundle)?.has(l.name)) fileDecls.set(l.name, l.node);
    }
    // Inlined fragments carry offsets into their own text, not the bundle's: never copied.
    const result = await nameVendorBindings(
      code,
      fileDecls,
      readerOf,
      projectPkgs,
      texts.get(bundle) ?? "",
      new Set([...extra.keys(), ...mine.map((l) => l.name), ...(borrowed.get(bundle) ?? [])]),
    );
    if (result.named.length === 0 && result.copied.length === 0) continue;
    await writeFile(file, result.code);
    for (const n of result.named) out.push({ file, ...n });
    for (const local of result.copied)
      out.push({
        file,
        package: "",
        local,
        specifier: "",
        export: "(copied from the bundle)",
        score: 0,
      });
  }
  return out;
}
