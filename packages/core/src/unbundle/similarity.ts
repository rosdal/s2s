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
  /** Share of the source's top-level statements found in the output, 0 to 1, 4 decimals. */
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
  const outputStatements = outputs.map((o) => {
    const counts = new Map<string, number>();
    for (const s of statementsOf(o.code)) counts.set(s, (counts.get(s) ?? 0) + 1);
    return { file: o.file, counts };
  });
  const files: Similarity["files"] = [];
  for (const source of sources) {
    const statements = statementsOf(source.code);
    let best: { module: string | null; found: number } = { module: null, found: 0 };
    for (const o of outputStatements) {
      const left = new Map(o.counts);
      let found = 0;
      for (const s of statements) {
        const n = left.get(s) ?? 0;
        if (n > 0) {
          found++;
          left.set(s, n - 1);
        }
      }
      if (found > best.found) best = { module: o.file, found };
    }
    files.push({
      file: source.file,
      statements: statements.length,
      found: best.found,
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
