import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { format } from "prettier";
import { webcrack } from "webcrack";
import { applyEdits, end, memberName, parseCode, start, type TextEdit, traverse } from "./ast.js";
import { dropUnusedHelpers, restoreBabel } from "./legacy.js";

/**
 * Everything Stage 4 borrows from webcrack, wakaru and Prettier goes through this interface, so
 * either library can be swapped or forked without touching the pipeline. Each method takes code
 * and returns code; none of them reads or writes files.
 */
export interface LibraryAdapter {
  /** String-array decoding and simple control-flow unflattening. */
  deobfuscate(code: string): Promise<string>;
  /** `!0` to `true`, comma sequences split, ternary and `&&` statements back to `if`, … */
  unminify(code: string): Promise<string>;
  /** Babel and TypeScript helpers back to syntax: classes, spread, async/await, `?.`, `??`. */
  detranspile(code: string): Promise<string>;
  /** `jsx()`, `jsxs()`, `_jsx()` and `createElement()` back to JSX. */
  jsx(code: string): Promise<string>;
  /** CommonJS `exports.x =`, `module.exports` and `require` back to ES module syntax. */
  esm(code: string): Promise<string>;
  format(code: string, parser: "babel" | "css"): Promise<string>;
}

/** wakaru rule ids per pass, in wakaru's own order. Its Prettier runs are left out. */
export const WAKARU_RULES = {
  unminify: [
    "un-curly-braces",
    "un-sequence-expression",
    "un-variable-merging",
    "un-assignment-merging",
    "un-boolean",
    "un-undefined",
    "un-infinity",
    "un-typeof",
    "un-numeric-literal",
    "un-bracket-notation",
    "un-return",
    "un-while-loop",
    "un-indirect-call",
    "un-type-constructor",
    "un-builtin-prototype",
    "un-sequence-expression",
    "un-flip-comparisons",
    "un-iife",
    "un-conditionals",
    "un-sequence-expression",
  ],
  detranspile: [
    "un-runtime-helper",
    "un-enum",
    "lebab",
    "un-template-literal",
    "un-optional-chaining",
    "un-nullish-coalescing",
    "un-sequence-expression",
    "un-parameters",
    "un-argument-spread",
    "un-es6-class",
    "un-async-await",
  ],
  jsx: ["un-jsx"],
  // Not un-export-rename: it turns `export { a as default }` into `export function default()`.
  esm: ["un-esm", "un-esmodule-flag", "un-use-strict"],
} as const;

interface Wakaru {
  runTransformationRules(
    file: { source: string; path: string },
    rules: string[],
    params?: Record<string, unknown>,
  ): Promise<{ code: string }>;
}

let wakaru: Wakaru | undefined;
function loadWakaru(): Wakaru {
  // wakaru's ES build imports `prettier/parser-babel` without an extension, which Node rejects;
  // its CommonJS build works.
  wakaru ??= createRequire(import.meta.url)("@wakaru/unminify") as Wakaru;
  return wakaru;
}

async function runWakaru(code: string, rules: readonly string[]): Promise<string> {
  // A rule that fails on a module logs a stack trace and leaves that rule's change out; the
  // pass still returns code, so the trace is noise on the user's terminal.
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    const result = await loadWakaru().runTransformationRules({ source: code, path: "module.js" }, [
      ...rules,
    ]);
    return keepModuleNames(code, result.code);
  } finally {
    Object.assign(console, saved);
  }
}

/** Names a module reads without declaring them: globals, and anything a bad rewrite orphaned. */
export function freeNames(code: string): Set<string> | undefined {
  let ast: ReturnType<typeof parseCode>;
  try {
    ast = parseCode(code);
  } catch {
    return undefined;
  }
  const names = new Set<string>();
  traverse(ast, {
    ReferencedIdentifier(path) {
      const node = path.node;
      if (node.type === "Identifier" && !path.scope.hasBinding(node.name, true))
        names.add(node.name);
    },
  });
  return names;
}

/**
 * Run a group of wakaru rules, and reject output that reads a name nothing declares that the
 * input did not read (`un-parameters` can turn `arguments` into an `args` it never declares).
 * When the group fails that check, the rules run one at a time and only the bad ones are left out.
 */
/**
 * A class made from a constructor function that guards itself with
 * `if (!(this instanceof X)) return new X(…)`: the function was meant to be called without
 * `new`, which a class forbids, so un-es6-class must not convert it.
 */
