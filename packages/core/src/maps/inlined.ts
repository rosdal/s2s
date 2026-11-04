import path from "node:path";
import { type ParserPlugin, parse } from "@babel/parser";
import type * as t from "@babel/types";
import { parseCode, traverse } from "../unbundle/ast.js";
import type { LogicalMap } from "./load.js";

const posix = path.posix;

/**
 * Modules the bundle inlined as plain data, which no map lists: Vite's JSON plugin emits no
 * mappings, so `import en from "./locales/en.json"` leaves an object literal in the chunk and no
 * `en.json` among the sources; a module tree-shaken down to `import * as ns` leaves only its
 * namespace object. The importer's map still points each use of the import at the generated
 * binding, and a binding whose value is data can be written back as the file.
 */
export interface InlinedFile {
  /** Path under `recovered/sourcemap/`. */
  path: string;
  content: string;
  /** The recovered source whose import it answers. */
  importer: string;
  /** The generated binding it was read from. */
  binding: string;
}

export interface InlinedSource {
  /** Index of the source in the map. */
  index: number;
  /** Where the source was written under `recovered/sourcemap/`. */
  output: string;
  content: string;
}

const RESOLVE = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".vue", ".svelte"];
const INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
const STYLE = /\.(?:css|s[ac]ss|less|styl)$/i;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const FAIL = Symbol("not data");
type Value = Json | typeof FAIL;

function parseSource(text: string, file: string): t.File | undefined {
  const plugins: ParserPlugin[] = /\.[mc]?tsx?$/i.test(file)
    ? ["typescript", ...(/x$/i.test(file) ? (["jsx"] as const) : [])]
    : ["jsx"];
  try {
    return parse(text, { sourceType: "module", errorRecovery: true, plugins }) as unknown as t.File;
  } catch {
    return undefined;
  }
}

/**
 * Recover what the sources of one map import but nothing recovered holds. `known` holds every
 * recovered path, lower case. `code` is the generated file the map belongs to.
 */
