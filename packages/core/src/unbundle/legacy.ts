import type * as t from "@babel/types";
import {
  applyEdits,
  end,
  type NodePath,
  parseCode,
  parses,
  start,
  type TextEdit,
  traverse,
} from "./ast.js";

/**
 * Babel's helpers, recognized by what they do rather than their names: a minifier renames them
 * and often inlines them at the call site, so `_classCallCheck` can arrive as
 * `!function(t,r){if(!(t instanceof r))throw new TypeError("Cannot call a class…")}(this,t)`.
 */
type Helper =
  | "typeof"
  | "classCallCheck"
  | "createClass"
  | "toConsumableArray"
  | "objectSpread"
  | "asyncToGenerator"
  | "forOf";

function helperOf(text: string): Helper | undefined {
  if (text.length > 4000) return undefined;
  if (text.includes("Cannot call a class as a function")) return "classCallCheck";
  if (text.includes("Invalid attempt to iterate non-iterable instance")) return "forOf";
  if (text.includes("Invalid attempt to spread non-iterable instance")) return "toConsumableArray";
  if (/"prototype"/.test(text) && /writable/.test(text) && /defineProperty/.test(text))
    return "createClass";
  if (/getOwnPropertyDescriptors/.test(text) && /arguments/.test(text)) return "objectSpread";
  if (
    /"next"/.test(text) &&
    /"throw"/.test(text) &&
    /new Promise/.test(text) &&
    /\.apply\(/.test(text)
  )
    return "asyncToGenerator";
  if (
    text.length < 700 &&
    /Symbol\.iterator/.test(text) &&
    /"symbol"/.test(text) &&
    /Symbol\.prototype/.test(text)
  )
    return "typeof";
  return undefined;
}

/**
 * Undo what Babel's preset-env did to modern syntax, for the shapes it emits most: classes
 * (`_createClass`), async methods (regenerator state machines with a straight path), array and
 * object spread, and `_typeof`. Anything that does not match exactly is left alone. Runs a few
 * rounds, since one restore can expose the next (a spread inside an async method).
 */
export function restoreBabel(code: string): string {
  let current = code;
  for (let round = 0; round < 6; round++) {
    let next: string;
    try {
      next = restoreRound(current);
    } catch {
      break;
    }
    if (next === current || !parses(next)) break;
    current = next;
  }
  return current;
}

function restoreRound(code: string): string {
  const ast = parseCode(code);
  const helperByName = new Map<string, Helper>();
  traverse(ast, {
    FunctionDeclaration(path) {
      const id = path.node.id;
      if (!id) return;
      const kind = helperOf(code.slice(start(path.node), end(path.node)));
      if (kind) helperByName.set(id.name, kind);
    },
  });
  const kindOf = (node: t.Node | null | undefined): Helper | undefined => {
    if (!node) return undefined;
    if (node.type === "Identifier") return helperByName.get(node.name);
    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")
      return helperOf(code.slice(start(node), end(node)));
    return undefined;
  };
  const text = (n: t.Node) => code.slice(start(n), end(n));
  const edits: TextEdit[] = [];

  traverse(ast, {
    CallExpression(path) {
      const node = path.node;
      const kind = kindOf(node.callee);
      if (!kind) return;
      switch (kind) {
        case "classCallCheck": {
          const statement = path.parentPath?.isUnaryExpression()
            ? path.parentPath.parentPath
            : path.parentPath;
          if (statement?.isExpressionStatement())
            edits.push({ start: start(statement.node), end: end(statement.node), text: "" });
          return;
        }
        case "typeof": {
          const arg = node.arguments[0];
          if (node.arguments.length === 1 && arg)
            edits.push({ start: start(node), end: end(node), text: `(typeof ${text(arg)})` });
          return;
        }
        case "toConsumableArray": {
          const arg = node.arguments[0];
          if (node.arguments.length !== 1 || !arg) return;
          // `[].concat(A(x), A(y))` is handled at the concat; a lone `A(x)` is `[...x]`.
          const parent = path.parent;
          if (
            parent.type === "CallExpression" &&
            parent.arguments.includes(node) &&
            isEmptyConcat(parent)
          )
            return;
          edits.push({ start: start(node), end: end(node), text: `[...${text(arg)}]` });
          return;
        }
        case "objectSpread": {
          if (
            path.parent.type === "CallExpression" &&
            kindOf(path.parent.callee) === "objectSpread" &&
            path.parent.arguments[0] === node
          )
            return;
          const parts = objectSpreadParts(node, kindOf, text);
          if (parts)
            edits.push({ start: start(node), end: end(node), text: `{ ${parts.join(", ")} }` });
          return;
        }
        case "createClass": {
          const cls = classFrom(node, path, text, kindOf, code);
          if (cls) {
            edits.push({ start: start(node), end: end(node), text: cls.text });
            for (const e of cls.extra) edits.push(e);
          }
          return;
        }
        default:
          return;
      }
    },
  });

  // `function y() { return (y = asyncToGenerator(R().m(function t(…) {…}))).apply(this, args) }`
  // → `async function y(…) {…}`.
  traverse(ast, {
    FunctionDeclaration(path) {
      const node = path.node;
      const name = node.id?.name;
      const only = node.body.body.length === 1 ? node.body.body[0] : undefined;
      if (!name || only?.type !== "ReturnStatement") return;
      const call = only.argument;
      if (call?.type !== "CallExpression" || call.callee.type !== "MemberExpression") return;
      const assign = call.callee.object;
      if (
        assign.type !== "AssignmentExpression" ||
        assign.left.type !== "Identifier" ||
        assign.left.name !== name
      )
        return;
      const wrapped = assign.right;
      if (wrapped.type !== "CallExpression" || kindOf(wrapped.callee) !== "asyncToGenerator")
        return;
      const restored = asyncFrom(wrapped, text, code, kindOf);
      if (!restored) return;
      edits.push({
        start: start(node),
        end: end(node),
        text: `async function ${name}(${restored.params}) {\n${restored.body}\n}`,
      });
    },
  });

  // Babel's for-of helper: `u = H(xs); try { for (u.s(); !(a = u.n()).done; ) { f = a.value; … } }
  // catch (t) { u.e(t); } finally { u.f(); }` → `for (f of xs) { … }`.
  traverse(ast, {
    TryStatement(path) {
      const node = path.node;
      const loop = node.block.body.length === 1 ? node.block.body[0] : undefined;
      if (loop?.type !== "ForStatement" || !node.handler || !node.finalizer) return;
      const init = loop.init;
      if (
        init?.type !== "CallExpression" ||
        init.callee.type !== "MemberExpression" ||
        init.callee.object.type !== "Identifier"
      )
        return;
      const it = init.callee.object.name;
      const previous = path.getSibling((path.key as number) - 1);
      const setup = previous.node;
      if (
        setup?.type !== "ExpressionStatement" ||
        setup.expression.type !== "AssignmentExpression" ||
        setup.expression.left.type !== "Identifier" ||
        setup.expression.left.name !== it ||
        setup.expression.right.type !== "CallExpression" ||
        kindOf(setup.expression.right.callee) !== "forOf"
      )
        return;
      const iterable = setup.expression.right.arguments[0];
      const body = loop.body.type === "BlockStatement" ? loop.body.body : [];
      const first = body[0];
      if (
        !iterable ||
        first?.type !== "ExpressionStatement" ||
        first.expression.type !== "AssignmentExpression" ||
        first.expression.right.type !== "MemberExpression" ||
        first.expression.right.property.type !== "Identifier" ||
        first.expression.right.property.name !== "value"
      )
        return;
      const rest = body
        .slice(1)
        .map((s) => text(s))
        .join("\n");
      if (new RegExp(`(?<![\\w$])${esc(it)}(?![\\w$])`).test(rest)) return;
      const target = text(first.expression.left);
      edits.push({ start: start(setup), end: end(setup), text: "" });
      edits.push({
        start: start(node),
        end: end(node),
        text: `for (${target} of ${text(iterable)}) {\n${rest}\n}`,
      });
    },
  });

  // `[].concat(A(x), [a, b], A(y))` → `[...x, a, b, ...y]`.
  traverse(ast, {
    CallExpression(path) {
      const node = path.node;
      if (!isEmptyConcat(node)) return;
      const items: string[] = [];
      for (const arg of node.arguments) {
        if (
          arg.type === "CallExpression" &&
          kindOf(arg.callee) === "toConsumableArray" &&
          arg.arguments[0]
        ) {
          items.push(`...${text(arg.arguments[0])}`);
        } else if (
          arg.type === "ArrayExpression" &&
          arg.elements.every((e) => e && e.type !== "SpreadElement")
        ) {
          for (const e of arg.elements) if (e) items.push(text(e));
        } else return;
      }
      edits.push({ start: start(node), end: end(node), text: `[${items.join(", ")}]` });
    },
  });

  // `(function () { return X; var t; var r; })()` → `X`, once nothing else is left in it.
  traverse(ast, {
    CallExpression(path) {
      const node = path.node;
      const callee = node.callee;
      if (
        node.arguments.length > 0 ||
        callee.type !== "FunctionExpression" ||
        callee.params.length > 0
      )
        return;
      const body = callee.body.body;
      const ret = body[0];
      if (ret?.type !== "ReturnStatement" || !ret.argument) return;
      const rest = body.slice(1);
      if (
        !rest.every((s) => s.type === "VariableDeclaration" && s.declarations.every((d) => !d.init))
      )
        return;
      const names = rest.flatMap((s) =>
        (s as t.VariableDeclaration).declarations.map((d) => (d.id as t.Identifier).name),
      );
      const inner = text(ret.argument);
      // Still-read temporaries keep the wrapper; scope references, so a parameter or class name
      // that reuses a temporary's name does not count.
      const scope = (path.get("callee") as NodePath).scope;
      if (names.some((n) => (scope.getOwnBinding(n)?.referencePaths.length ?? 0) > 0)) return;
      if (/\bthis\b|\barguments\b/.test(inner) && !/^class\b/.test(inner)) return;
      edits.push({ start: start(node), end: end(node), text: inner });
    },
  });

  return edits.length > 0 ? applyEdits(code, edits) : code;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isEmptyConcat(node: t.CallExpression): boolean {
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "ArrayExpression" &&
    callee.object.elements.length === 0 &&
    callee.property.type === "Identifier" &&
    callee.property.name === "concat"
  );
}

/** `S(S({}, a), b)` or `S({}, a, b)` → `...a, ...b`; `S({ x: 1 }, a)` → `x: 1, ...a`. */
function objectSpreadParts(
  node: t.CallExpression,
  kindOf: (n: t.Node | null | undefined) => Helper | undefined,
  text: (n: t.Node) => string,
): string[] | undefined {
  const [first, ...rest] = node.arguments;
  if (!first) return undefined;
  let parts: string[];
  if (first.type === "ObjectExpression") {
    parts = first.properties.map((p) => text(p));
  } else if (first.type === "CallExpression" && kindOf(first.callee) === "objectSpread") {
    const inner = objectSpreadParts(first, kindOf, text);
    if (!inner) return undefined;
    parts = inner;
  } else return undefined;
  for (const arg of rest) {
    if (arg.type === "SpreadElement" || arg.type === "ArgumentPlaceholder") return undefined;
    parts.push(
      arg.type === "ObjectExpression"
        ? arg.properties.map((p) => text(p)).join(", ")
        : `...${text(arg)}`,
    );
  }
  return parts.filter(Boolean);
}

/** `createClass(function T() {…}, [{ key: "m", value: function () {…} }], [statics])` → `class T {…}`. */
function classFrom(
  node: t.CallExpression,
  path: NodePath<t.CallExpression>,
  text: (n: t.Node) => string,
  kindOf: (n: t.Node | null | undefined) => Helper | undefined,
  code: string,
): { text: string; extra: TextEdit[] } | undefined {
  const [ctorArg, protoArg, staticArg] = node.arguments;
  const extra: TextEdit[] = [];
  let ctor: t.FunctionExpression | t.FunctionDeclaration | undefined;
  let name: string | undefined;
  if (ctorArg?.type === "FunctionExpression") {
    ctor = ctorArg;
    name = ctorArg.id?.name;
  } else if (ctorArg?.type === "Identifier") {
    const binding = path.scope.getBinding(ctorArg.name);
    const decl = binding?.path.node;
    if (decl?.type !== "FunctionDeclaration") return undefined;
    // The declaration moves into the class.
    if (binding && binding.referencePaths.length !== 1) return undefined;
    ctor = decl;
    name = decl.id?.name;
    extra.push({ start: start(decl), end: end(decl), text: "" });
  } else return undefined;
  if (!ctor || ctor.generator || ctor.async) return undefined;
  const members: string[] = [];
  const params = (fn: t.Function) => fn.params.map((p) => text(p)).join(", ");
  const bodyText = (fn: t.Function) => {
    const body = fn.body;
    if (body.type !== "BlockStatement") return `return ${text(body)};`;
    return code.slice(start(body) + 1, end(body) - 1).trim();
  };
  const ctorBody = bodyText(ctor);
  if (ctorBody.includes("Cannot call a class as a function")) return undefined;
  if (ctorBody || ctor.params.length > 0)
    members.push(`constructor(${params(ctor)}) {\n${ctorBody}\n}`);
  for (const [arg, isStatic] of [
    [protoArg, false],
    [staticArg, true],
  ] as const) {
    if (!arg) continue;
    if (arg.type !== "ArrayExpression") return undefined;
    for (const el of arg.elements) {
      if (el?.type !== "ObjectExpression") return undefined;
      let key: string | undefined;
      const parts: { kind: "value" | "get" | "set"; node: t.Node }[] = [];
      for (const p of el.properties) {
        if (p.type !== "ObjectProperty" || p.computed) return undefined;
        const k =
          p.key.type === "Identifier"
            ? p.key.name
            : p.key.type === "StringLiteral"
              ? p.key.value
              : undefined;
        if (k === "key") {
          if (p.value.type !== "StringLiteral") return undefined;
          key = p.value.value;
        } else if (k === "value" || k === "get" || k === "set")
          parts.push({ kind: k, node: p.value });
        else return undefined;
      }
      if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) return undefined;
      const prefix = isStatic ? "static " : "";
      for (const part of parts) {
        const fn = part.node;
        if (part.kind !== "value") {
          if (fn.type !== "FunctionExpression") return undefined;
          members.push(`${prefix}${part.kind} ${key}(${params(fn)}) {\n${bodyText(fn)}\n}`);
          continue;
        }
        if (fn.type === "FunctionExpression" && !fn.generator) {
          members.push(
            `${prefix}${fn.async ? "async " : ""}${key}(${params(fn)}) {\n${bodyText(fn)}\n}`,
          );
          continue;
        }
        const asyncMethod = asyncFrom(fn, text, code, kindOf);
        if (!asyncMethod) return undefined;
        members.push(`${prefix}async ${key}(${asyncMethod.params}) {\n${asyncMethod.body}\n}`);
      }
    }
  }
  return { text: `class ${name ?? ""} {\n${members.join("\n\n")}\n}`, extra };
}

