import { parse } from "@babel/parser";
import traverse, { type Binding, type NodePath, type Scope } from "@babel/traverse";
import * as t from "@babel/types";
import type { LogicalMap } from "./load.js";

export interface SkippedRename {
  from: string;
  to: string;
  line: number;
  column: number;
  reason: string;
}

export interface RenameResult {
  code: string;
  renamed: { from: string; to: string; line: number; column: number }[];
  skipped: SkippedRename[];
  /** Text edits applied to the input, sorted by offset; used to translate positions. */
  edits: TextEdit[];
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Names that are legal identifiers but change meaning when a binding takes them. */
const UNSAFE_TARGETS = new Set(["arguments", "eval", "undefined", "NaN", "Infinity", "globalThis"]);

/**
 * Rename bindings in a minified chunk to the original names its source map records, one binding
 * (declaration and every reference) at a time. A rename is skipped when the new name would
 * collide with or shadow another binding or a global, and the whole chunk is left alone when it
 * uses direct `eval` or `with`, where scopes cannot be trusted.
 *
 * Only exact text ranges change, so the rest of the chunk keeps its bytes.
 */
export function renameFromMap(code: string, map: LogicalMap): RenameResult {
  const ast = parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    errorRecovery: false,
  });

  const namesAt = new Map<string, string>();
  for (const [line, segments] of map.mappings.entries()) {
    for (const segment of segments) {
      if (segment.length === 5) {
        const name = map.names[segment[4]];
        if (name) namesAt.set(`${line + 1}:${segment[0]}`, name);
      }
    }
  }
  const empty: RenameResult = { code, renamed: [], skipped: [], edits: [] };
  if (namesAt.size === 0) return empty;

  const scopes: Scope[] = [];
  const seenScopes = new Set<Scope>();
  const globals = new Set<string>();
  /** Positions of shorthand forms where the text is shared by two names. */
  const shorthand = new Map<number, "property" | "export" | "import">();
  let unsafe: string | undefined;
  let program: NodePath<t.Program> | undefined;

  traverse(ast, {
    enter(path) {
      if (!seenScopes.has(path.scope)) {
        seenScopes.add(path.scope);
        scopes.push(path.scope);
      }
    },
    Program(path) {
      program = path;
    },
    WithStatement() {
      unsafe = "the chunk uses a with statement";
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (t.isIdentifier(callee, { name: "eval" }) && !path.scope.getBinding("eval"))
        unsafe = "the chunk calls eval directly";
    },
    ReferencedIdentifier(path) {
      const node = path.node;
      if (t.isIdentifier(node) && !path.scope.getBinding(node.name)) globals.add(node.name);
    },
    ObjectProperty(path) {
      const { node } = path;
      if (!node.shorthand || node.start == null) return;
      shorthand.set(node.start, "property");
    },
    ExportSpecifier(path) {
      const { local, exported } = path.node;
      if (local.start != null && local.start === exported.start)
        shorthand.set(local.start, "export");
    },
    ImportSpecifier(path) {
      const { local, imported } = path.node;
      if (local.start != null && local.start === imported.start)
        shorthand.set(local.start, "import");
    },
  });
  // Assignments to undeclared names create globals too.
  for (const name of Object.keys(program?.scope.globals ?? {})) globals.add(name);
  if (unsafe) {
    return { ...empty, skipped: [{ from: "*", to: "*", line: 0, column: 0, reason: unsafe }] };
  }
  const isModule = program?.node.sourceType === "module";

  /** Current name of every binding, so later checks see earlier renames. */
  const current = new Map<Binding, string>();
  const byScope = new Map<Scope, Map<string, Binding>>();
  for (const scope of scopes) {
    const names = new Map<string, Binding>();
    for (const [name, binding] of Object.entries(scope.bindings)) {
      if (binding.scope !== scope) continue;
      names.set(name, binding);
      current.set(binding, name);
    }
    byScope.set(scope, names);
  }
  const takenIn = (scope: Scope, name: string, self: Binding): boolean => {
    const other = byScope.get(scope)?.get(name);
    return other !== undefined && other !== self;
  };

  const renamed: RenameResult["renamed"] = [];
  const skipped: SkippedRename[] = [];
  const edits: TextEdit[] = [];

  for (const scope of scopes) {
    const bindings = [...(byScope.get(scope)?.values() ?? [])].sort(
      (a, b) => (a.identifier.start ?? 0) - (b.identifier.start ?? 0),
    );
    for (const binding of bindings) {
      const from = current.get(binding) ?? binding.identifier.name;
      const id = binding.identifier;
      const line = id.loc?.start.line ?? 0;
      const column = id.loc?.start.column ?? 0;
      const target = originalName(binding, namesAt);
      if (!target || target === from) continue;
      const skip = (reason: string) => skipped.push({ from, to: target, line, column, reason });

      if (!t.isValidIdentifier(target, true) || UNSAFE_TARGETS.has(target)) {
        skip("not a usable identifier");
        continue;
      }
      if (isExported(binding)) {
        skip("exported by name; renaming would change the module's exports");
        continue;
      }
      if (!isModule && binding.scope === program?.scope) {
        skip("top-level binding of a classic script is a global other scripts may use");
        continue;
      }
      if (globals.has(target)) {
        skip(`would shadow the global ${target}`);
        continue;
      }
      let blocked: string | undefined;
      for (let s: Scope | undefined = binding.scope; s; s = s.parent) {
        if (takenIn(s, target, binding)) {
          blocked =
            s === binding.scope
              ? "collides with a binding in the same scope"
              : "would shadow an outer binding";
          break;
        }
      }
      const occurrences = collectOccurrences(binding, from);
      if (!blocked && !occurrences) blocked = "could not find every occurrence";
      if (!blocked && occurrences) {
        for (const occurrence of occurrences) {
          for (
            let s: Scope | undefined = occurrence.scope;
            s && s !== binding.scope;
            s = s.parent
          ) {
            if (takenIn(s, target, binding)) {
              blocked = "a reference would be captured by an inner binding";
              break;
            }
          }
          if (blocked) break;
        }
      }
      if (blocked || !occurrences) {
        skip(blocked ?? "unknown");
        continue;
      }

      for (const occurrence of occurrences) {
        const { node } = occurrence;
        const start = node.start as number;
        const end = start + from.length;
        if (code.slice(start, end) !== from) {
          blocked = "source text does not match the binding name";
          break;
        }
      }
      if (blocked) {
        skip(blocked);
        continue;
      }
      for (const occurrence of occurrences) {
        const start = occurrence.node.start as number;
        const original = occurrence.node.name;
        const form = shorthand.get(start);
        const text =
          form === "property"
            ? `${original}: ${target}`
            : form === "export"
              ? `${target} as ${original}`
              : form === "import"
                ? `${original} as ${target}`
                : target;
        edits.push({ start, end: start + original.length, text });
      }
      byScope.get(binding.scope)?.delete(from);
      byScope.get(binding.scope)?.set(target, binding);
      current.set(binding, target);
      renamed.push({ from, to: target, line, column });
    }
  }

  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out += code.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += code.slice(cursor);
  return { code: out, renamed, skipped, edits };
}