export function callableClass(code: string): boolean {
  return /class\s+([\w$]+)\b[^{]*\{\s*constructor\s*\([^)]*\)\s*\{\s*if\s*\(\s*!\s*\(\s*this\s+instanceof\s+\1\s*\)\s*\)/.test(
    code,
  );
}

async function guardedWakaru(code: string, rules: readonly string[]): Promise<string> {
  const before = freeNames(code);
  if (!before) return runWakaru(code, rules);
  const ok = (out: string) => {
    const after = freeNames(out);
    return (
      after !== undefined &&
      [...after].every((n) => before.has(n)) &&
      !(callableClass(out) && !callableClass(code))
    );
  };
  const all = await runWakaru(code, rules);
  if (ok(all)) return all;
  let current = code;
  for (const rule of rules) {
    const next = await runWakaru(current, [rule]);
    if (ok(next)) current = next;
  }
  return current;
}

interface ModuleNames {
  imports: { imported: string; start: number; end: number }[][];
  exports: { exported: string; start: number; end: number; local: string }[][];
}

function moduleNames(code: string): ModuleNames | undefined {
  let ast: ReturnType<typeof parseCode>;
  try {
    ast = parseCode(code);
  } catch {
    return undefined;
  }
  const out: ModuleNames = { imports: [], exports: [] };
  const nameOf = (n: { type: string; name?: string; value?: unknown }) =>
    n.type === "Identifier" ? (n.name ?? "") : String(n.value);
  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration") {
      out.imports.push(
        node.specifiers
          .filter((s) => s.type === "ImportSpecifier")
          .map((s) => ({ imported: nameOf(s.imported), start: start(s), end: end(s) })),
      );
    } else if (node.type === "ExportNamedDeclaration" && !node.declaration) {
      out.exports.push(
        node.specifiers
          .filter((s) => s.type === "ExportSpecifier")
          .map((s) => ({
            exported: nameOf(s.exported),
            local: nameOf(s.local),
            start: start(s),
            end: end(s),
          })),
      );
    }
  }
  return out;
}

/**
 * wakaru renames bindings (JSX components must be capitalized) with a rename that also changes
 * the name an import reads and an export list publishes, which breaks every module on the other
 * side. Put those names back, keeping the new local names: `import { te as Te }`.
 */
export function keepModuleNames(before: string, after: string): string {
  if (before === after) return after;
  const old = moduleNames(before);
  const now = moduleNames(after);
  if (!old || !now) return after;
  if (old.imports.length !== now.imports.length || old.exports.length !== now.exports.length)
    return after;
  const edits: TextEdit[] = [];
  for (const [i, specs] of now.imports.entries()) {
    const was = old.imports[i] ?? [];
    if (was.length !== specs.length) continue;
    for (const [j, spec] of specs.entries()) {
      const original = was[j]?.imported;
      if (original === undefined || original === spec.imported) continue;
      const local =
        after
          .slice(spec.start, spec.end)
          .split(/\s+as\s+/)
          .pop() ?? spec.imported;
      edits.push({ start: spec.start, end: spec.end, text: `${original} as ${local}` });
    }
  }
  for (const [i, specs] of now.exports.entries()) {
    const was = old.exports[i] ?? [];
    if (was.length !== specs.length) continue;
    for (const [j, spec] of specs.entries()) {
      const original = was[j]?.exported;
      if (original === undefined || original === spec.exported) continue;
      edits.push({ start: spec.start, end: spec.end, text: `${spec.local} as ${original}` });
    }
  }
  return edits.length > 0 ? applyEdits(after, edits) : after;
}

const SANDBOX_TIMEOUT_MS = 10_000;

/**
 * Code a deobfuscator must run (an obfuscator's string decoder) is site code, so it never runs in
 * this process: a child Node process evaluates it in a fresh `vm` context, under the permission
 * model (no file system, child processes, workers or native addons), with string code
 * generation disabled and a timeout. Only the JSON-serialized result comes back.
 */
export function childSandbox(code: string): Promise<unknown> {
  const flag = process.allowedNodeEnvironmentFlags.has("--permission")
    ? "--permission"
    : "--experimental-permission";
  const runner = `
const vm = require("node:vm");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  try {
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    const value = vm.runInContext(input, context, { timeout: ${SANDBOX_TIMEOUT_MS - 2000} });
    process.stdout.write(JSON.stringify({ ok: true, value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
  }
});`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [flag, "--disallow-code-generation-from-strings", "-e", runner],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Nothing from this process's environment (tokens, CI secrets) reaches site code.
        env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "" } : {},
      },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), SANDBOX_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      out += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      err += c;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as { ok: boolean; value?: unknown; error?: string };
        if (parsed.ok) resolve(parsed.value);
        else reject(new Error(parsed.error ?? "sandbox error"));
      } catch {
        reject(new Error(`sandbox failed${err ? `: ${err.trim().split("\n")[0]}` : ""}`));
      }
    });
    // A child that dies early closes its stdin; the close handler reports that.
    child.stdin.on("error", () => {});
    child.stdin.end(code);
  });
}