export function recoverInlined(
  map: LogicalMap,
  code: string,
  sources: InlinedSource[],
  known: Set<string>,
): InlinedFile[] {
  const resolves = (target: string) => {
    const key = target.toLowerCase();
    return RESOLVE.some((ext) => known.has(key + ext)) || INDEX.some((ext) => known.has(key + ext));
  };
  let chunk: { bindings: Map<string, t.Expression>; lines: string[] } | null | undefined;
  const chunkOf = () => {
    if (chunk !== undefined) return chunk;
    try {
      chunk = { bindings: topLevelBindings(parseCode(code)), lines: code.split("\n") };
    } catch {
      chunk = null;
    }
    return chunk;
  };
  // Original position to the generated positions mapped from it, with the segment's name.
  let reverse: Map<number, Map<string, [number, number, string | undefined][]>> | undefined;
  const generatedAt = (sourceIndex: number, line: number, column: number, name: string) => {
    if (!reverse) {
      reverse = new Map();
      for (const [genLine, segments] of map.mappings.entries()) {
        for (const s of segments) {
          if (s.length < 4) continue;
          const [genColumn, index, l, c] = s as [number, number, number, number];
          const bySource = reverse.get(index) ?? new Map();
          reverse.set(index, bySource);
          const key = `${l}:${c}`;
          const list = bySource.get(key) ?? [];
          list.push([genLine, genColumn, s.length === 5 ? map.names[s[4]] : undefined]);
          bySource.set(key, list);
        }
      }
    }
    const candidates = reverse.get(sourceIndex)?.get(`${line}:${column}`) ?? [];
    // Several identifiers can share a statement's position; the segment naming this one decides.
    const named = candidates.find((c) => c[2] === name);
    if (named) return named;
    return candidates.some((c) => c[2] !== undefined) ? undefined : candidates[0];
  };

  const out: InlinedFile[] = [];
  const done = new Set<string>();
  for (const source of sources) {
    if (!/import\s/.test(source.content)) continue;
    const ast = parseSource(source.content, source.output);
    if (!ast) continue;
    const wanted = new Map<string, { target: string; namespace: boolean }>();
    for (const node of ast.program.body) {
      if (node.type !== "ImportDeclaration" || node.importKind === "type") continue;
      const spec = node.source.value;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const target = posix.normalize(posix.join(posix.dirname(source.output), spec));
      if (target.startsWith("..") || STYLE.test(target) || resolves(target)) continue;
      if (done.has(target.toLowerCase())) continue;
      for (const s of node.specifiers) {
        if (s.type === "ImportDefaultSpecifier" || s.type === "ImportNamespaceSpecifier")
          wanted.set(s.local.name, { target, namespace: s.type === "ImportNamespaceSpecifier" });
      }
    }
    if (wanted.size === 0) continue;
    // Each use of a wanted import, in source order; the first that maps to a data binding wins.
    const uses: { name: string; line: number; column: number }[] = [];
    traverse(ast, {
      Identifier(p) {
        const { name, loc } = p.node;
        if (!wanted.has(name) || !loc || !p.isReferencedIdentifier()) return;
        if (p.parentPath.isImportSpecifier() || p.parentPath.isImportDefaultSpecifier()) return;
        uses.push({ name, line: loc.start.line - 1, column: loc.start.column });
      },
    });
    for (const use of uses) {
      const want = wanted.get(use.name);
      if (!want || done.has(want.target.toLowerCase())) continue;
      const at = generatedAt(source.index, use.line, use.column, use.name);
      const c = at && chunkOf();
      if (!at || !c) continue;
      const binding = /^[A-Za-z_$][\w$]*/.exec(c.lines[at[0]]?.slice(at[1]) ?? "")?.[0];
      if (!binding) continue;
      const file = writeBack(want.target, binding, c.bindings, want.namespace, source.output);
      if (!file) continue;
      done.add(want.target.toLowerCase());
      out.push({ ...file, importer: source.output, binding });
    }
  }
  return out;
}

function writeBack(
  target: string,
  binding: string,
  bindings: Map<string, t.Expression>,
  namespace: boolean,
  importer: string,
): { path: string; content: string } | undefined {
  const init = bindings.get(binding);
  if (!init) return undefined;
  const ns = namespaceProperties(init, bindings);
  if (/\.json$/i.test(target)) {
    // A JSON module's namespace holds the parsed file as `default` next to its named exports.
    const value = ns ? (ns.default ?? FAIL) : evaluate(init, bindings, 0);
    if (value === FAIL) return undefined;
    return { path: target, content: `${JSON.stringify(value, null, 2)}\n` };
  }
  if (!namespace || !ns) return undefined;
  const lines = [
    "// s2s: no source map held this module; it is rebuilt from the namespace object the bundle",
    "// kept for it. Exports the bundle dropped as unused are missing.",
  ];
  for (const [name, value] of Object.entries(ns)) {
    if (value === FAIL) return undefined;
    const literal = JSON.stringify(value, null, 2);
    lines.push(
      name === "default" ? `export default ${literal};` : `export const ${name} = ${literal};`,
    );
  }
  if (Object.keys(ns).length === 0) lines.push("export {};");
  const ext = /\.[mc]?tsx?$/i.test(importer) ? ".ts" : ".js";
  return {
    path: /\.[mc]?[jt]sx?$/i.test(target) ? target : `${target}${ext}`,
    content: `${lines.join("\n")}\n`,
  };
}

/** `const` / `let` / `var` declarations at the top of a chunk, by name. */
function topLevelBindings(ast: t.File): Map<string, t.Expression> {
  const out = new Map<string, t.Expression>();
  for (const node of ast.program.body) {
    const decl =
      node.type === "VariableDeclaration"
        ? node
        : node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration"
          ? node.declaration
          : undefined;
    // A `let` can be reassigned, so its initial value is not what the file held.
    if (decl?.kind === "let") continue;
    for (const d of decl?.declarations ?? []) {
      if (d.id.type === "Identifier" && d.init && !out.has(d.id.name)) out.set(d.id.name, d.init);
    }
  }
  return out;
}

