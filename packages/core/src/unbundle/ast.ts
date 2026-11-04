import { type ParserOptions, parse } from "@babel/parser";
import traverse, { type Binding, type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

export type { Binding, NodePath };
export { traverse };

const OPTIONS: ParserOptions = {
  sourceType: "unambiguous",
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
  plugins: ["jsx"],
};

/** Parse a bundle or module; throws on syntax errors. */
export function parseCode(code: string): t.File {
  return parse(code, OPTIONS) as unknown as t.File;
}

/** Whether `code` parses as JavaScript (with JSX). */
export function parses(code: string): boolean {
  try {
    parse(code, { ...OPTIONS, errorRecovery: false });
    return true;
  } catch {
    return false;
  }
}

export interface TextEdit {
  /** String indices into the text the edit applies to; `end` is exclusive. */
  start: number;
  end: number;
  text: string;
}

/**
 * Apply edits to the slice `[from, to)` of `text`. Edits outside the slice are ignored, and an
 * edit inside an earlier, wider one is dropped (the wider edit already replaced its text).
 */
export function applyEdits(text: string, edits: TextEdit[], from = 0, to = text.length): string {
  const sorted = edits
    .filter((e) => e.start >= from && e.end <= to)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = from;
  for (const edit of sorted) {
    if (edit.start < cursor) {
      // Two deletions that share a comma (`a(), b()` with both removed) overlap; the second
      // only removes what is left of it.
      if (edit.text === "" && edit.end > cursor) cursor = edit.end;
      continue;
    }
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor, to);
}

export const start = (node: t.Node): number => node.start ?? 0;
export const end = (node: t.Node): number => node.end ?? 0;

/** A `"…"` literal for generated code. */
export const quote = (value: string): string => JSON.stringify(value);

/** Specifier that marks a reference to another module until files are placed. */
export const MODULE_PREFIX = "s2s-module:";
export const moduleSpecifier = (key: string): string => `${MODULE_PREFIX}${key}`;

/** Numeric or string literal value, as module ids are written. */
export function literalValue(node: t.Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "NumericLiteral" || node.type === "StringLiteral") return String(node.value);
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

export function isFunctionNode(
  node: t.Node | null | undefined,
): node is
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ObjectMethod
  | t.FunctionDeclaration {
  return (
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "ObjectMethod" ||
    node?.type === "FunctionDeclaration"
  );
}

/** `x.name` or `x["name"]`, as `name`. */
export function memberName(node: t.Node): string | undefined {
  if (node.type !== "MemberExpression") return undefined;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return literalValue(node.property);
}

/**
 * Edits that remove an expression used as a statement: the whole statement when the expression is
 * all of it, the element and its comma inside a sequence, or `void 0` anywhere else.
 */
export function removeExpression(path: NodePath): TextEdit {
  const parent = path.parentPath;
  const node = path.node;
  if (parent?.isExpressionStatement()) {
    return { start: start(parent.node), end: end(parent.node), text: "" };
  }
  if (parent?.isSequenceExpression() && parent.parentPath?.isExpressionStatement()) {
    const items = parent.node.expressions;
    const index = items.indexOf(node as t.Expression);
    if (items.length === 1) {
      const statement = parent.parentPath.node;
      return { start: start(statement), end: end(statement), text: "" };
    }
    const next = items[index + 1];
    const previous = items[index - 1];
    if (next) return { start: start(node), end: start(next), text: "" };
    if (previous) return { start: end(previous), end: end(node), text: "" };
  }
  return { start: start(node), end: end(node), text: "void 0" };
}

/**
 * Edits that rename every occurrence of a binding. Shorthand properties (`{ e }`) keep their key,
 * and shorthand export specifiers keep the exported name.
 */
export function renameBinding(binding: Binding, to: string): TextEdit[] {
  const edits: TextEdit[] = [];
  const from = binding.identifier.name;
  const nodes: t.Identifier[] = [binding.identifier];
  for (const ref of binding.referencePaths)
    if (ref.node.type === "Identifier") nodes.push(ref.node);
  for (const violation of binding.constantViolations) {
    for (const id of Object.values(
      violation.getBindingIdentifiers() as Record<string, t.Identifier>,
    ))
      if (id.name === from) nodes.push(id);
  }
  const seen = new Set<number>();
  for (const id of nodes) {
    const at = start(id);
    if (seen.has(at)) continue;
    seen.add(at);
    edits.push({ start: at, end: at + from.length, text: to });
  }
  // Shorthand `{ e }` becomes `{ e: exports }`, so the key stays put.
  const shorthand = new Set<number>();
  for (const ref of binding.referencePaths) {
    const parent = ref.parent;
    if (parent?.type === "ObjectProperty" && parent.shorthand && parent.value === ref.node)
      shorthand.add(start(ref.node));
  }
  return edits.map((e) => (shorthand.has(e.start) ? { ...e, text: `${from}: ${to}` } : e));
}

/** Converts string indices to UTF-8 byte offsets in one pass over the text. */
export class ByteOffsets {
  readonly #text: string;
  readonly #ascii: boolean;
  #index = 0;
  #bytes = 0;

  constructor(text: string) {
    this.#text = text;
    this.#ascii = Buffer.byteLength(text) === text.length;
  }

  /** Byte offset of a string index; fastest when called with rising indices. */
  of(index: number): number {
    if (this.#ascii) return index;
    if (index < this.#index) {
      this.#index = 0;
      this.#bytes = 0;
    }
    this.#bytes += Buffer.byteLength(this.#text.slice(this.#index, index));
    this.#index = index;
    return this.#bytes;
  }
}