/**
 * The value Babel writes for an async method once a minifier has inlined `_asyncToGenerator`:
 * `(t = R().m(function t(r) { return R().w(function (c) { switch (c.n) {…} }, t, this) }),
 * r = function () {…}, function (x) { return r.apply(this, arguments) })`.
 */
function asyncFrom(
  node: t.Node,
  text: (n: t.Node) => string,
  code: string,
  _kindOf: (n: t.Node | null | undefined) => Helper | undefined,
): { params: string; body: string } | undefined {
  let generator: t.FunctionExpression | undefined;
  const visit = (n: t.Node | null | undefined): void => {
    if (!n || generator) return;
    if (
      n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      n.callee.property.type === "Identifier" &&
      (n.callee.property.name === "m" || n.callee.property.name === "mark") &&
      n.arguments[0]?.type === "FunctionExpression"
    ) {
      generator = n.arguments[0];
      return;
    }
    for (const [key, value] of Object.entries(n)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end" ||
        key === "extra" ||
        !value ||
        typeof value !== "object"
      )
        continue;
      if (Array.isArray(value)) {
        for (const v of value) visit(v as t.Node);
      } else if ("type" in value) visit(value as t.Node);
    }
  };
  visit(node);
  if (!generator) return undefined;
  const body = decompileRegenerator(generator, text, code);
  if (body === undefined) return undefined;
  return { params: generator.params.map((p) => text(p)).join(", "), body };
}