/**
 * The properties of a bundler namespace object (`Object.freeze({__proto__: null, a: x})`, maybe
 * wrapped in `Object.defineProperty(..., Symbol.toStringTag, ...)`), evaluated; undefined for
 * anything else. A property that is not data evaluates to FAIL.
 */
function namespaceProperties(
  node: t.Expression,
  bindings: Map<string, t.Expression>,
): Record<string, Value> | undefined {
  const inner = unwrapObjectCalls(node);
  if (inner.type !== "ObjectExpression") return undefined;
  let proto = false;
  const props: Record<string, Value> = {};
  for (const p of inner.properties) {
    if (p.type !== "ObjectProperty" || p.computed) return undefined;
    const key = keyOf(p.key);
    if (key === undefined) return undefined;
    if (key === "__proto__" && p.value.type === "NullLiteral") {
      proto = true;
      continue;
    }
    props[key] = evaluate(p.value as t.Expression, bindings, 0);
  }
  return proto ? props : undefined;
}

function unwrapObjectCalls(node: t.Expression): t.Expression {
  let current = node;
  for (;;) {
    if (
      current.type === "CallExpression" &&
      current.callee.type === "MemberExpression" &&
      current.callee.object.type === "Identifier" &&
      current.callee.object.name === "Object" &&
      current.callee.property.type === "Identifier" &&
      ["freeze", "defineProperty"].includes(current.callee.property.name) &&
      current.arguments[0] &&
      current.arguments[0].type !== "SpreadElement" &&
      current.arguments[0].type !== "ArgumentPlaceholder"
    ) {
      current = current.arguments[0] as t.Expression;
      continue;
    }
    return current;
  }
}

function keyOf(key: t.Node): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  if (key.type === "NumericLiteral") return String(key.value);
  return undefined;
}

/** Evaluate an expression that is pure data: literals, objects, arrays and names bound to them. */
function evaluate(node: t.Node, bindings: Map<string, t.Expression>, depth: number): Value {
  if (depth > 64) return FAIL;
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? FAIL) : FAIL;
    case "UnaryExpression": {
      if (node.operator === "!" && node.argument.type === "NumericLiteral")
        return !node.argument.value; // minifiers write `!0` and `!1`
      const v = evaluate(node.argument, bindings, depth + 1);
      if (typeof v !== "number") return FAIL;
      return node.operator === "-" ? -v : node.operator === "+" ? v : FAIL;
    }
    case "ArrayExpression": {
      const out: Json[] = [];
      for (const el of node.elements) {
        if (!el || el.type === "SpreadElement") return FAIL;
        const v = evaluate(el, bindings, depth + 1);
        if (v === FAIL) return FAIL;
        out.push(v);
      }
      return out;
    }
    case "ObjectExpression": {
      const out: { [key: string]: Json } = {};
      for (const p of node.properties) {
        if (p.type !== "ObjectProperty" || p.computed) return FAIL;
        const key = keyOf(p.key);
        if (key === undefined) return FAIL;
        const v = evaluate(p.value, bindings, depth + 1);
        if (v === FAIL) return FAIL;
        out[key] = v;
      }
      return out;
    }
    case "Identifier": {
      const init = bindings.get(node.name);
      return init ? evaluate(init, bindings, depth + 1) : FAIL;
    }
    case "CallExpression": {
      // `JSON.parse('{...}')`, which bundlers emit for large JSON.
      const callee = node.callee;
      const arg = node.arguments[0];
      if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "JSON" &&
        callee.property.type === "Identifier" &&
        callee.property.name === "parse" &&
        arg?.type === "StringLiteral"
      ) {
        try {
          return JSON.parse(arg.value) as Json;
        } catch {
          return FAIL;
        }
      }
      return FAIL;
    }
    default:
      return FAIL;
  }
}
