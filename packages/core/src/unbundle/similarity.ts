import type * as t from "@babel/types";
import { parseCode } from "./ast.js";

const SKIP = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "comments",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "range",
  "directives",
]);

/**
 * One statement as a canonical string: node types and literal values, with identifiers renamed
 * by first appearance (`$0`, `$1`, …) so minified names compare equal, and formatting gone.
 * `var`/`let`/`const` count as one: restoring `const` is not a different statement.
 */
function canonical(node: t.Node): string {
  const names = new Map<string, string>();
  const walk = (value: unknown): unknown => {
    // Whitespace between JSX tags is formatting.
    if (Array.isArray(value))
      return value
        .filter(
          (v) =>
            !(
              v &&
              typeof v === "object" &&
              (v as { type?: string }).type === "JSXText" &&
              !String((v as { value?: string }).value).trim()
            ),
        )
        .map(walk);
    if (!value || typeof value !== "object") return value;
    const n = value as Record<string, unknown> & { type?: string };
    if (n.type === "JSXText")
      return { type: "JSXText", value: String(n.value).trim().replace(/\s+/g, " ") };
    if (n.type === "Identifier" || n.type === "JSXIdentifier") {
      const name = String(n.name);
      if (!names.has(name)) names.set(name, `$${names.size}`);
      return names.get(name);
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(n)) {
      if (SKIP.has(key)) continue;
      if (n.type === "VariableDeclaration" && key === "kind") continue;
      out[key] = walk(v);
    }
    return out;
  };
  return JSON.stringify(walk(node));
}

/** Top-level statements of a file, unwrapped from `export` and split per declarator. */
export function statementsOf(code: string): string[] {
  let ast: t.File;
  try {
    ast = parseCode(code);
  } catch {
    return [];
  }
  const out: string[] = [];
  const add = (node: t.Statement | t.Declaration) => {
    if (node.type === "VariableDeclaration" && node.declarations.length > 1) {
      for (const d of node.declarations) out.push(canonical({ ...node, declarations: [d] }));
    } else out.push(canonical(node));
  };
  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") continue;
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) add(node.declaration);
      continue;
    }
    if (node.type === "ExportDefaultDeclaration") {
      const d = node.declaration;
      if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration")
        add(d as t.Declaration);
      else out.push(canonical(d));
      continue;
    }
    if (node.type === "ExpressionStatement" && node.expression.type === "StringLiteral") continue;
    add(node);
  }
  return out;
}

export interface Similarity {
  /** Share of the source's top-level statements found in the output (closest match, partial credit), 0 to 1. */
  score: number;
  statements: number;
  found: number;
  files: { file: string; statements: number; found: number; module: string | null }[];
}

/**
 * How much of a fixture's real source comes back: for each source file, the output module that
 * holds the most of its top-level statements, and how many of them it holds. Counting within one
 * module (not across all output) rewards putting a file's code back together, so a split on the
 * real boundaries scores higher than a guess.
 */
export function similarity(
  sources: { file: string; code: string }[],
  outputs: { file: string; code: string }[],
): Similarity {
  const outputStatements = outputs.map((o) => ({
    file: o.file,
    statements: statementsOf(o.code).map(bigrams),
  }));
  const files: Similarity["files"] = [];
  for (const source of sources) {
    const statements = statementsOf(source.code).map(bigrams);
    let best: { module: string | null; found: number } = { module: null, found: 0 };
    for (const o of outputStatements) {
      // Each source statement scores its closest output statement: 1 when equal, a share of
      // shared structure when a minifier merged or rewrote it, 0 when nothing resembles it.
      let found = 0;
      for (const s of statements) {
        let closest = 0;
        for (const c of o.statements) {
          closest = Math.max(closest, dice(s, c));
          if (closest === 1) break;
        }
        found += closest;
      }
      if (found > best.found) best = { module: o.file, found };
    }
    files.push({
      file: source.file,
      statements: statements.length,
      found: Math.round(best.found * 100) / 100,
      module: best.module,
    });
  }
  const total = files.reduce((n, f) => n + f.statements, 0);
  const found = files.reduce((n, f) => n + f.found, 0);
  return {
    score: total === 0 ? 0 : Math.round((found / total) * 10_000) / 10_000,
    statements: total,
    found,
    files,
  };
}

/** Pairs of adjacent tokens of a canonical statement, counted. */
function bigrams(canonicalStatement: string): Map<string, number> {
  const tokens = canonicalStatement.match(/[A-Za-z_][\w]*|\$\d+|-?\d+(?:\.\d+)?|"[^"]*"/g) ?? [];
  const out = new Map<string, number>();
  for (let i = 0; i + 1 < tokens.length; i++) {
    const key = `${tokens[i]} ${tokens[i + 1]}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient of two bigram multisets, 0 to 1. */
function dice(a: Map<string, number>, b: Map<string, number>): number {
  let shared = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const n of a.values()) sizeA += n;
  for (const n of b.values()) sizeB += n;
  if (sizeA + sizeB === 0) return 1;
  for (const [k, n] of a) shared += Math.min(n, b.get(k) ?? 0);
  return (2 * shared) / (sizeA + sizeB);
}