/**
 * Turn a regenerator state machine back into an async function body, for the straight-line case:
 * each `case` runs in order, `c.n = K; return X;` is `await X` (its value read as `c.v`/`c.sent`
 * in case K), and `return c.a(2, X)` / `c.abrupt("return", X)` is `return X`. Loops, try/catch
 * (`c.p`, `c.prev`) or jumps out of order mean the function is left as it is.
 */
export function decompileRegenerator(
  generator: t.FunctionExpression,
  text: (n: t.Node) => string,
  code: string,
): string | undefined {
  const ret = generator.body.body.find((s) => s.type === "ReturnStatement") as
    | t.ReturnStatement
    | undefined;
  const call = ret?.argument;
  if (call?.type !== "CallExpression") return undefined;
  const inner = call.arguments[0];
  if (inner?.type !== "FunctionExpression") return undefined;
  const ctx = inner.params[0];
  if (ctx?.type !== "Identifier") return undefined;
  const c = ctx.name;
  // Find the switch.
  let sw: t.SwitchStatement | undefined;
  const find = (s: t.Statement | undefined): void => {
    if (!s || sw) return;
    if (s.type === "SwitchStatement") sw = s;
    else if (s.type === "WhileStatement" || s.type === "ForStatement") find(s.body);
    else if (s.type === "BlockStatement") s.body.forEach(find);
  };
  inner.body.body.forEach(find);
  if (!sw) return undefined;
  const cases = sw.cases.map((k) => ({
    // `default:` and old regenerator's `case "end":` hold the final stop.
    label:
      k.test?.type === "NumericLiteral"
        ? k.test.value
        : !k.test || (k.test.type === "StringLiteral" && k.test.value === "end")
          ? -1
          : Number.NaN,
    statements:
      k.consequent.length === 1 && k.consequent[0]?.type === "BlockStatement"
        ? k.consequent[0].body
        : k.consequent,
  }));
  if (cases.some((k) => Number.isNaN(k.label))) return undefined;
  const ctxRef = new RegExp(`(?<![\\w$])${esc(c)}\\.(\\w+)`, "g");
  const out: string[] = [];
  if (cases[0]?.label !== 0) return undefined;
  // The generator's own `var` declarations (regenerator hoists every local there).
  for (const s of generator.body.body) if (s !== ret) out.push(text(s));
  for (const [i, kase] of cases.entries()) {
    const sent = (s: string) =>
      s.replace(new RegExp(`(?<![\\w$])${esc(c)}\\.(?:v|sent)\\b`, "g"), `__awaited${kase.label}`);
    const statements = kase.statements;
    for (let j = 0; j < statements.length; j++) {
      const s = statements[j] as t.Statement;
      const src = text(s);
      // `c.n = K;` then `return X;`
      const next = statements[j + 1];
      if (
        s.type === "ExpressionStatement" &&
        s.expression.type === "AssignmentExpression" &&
        isCtx(s.expression.left, c, ["n", "next"]) &&
        s.expression.right.type === "NumericLiteral" &&
        next?.type === "ReturnStatement" &&
        next.argument
      ) {
        const target = s.expression.right.value;
        if (cases[i + 1]?.label !== target) return undefined;
        const value = text(next.argument);
        if (ctxRef.test(value)) return undefined;
        ctxRef.lastIndex = 0;
        const uses = cases[i + 1]?.statements.some((x) =>
          new RegExp(`(?<![\\w$])${esc(c)}\\.(?:v|sent)\\b`).test(text(x)),
        );
        out.push(uses ? `const __awaited${target} = await ${value};` : `await ${value};`);
        j++;
        continue;
      }
      if (
        s.type === "ReturnStatement" &&
        s.argument?.type === "CallExpression" &&
        isCtx(s.argument.callee, c, ["a", "abrupt"])
      ) {
        const args = s.argument.arguments;
        const isAbrupt =
          s.argument.callee.type === "MemberExpression" &&
          (s.argument.callee.property as t.Identifier).name === "abrupt";
        const kindArg = args[0];
        const okKind = isAbrupt
          ? kindArg?.type === "StringLiteral" && kindArg.value === "return"
          : kindArg?.type === "NumericLiteral" && kindArg.value === 2;
        if (!okKind) return undefined;
        const value = args[1];
        out.push(value ? `return ${sent(text(value))};` : "return;");
        continue;
      }
      if (
        (s.type === "ReturnStatement" || s.type === "ExpressionStatement") &&
        /^(?:return\s+)?\w+\.stop\(\);?$/.test(src.trim())
      )
        continue;
      const replaced = sent(src);
      ctxRef.lastIndex = 0;
      if (new RegExp(`(?<![\\w$])${esc(c)}(?![\\w$])`).test(replaced)) return undefined;
      out.push(replaced);
    }
  }
  void code;
  if (out.at(-1) === "return;") out.pop();
  return out.join("\n");
}