interface Occurrence {
  node: t.Identifier;
  scope: Scope;
}

/** The name the map gives the declaration, or else the one most references agree on. */
function originalName(binding: Binding, namesAt: Map<string, string>): string | undefined {
  const key = (node: t.Node) => `${node.loc?.start.line}:${node.loc?.start.column}`;
  const declared = namesAt.get(key(binding.identifier));
  if (declared) return declared;
  const votes = new Map<string, number>();
  for (const ref of binding.referencePaths) {
    const name = namesAt.get(key(ref.node));
    if (name) votes.set(name, (votes.get(name) ?? 0) + 1);
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function isExported(binding: Binding): boolean {
  for (let p: NodePath | null = binding.path; p; p = p.parentPath) {
    if (p.isExportNamedDeclaration() || p.isExportDefaultDeclaration()) return true;
    if (p.isStatement() && !p.isVariableDeclaration()) return false;
  }
  return false;
}

/**
 * Every identifier node that names this binding: the declaration, references, and the targets of
 * reassignments. Returns `undefined` when an occurrence is not a plain identifier.
 */
function collectOccurrences(binding: Binding, name: string): Occurrence[] | undefined {
  const found = new Map<number, Occurrence>();
  const add = (node: t.Node | null | undefined, scope: Scope): boolean => {
    if (!node) return true;
    if (!t.isIdentifier(node) || node.start == null) return false;
    if (node.name !== name) return true;
    found.set(node.start, { node, scope });
    return true;
  };
  if (!add(binding.identifier, binding.scope)) return undefined;
  for (const ref of binding.referencePaths) {
    if (!add(ref.node, ref.scope)) return undefined;
  }
  for (const violation of binding.constantViolations) {
    const node = violation.node;
    let targets: t.Node[] = [];
    if (t.isAssignmentExpression(node)) targets = idsOf(node.left);
    else if (t.isUpdateExpression(node)) targets = [node.argument];
    else if (t.isForInStatement(node) || t.isForOfStatement(node)) targets = idsOf(node.left);
    else if (t.isVariableDeclarator(node)) targets = idsOf(node.id);
    else if (t.isFunctionDeclaration(node) || t.isClassDeclaration(node))
      targets = node.id ? [node.id] : [];
    else targets = idsOf(node);
    for (const target of targets) {
      if (t.isIdentifier(target) && target.name === name && !add(target, violation.scope))
        return undefined;
    }
  }
  return [...found.values()];
}

function idsOf(node: t.Node): t.Node[] {
  return Object.values(t.getBindingIdentifiers(node, true) as Record<string, t.Node[]>).flat();
}

/**
 * Shift a 1-based line / 0-based column in the input to where it sits after the edits. Edits
 * never contain newlines, so only edits earlier on the same line move the column.
 */
export function shiftPosition(
  lineStarts: number[],
  edits: TextEdit[],
  line: number,
  column: number,
): { line: number; column: number } {
  const lineStart = lineStarts[line - 1] ?? 0;
  const offset = lineStart + column;
  let delta = 0;
  for (const edit of edits) {
    if (edit.start >= offset) break;
    if (edit.start >= lineStart) delta += edit.text.length - (edit.end - edit.start);
  }
  return { line, column: column + delta };
}

export function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}