export const defaultAdapter: LibraryAdapter = {
  async deobfuscate(code) {
    const result = await webcrack(code, {
      unpack: false,
      jsx: false,
      mangle: false,
      deobfuscate: true,
      unminify: true,
      sandbox: childSandbox,
    });
    return result.code;
  },
  unminify: async (code) =>
    plainTemplates(unIndirectCalls(await guardedWakaru(code, WAKARU_RULES.unminify))),
  detranspile: async (code) =>
    unIndirectCalls(
      dropUnusedHelpers(await guardedWakaru(restoreBabel(code), WAKARU_RULES.detranspile)),
    ),
  jsx: (code) => guardedWakaru(trimJsxDev(code), WAKARU_RULES.jsx),
  esm: (code) => guardedWakaru(code, WAKARU_RULES.esm),
  format: (code, parser) => format(code, { parser }),
};

/**
 * `(0, a.createElement)(...)` to `a.createElement(...)`. Bundlers write calls of imported
 * bindings this way so `this` is undefined; for module bindings that never matters, and wakaru
 * only rewrites the forms it can turn into named imports.
 */
export function unIndirectCalls(code: string): string {
  const ast = parseCode(code);
  const edits: TextEdit[] = [];
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      // webpack 4 writes the same thing as `Object(o.a)(…)`.
      if (
        callee.type === "CallExpression" &&
        callee.callee.type === "Identifier" &&
        callee.callee.name === "Object" &&
        !path.scope.hasBinding("Object", true) &&
        callee.arguments.length === 1 &&
        (callee.arguments[0]?.type === "MemberExpression" ||
          callee.arguments[0]?.type === "Identifier")
      ) {
        const target = callee.arguments[0];
        edits.push({
          start: start(callee),
          end: end(callee),
          text: code.slice(start(target), end(target)),
        });
        return;
      }
      if (callee.type !== "SequenceExpression" || callee.expressions.length !== 2) return;
      const [zero, target] = callee.expressions;
      if (zero?.type !== "NumericLiteral" || zero.value !== 0 || !target) return;
      if (target.type !== "MemberExpression" && target.type !== "Identifier") return;
      // The sequence sits in parentheses: replace from its `(` to its `)`.
      const open = code.lastIndexOf("(", start(zero));
      const close = code.indexOf(")", end(target));
      if (open < start(path.node) || close < 0) return;
      // `return(0,a.b)(…)` must not become `returna.b(…)`.
      const glue = /[\w$]/.test(code[open - 1] ?? "") ? " " : "";
      edits.push({
        start: open,
        end: close + 1,
        text: glue + code.slice(start(target), end(target)),
      });
    },
  });
  return edits.length > 0 ? applyEdits(code, edits) : code;
}

/**
 * `` `div` `` to `"div"`: Rolldown writes every string as a template literal, and wakaru reads a
 * template tag name in JSX as a dynamic component. Tagged templates keep theirs.
 */
export function plainTemplates(code: string): string {
  if (!code.includes("`")) return code;
  const ast = parseCode(code);
  const edits: TextEdit[] = [];
  traverse(ast, {
    TemplateLiteral(path) {
      const node = path.node;
      if (node.expressions.length > 0 || path.parent.type === "TaggedTemplateExpression") return;
      const cooked = node.quasis[0]?.value.cooked;
      if (typeof cooked !== "string") return;
      edits.push({ start: start(node), end: end(node), text: JSON.stringify(cooked) });
    },
  });
  return edits.length > 0 ? applyEdits(code, edits) : code;
}

/**
 * `jsxDEV(type, props, key, isStatic, source, self)` to `jsxDEV(type, props, key)`: development
 * builds pass debug arguments that wakaru would otherwise read as children.
 */
export function trimJsxDev(code: string): string {
  if (!code.includes("jsxDEV")) return code;
  const ast = parseCode(code);
  const edits: TextEdit[] = [];
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      const name = callee.type === "Identifier" ? callee.name : memberName(callee);
      const args = path.node.arguments;
      if (name !== "jsxDEV" || args.length <= 2) return;
      const key = args[2];
      const noKey =
        !key ||
        (key.type === "UnaryExpression" && key.operator === "void") ||
        (key.type === "Identifier" && key.name === "undefined");
      const keep = noKey ? 2 : 3;
      const last = args[keep - 1];
      const tail = args.at(-1);
      if (!last || !tail || args.length === keep) return;
      edits.push({ start: end(last), end: end(tail), text: "" });
    },
  });
  return edits.length > 0 ? applyEdits(code, edits) : code;
}