function isCtx(node: t.Node, ctx: string, props: string[]): boolean {
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === ctx &&
    node.property.type === "Identifier" &&
    props.includes(node.property.name)
  );
}

/**
 * Helper functions nothing calls any more (after the restores above), removed so the agent does
 * not read them. Only functions recognized as Babel helpers are touched.
 */
export function dropUnusedHelpers(code: string): string {
  let current = code;
  for (let round = 0; round < 8; round++) {
    let ast: t.File;
    try {
      ast = parseCode(current);
    } catch {
      return current;
    }
    const edits: TextEdit[] = [];
    traverse(ast, {
      FunctionDeclaration(path) {
        const id = path.node.id;
        if (!id || path.parentPath.type !== "Program") return;
        const textOf = current.slice(start(path.node), end(path.node));
        const kind = helperOf(textOf) ?? (BABEL_SUPPORT.test(textOf) ? "support" : undefined);
        if (!kind) return;
        const binding = path.scope.parent?.getBinding(id.name) ?? path.scope.getBinding(id.name);
        const outside = (binding?.referencePaths ?? []).filter(
          (r) => !(start(r.node) >= start(path.node) && end(r.node) <= end(path.node)),
        );
        if (outside.length === 0)
          edits.push({ start: start(path.node), end: end(path.node), text: "" });
      },
    });
    if (edits.length === 0) break;
    const next = applyEdits(current, edits);
    if (!parses(next)) break;
    current = next;
  }
  return current;
}

/** Bodies of helpers that only support others: `_regenerator`, `_defineProperty`, `ownKeys`, … */
const SUPPORT =
  /regenerator-runtime|GeneratorFunction|_invoke|Symbol\.toPrimitive|Object\.getOwnPropertySymbols|\.enumerable=\w+\.enumerable\|\|(?:false|!1)|Promise\.resolve\(\w+\)\.then\(\w+,\w+\)|"Arguments"|Array\.from\(\w+\)|=Array\(\w+\)/;
const BABEL_SUPPORT = { test: (text: string) => SUPPORT.test(text.replace(/\s+/g, "")) };
