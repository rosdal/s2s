import { parseSync } from "oxc-parser";
import { hasher, hashHex, loadHasher } from "./hash.js";

/**
 * Bumped whenever the token stream changes for any input. The index records the version it was
 * built with, and the matcher refuses an index built by a different one: the builder and the
 * matcher must never drift.
 */
export const NORMALIZER_VERSION = 1;
/** Functions smaller than this many AST nodes are too generic to identify a package. */
export const MIN_FUNCTION_NODES = 8;
/** String literals at least this long are candidates for the distinctive-string signal. */
export const MIN_STRING_LENGTH = 12;

export interface FunctionPrint {
  /** xxHash64 of the normalized token stream, unsigned. */
  hash: bigint;
  /** UTF-16 offsets into the code; `end` is exclusive. */
  start: number;
  end: number;
  nodes: number;
}

export interface StringPrint {
  hash: bigint;
  start: number;
  value: string;
}

export interface CodePrints {
  functions: FunctionPrint[];
  strings: StringPrint[];
  /** The parser's first error, when it could not produce a program at all. */
  error: string | null;
}

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const node = (n: Node, key: string) => n[key] as Node | null | undefined;
const nodes = (n: Node, key: string) => (n[key] as (Node | null)[] | undefined) ?? [];

/**
 * Names a minifier never renames: built-ins and host globals. Every other identifier is replaced
 * by the order in which it first appears inside the function, so `function(e,t){…}` and
 * `function(n,r){…}` normalize the same.
 */
const GLOBALS = new Set(
  (
    "Object Array Function Boolean Number String Symbol BigInt Math JSON Date RegExp Promise Proxy " +
    "Reflect Map Set WeakMap WeakSet WeakRef FinalizationRegistry Error TypeError RangeError " +
    "SyntaxError ReferenceError EvalError URIError AggregateError ArrayBuffer SharedArrayBuffer " +
    "DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array " +
    "Float32Array Float64Array BigInt64Array BigUint64Array Atomics Intl NaN Infinity globalThis " +
    "arguments eval isNaN isFinite parseInt parseFloat encodeURIComponent decodeURIComponent " +
    "encodeURI decodeURI escape unescape window self document navigator location history console " +
    "localStorage sessionStorage setTimeout clearTimeout setInterval clearInterval setImmediate " +
    "clearImmediate requestAnimationFrame cancelAnimationFrame requestIdleCallback queueMicrotask " +
    "structuredClone fetch XMLHttpRequest Headers Request Response FormData URL URLSearchParams " +
    "Blob File FileReader AbortController AbortSignal TextEncoder TextDecoder Event CustomEvent " +
    "EventTarget Node Element HTMLElement SVGElement DocumentFragment ShadowRoot MutationObserver " +
    "ResizeObserver IntersectionObserver getComputedStyle matchMedia performance crypto atob btoa " +
    "Image Worker MessageChannel WebSocket require module exports process Buffer global"
  ).split(" "),
);

/** Past this depth a subtree is replaced by one token, so a pathological input cannot overflow. */
const MAX_DEPTH = 1500;

class Scope {
  readonly tokens: string[] = [];
  readonly names = new Map<string, number>();
  size = 0;

  name(raw: string): string {
    let n = this.names.get(raw);
    if (n === undefined) {
      n = this.names.size;
      this.names.set(raw, n);
    }
    return `$${n}`;
  }
}

const isLiteral = (n: Node | null | undefined): boolean =>
  !!n &&
  (n.type === "Literal" ||
    (n.type === "TemplateLiteral" && nodes(n, "expressions").length === 0) ||
    (n.type === "UnaryExpression" && n.operator === "void") ||
    (n.type === "Identifier" && n.name === "undefined"));

const isTypeof = (n: Node | null | undefined): boolean =>
  !!n && n.type === "UnaryExpression" && n.operator === "typeof";

const isBoolLiteral = (n: Node): boolean => n.type === "Literal" && typeof n.value === "boolean";

const IDENT = /^[A-Za-z_$][\w$]*$/;
const COMPOUND = new Set(["+", "-", "*", "/", "%", "**", "<<", ">>", ">>>", "|", "&", "^"]);
const SWAP: Record<string, string> = { ">": "<", ">=": "<=" };

/**
 * Turns code into per-function hashes that survive minification. Identifiers become binding
 * order, property names and strings are kept, number and boolean spellings are canonicalized
 * (`!0` is `true`, `1e3` is `1000`), and the rewrites minifiers apply to control flow
 * (`a&&b()` for `if(a)b()`, `return a?b:c` for `if(a)return b;return c`, sequences, `===` to
 * `==`, flipped comparisons) are undone. A nested function contributes only its own hash to its
 * parent, so each node is visited once.
 */
class Printer {
  readonly functions: FunctionPrint[] = [];
  readonly strings: StringPrint[] = [];
  readonly #hash = hasher();
  #scope = new Scope();
  #depth = 0;

  program(program: Node): void {
    this.stmts(nodes(program, "body"));
  }

  // --- units ---------------------------------------------------------------------------------

  /** Hash a function in its own scope; returns the token its parent sees. */
  fn(n: Node): string {
    const outer = this.#scope;
    const scope = new Scope();
    this.#scope = scope;
    const t = scope.tokens;
    t.push("fn", n.async ? "async" : "", n.generator ? "gen" : "");
    const params = nodes(n, "params");
    t.push(`p${params.length}`);
    for (const p of params) this.pattern(p);
    const body = node(n, "body");
    if (body?.type === "BlockStatement") this.stmts(nodes(body, "body"));
    else if (body) this.returnOf(body);
    this.#scope = outer;
    outer.size += scope.size;
    return `F${this.#finish(n, scope)}`;
  }

  /** A class body is one unit; its methods are units of their own inside it. */
  cls(n: Node): string {
    const outer = this.#scope;
    const scope = new Scope();
    this.#scope = scope;
    const t = scope.tokens;
    t.push("class");
    const sup = node(n, "superClass");
    if (sup) {
      t.push("extends");
      this.expr(sup);
    }
    for (const member of nodes(node(n, "body") ?? n, "body")) {
      if (!member) continue;
      scope.size++;
      t.push(member.type, member.static ? "static" : "", String(member.kind ?? ""));
      if (member.type === "StaticBlock") {
        this.stmts(nodes(member, "body"));
        continue;
      }
      this.key(member);
      const value = node(member, "value");
      if (value) this.expr(value);
    }
    this.#scope = outer;
    outer.size += scope.size;
    return `C${this.#finish(n, scope)}`;
  }

  #finish(n: Node, scope: Scope): string {
    const hash = this.#hash(scope.tokens.join("\u0001"));
    if (scope.size >= MIN_FUNCTION_NODES)
      this.functions.push({ hash, start: n.start, end: n.end, nodes: scope.size });
    return hashHex(hash);
  }

  // --- statements ----------------------------------------------------------------------------

  /** Blocks are flattened, so `if(a)b()` and `if(a){b()}` match. */
  #flat(list: (Node | null)[], out: Node[] = []): Node[] {
    for (const s of list) {
      if (!s || s.type === "EmptyStatement") continue;
      if (s.type === "BlockStatement") this.#flat(nodes(s, "body"), out);
      else out.push(s);
    }
    return out;
  }

  stmts(list: (Node | null)[]): void {
    const flat = this.#flat(list);
    for (let i = 0; i < flat.length; i++) {
      const s = flat[i] as Node;
      // `if(a){…;return x} rest` is `if(a){…;return x}else{rest}`: the form terser folds into
      // `return a?x:…`.
      if (s.type === "IfStatement" && !s.alternate && i < flat.length - 1) {
        const cons = this.#flat([node(s, "consequent") ?? null]);
        const last = cons[cons.length - 1]?.type;
        if (last === "ReturnStatement" || last === "ThrowStatement") {
          const rest = flat.slice(i + 1);
          this.#if(
            node(s, "test") as Node,
            () => this.stmts(cons),
            () => this.stmts(rest),
          );
          return;
        }
      }
      this.stmt(s);
    }
  }

  stmt(s: Node): void {
    if (this.#depth > MAX_DEPTH) {
      this.#scope.tokens.push("deep");
      return;
    }
    this.#depth++;
    try {
      this.#stmt(s);
    } finally {
      this.#depth--;
    }
  }

  #stmt(s: Node): void {
    const t = this.#scope.tokens;
    this.#scope.size++;
    switch (s.type) {
      case "ExpressionStatement":
        this.exprStmt(node(s, "expression") as Node);
        return;
      case "IfStatement": {
        const alt = node(s, "alternate");
        this.#if(
          node(s, "test") as Node,
          () => this.stmts([node(s, "consequent") ?? null]),
          alt ? () => this.stmts([alt]) : null,
        );
        return;
      }
      case "ReturnStatement": {
        const arg = node(s, "argument");
        if (arg) this.returnOf(arg);
        else t.push("return");
        return;
      }
      case "ThrowStatement":
        t.push("throw");
        this.expr(this.#lead(node(s, "argument") as Node));
        return;
      case "VariableDeclaration":
        for (const d of nodes(s, "declarations")) if (d) this.#declarator(d);
        return;
      case "FunctionDeclaration":
        t.push("decl");
        this.#ident(node(s, "id"));
        t.push(this.fn(s));
        return;
      case "ClassDeclaration":
        t.push("decl");
        this.#ident(node(s, "id"));
        t.push(this.cls(s));
        return;
      case "ForStatement": {
        const init = node(s, "init");
        const update = node(s, "update");
        // `for(;x;)` is how terser writes `while(x)`.
        if (!init && !update) {
          t.push("while");
          this.#optExpr(node(s, "test"));
        } else {
          t.push("for");
          if (init?.type === "VariableDeclaration") this.stmt(init);
          else this.#optExpr(init);
          this.#optExpr(node(s, "test"));
          this.#optExpr(update);
        }
        this.#body(node(s, "body"));
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        t.push(s.type === "ForInStatement" ? "forin" : s.await ? "forawait" : "forof");
        const left = node(s, "left") as Node;
        if (left.type === "VariableDeclaration") {
          const first = nodes(left, "declarations")[0];
          this.pattern(first ? node(first, "id") : null);
        } else this.pattern(left);
        this.expr(node(s, "right") as Node);
        this.#body(node(s, "body"));
        return;
      }
      case "WhileStatement":
        t.push("while");
        this.expr(node(s, "test") as Node);
        this.#body(node(s, "body"));
        return;
      case "DoWhileStatement":
        t.push("do");
        this.#body(node(s, "body"));
        this.expr(node(s, "test") as Node);
        return;
      case "SwitchStatement":
        t.push("switch");
        this.expr(node(s, "discriminant") as Node);
        for (const c of nodes(s, "cases")) {
          if (!c) continue;
          const test = node(c, "test");
          if (test) {
            t.push("case");
            this.expr(test);
          } else t.push("default");
          this.stmts(nodes(c, "consequent"));
        }
        t.push("}");
        return;
      case "TryStatement": {
        t.push("try");
        this.#body(node(s, "block"));
        const handler = node(s, "handler");
        if (handler) {
          t.push("catch");
          this.pattern(node(handler, "param"));
          this.#body(node(handler, "body"));
        }
        const finalizer = node(s, "finalizer");
        if (finalizer) {
          t.push("finally");
          this.#body(finalizer);
        }
        return;
      }
      case "LabeledStatement":
        t.push("label");
        this.#body(node(s, "body"));
        return;
      case "BreakStatement":
      case "ContinueStatement":
        t.push(s.type === "BreakStatement" ? "break" : "continue", s.label ? "L" : "");
        return;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration": {
        const decl = node(s, "declaration");
        if (!decl) return;
        if (decl.type.endsWith("Declaration")) this.stmt(decl);
        else this.exprStmt(decl);
        return;
      }
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        return;
      default:
        this.#generic(s);
    }
  }

  #body(n: Node | null | undefined): void {
    const t = this.#scope.tokens;
    t.push("{");
    if (n) this.stmts([n]);
    t.push("}");
  }

  #optExpr(n: Node | null | undefined): void {
    if (n) this.expr(n);
    else this.#scope.tokens.push("_");
  }

  #declarator(d: Node): void {
    this.#scope.tokens.push("let");
    this.pattern(node(d, "id"));
    this.#optExpr(node(d, "init"));
  }

  /** `a(), b()` in statement position: the leading items become statements, the last is returned. */
  #lead(e: Node): Node {
    let cur = e;
    while (cur.type === "SequenceExpression") {
      const items = nodes(cur, "expressions").filter((x): x is Node => !!x);
      for (const item of items.slice(0, -1)) this.exprStmt(item);
      cur = items[items.length - 1] as Node;
    }
    return cur;
  }

  exprStmt(e: Node): void {
    const cur = this.#lead(e);
    const t = this.#scope.tokens;
    if (cur.type === "LogicalExpression" && (cur.operator === "&&" || cur.operator === "||")) {
      const right = node(cur, "right") as Node;
      const left = node(cur, "left") as Node;
      if (cur.operator === "&&") this.#if(left, () => this.exprStmt(right), null);
      else this.#if(left, () => this.exprStmt(right), null, true);
      return;
    }
    if (cur.type === "ConditionalExpression") {
      this.#if(
        node(cur, "test") as Node,
        () => this.exprStmt(node(cur, "consequent") as Node),
        () => this.exprStmt(node(cur, "alternate") as Node),
      );
      return;
    }
    if (cur.type === "UpdateExpression") {
      // The value is unused, so `i++` and `++i` are the same statement.
      t.push(`up${cur.operator}`);
      this.expr(node(cur, "argument") as Node);
      return;
    }
    t.push("expr");
    this.expr(cur);
  }

  returnOf(arg: Node): void {
    const cur = this.#lead(arg);
    if (cur.type === "ConditionalExpression") {
      this.#if(
        node(cur, "test") as Node,
        () => this.returnOf(node(cur, "consequent") as Node),
        () => this.returnOf(node(cur, "alternate") as Node),
      );
      return;
    }
    const t = this.#scope.tokens;
    if (this.#isUndefined(cur)) {
      t.push("return");
      return;
    }
    t.push("return");
    this.expr(cur);
  }

  #isUndefined(n: Node): boolean {
    return (
      (n.type === "UnaryExpression" &&
        n.operator === "void" &&
        node(n, "argument")?.type === "Literal") ||
      (n.type === "Identifier" && n.name === "undefined")
    );
  }

  /** `if`, with negations peeled off the test and branches swapped so `!a` never leads an else. */
  #if(test: Node, cons: () => void, alt: (() => void) | null, negated = false): void {
    // Ternary chains in return position recurse through here, not through `expr`.
    if (this.#depth > MAX_DEPTH) {
      this.#scope.tokens.push("deep");
      return;
    }
    this.#depth++;
    try {
      this.#ifInner(test, cons, alt, negated);
    } finally {
      this.#depth--;
    }
  }

  #ifInner(test: Node, cons: () => void, alt: (() => void) | null, negated: boolean): void {
    let neg = negated;
    let cur = this.#lead(test);
    while (cur.type === "UnaryExpression" && cur.operator === "!") {
      const arg = node(cur, "argument") as Node;
      if (arg.type === "Literal" && typeof arg.value === "number") break;
      neg = !neg;
      cur = arg;
    }
    let first = cons;
    let second = alt;
    if (alt && neg) {
      first = alt;
      second = cons;
      neg = false;
    }
    const t = this.#scope.tokens;
    t.push("if", neg ? "not" : "");
    this.expr(cur);
    t.push("{");
    first();
    t.push("}");
    if (second) {
      t.push("else{");
      second();
      t.push("}");
    }
  }

  // --- expressions ---------------------------------------------------------------------------

  expr(e: Node): void {
    const scope = this.#scope;
    const t = scope.tokens;
    if (this.#depth > MAX_DEPTH) {
      t.push("deep");
      return;
    }
    this.#depth++;
    scope.size++;
    try {
      this.#expr(e, t);
    } finally {
      this.#depth--;
    }
  }

  #expr(e: Node, t: string[]): void {
    switch (e.type) {
      case "Identifier":
        this.#ident(e);
        return;
      case "PrivateIdentifier":
        t.push(`#${this.#scope.name(`#${e.name as string}`)}`);
        return;
      case "Literal":
        t.push(this.#literal(e));
        return;
      case "TemplateLiteral": {
        const quasis = nodes(e, "quasis");
        const exprs = nodes(e, "expressions");
        if (exprs.length === 0) {
          const cooked = this.#cooked(quasis[0] ?? null);
          this.#string(cooked, e.start);
          t.push(`s:${cooked}`);
          return;
        }
        t.push(`tpl${exprs.length}`);
        quasis.forEach((q, i) => {
          const cooked = this.#cooked(q);
          this.#string(cooked, q?.start ?? e.start);
          t.push(`q:${cooked}`);
          const x = exprs[i];
          if (x) this.expr(x);
        });
        return;
      }
      case "TaggedTemplateExpression":
        t.push("tag");
        this.expr(node(e, "tag") as Node);
        this.expr(node(e, "quasi") as Node);
        return;
      case "UnaryExpression": {
        const arg = node(e, "argument") as Node;
        const op = e.operator as string;
        if (op === "!" && arg.type === "Literal" && (arg.value === 0 || arg.value === 1)) {
          t.push(arg.value === 0 ? "b:true" : "b:false");
          return;
        }
        if (op === "!" && isBoolLiteral(arg)) {
          t.push(arg.value ? "b:false" : "b:true");
          return;
        }
        if (op === "void" && arg.type === "Literal") {
          t.push("g:undefined");
          return;
        }
        if (op === "-" && arg.type === "Literal" && typeof arg.value === "number") {
          t.push(`n:${-arg.value}`);
          return;
        }
        t.push(`u${op}`);
        this.expr(arg);
        return;
      }
      case "BinaryExpression":
        this.#binary(e, t);
        return;
      case "LogicalExpression":
        t.push(`l${e.operator as string}`);
        this.expr(node(e, "left") as Node);
        this.expr(node(e, "right") as Node);
        return;
      case "AssignmentExpression": {
        const left = node(e, "left") as Node;
        const right = node(e, "right") as Node;
        let op = e.operator as string;
        let value = right;
        // `a = a + b` is `a += b`.
        if (
          op === "=" &&
          left.type === "Identifier" &&
          right.type === "BinaryExpression" &&
          COMPOUND.has(right.operator as string) &&
          node(right, "left")?.type === "Identifier" &&
          node(right, "left")?.name === left.name
        ) {
          op = `${right.operator as string}=`;
          value = node(right, "right") as Node;
        }
        t.push(`a${op}`);
        this.pattern(left);
        this.expr(value);
        return;
      }
      case "UpdateExpression":
        t.push(`up${e.operator as string}${e.prefix ? "pre" : "post"}`);
        this.expr(node(e, "argument") as Node);
        return;
      case "MemberExpression":
        this.expr(node(e, "object") as Node);
        if (e.optional) t.push("?.");
        this.#property(e, t);
        return;
      case "ChainExpression":
        this.expr(node(e, "expression") as Node);
        return;
      case "CallExpression":
      case "NewExpression": {
        let callee = node(e, "callee") as Node;
        // `(0, x.y)(…)` calls `x.y` without a `this`; bundlers write imports that way.
        const items = callee.type === "SequenceExpression" ? nodes(callee, "expressions") : [];
        if (items.length === 2 && isLiteral(items[0])) callee = items[1] as Node;
        const args = nodes(e, "arguments");
        t.push(
          `${e.type === "NewExpression" ? "new" : "call"}${args.length}`,
          e.optional ? "?." : "",
        );
        this.expr(callee);
        for (const a of args) if (a) this.expr(a);
        return;
      }
      case "SequenceExpression": {
        const items = nodes(e, "expressions");
        t.push(`seq${items.length}`);
        for (const x of items) if (x) this.expr(x);
        return;
      }
      case "ConditionalExpression": {
        let test = node(e, "test") as Node;
        let cons = node(e, "consequent") as Node;
        let alt = node(e, "alternate") as Node;
        while (test.type === "UnaryExpression" && test.operator === "!") {
          const arg = node(test, "argument") as Node;
          if (arg.type === "Literal") break;
          test = arg;
          [cons, alt] = [alt, cons];
        }
        t.push("?:");
        this.expr(test);
        this.expr(cons);
        this.expr(alt);
        return;
      }
      case "ArrayExpression": {
        const items = nodes(e, "elements");
        t.push(`[${items.length}`);
        for (const x of items) {
          if (x) this.expr(x);
          else t.push("hole");
        }
        return;
      }
      case "ObjectExpression": {
        const props = nodes(e, "properties");
        t.push(`{${props.length}`);
        for (const p of props) {
          if (!p) continue;
          if (p.type === "SpreadElement") {
            t.push("...");
            this.expr(node(p, "argument") as Node);
            continue;
          }
          t.push(String(p.kind ?? "init"));
          this.key(p);
          this.expr(node(p, "value") as Node);
        }
        return;
      }
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        t.push(this.fn(e));
        return;
      case "ClassExpression":
        t.push(this.cls(e));
        return;
      case "ThisExpression":
        t.push("this");
        return;
      case "Super":
        t.push("super");
        return;
      case "MetaProperty":
        t.push(`meta:${node(e, "meta")?.name as string}.${node(e, "property")?.name as string}`);
        return;
      case "SpreadElement":
        t.push("...");
        this.expr(node(e, "argument") as Node);
        return;
      case "AwaitExpression":
        t.push("await");
        this.expr(node(e, "argument") as Node);
        return;
      case "YieldExpression": {
        t.push(e.delegate ? "yield*" : "yield");
        const arg = node(e, "argument");
        if (arg) this.expr(arg);
        return;
      }
      case "ImportExpression":
        t.push("import()");
        this.expr(node(e, "source") as Node);
        return;
      case "ParenthesizedExpression":
        this.expr(node(e, "expression") as Node);
        return;
      case "ObjectPattern":
      case "ArrayPattern":
      case "AssignmentPattern":
      case "RestElement":
        this.pattern(e);
        return;
      default:
        this.#generic(e);
    }
  }

  #binary(e: Node, t: string[]): void {
    let op = e.operator as string;
    let left = node(e, "left") as Node;
    let right = node(e, "right") as Node;
    if (op === "/" && right.type === "Literal" && right.value === 0 && left.type === "Literal") {
      // terser writes Infinity as 1/0.
      t.push(
        left.value === 1 ? "g:Infinity" : left.value === 0 ? "g:NaN" : `n:${String(left.value)}/0`,
      );
      return;
    }
    if (op === "===") op = "==";
    if (op === "!==") op = "!=";
    // esbuild writes `typeof x === "undefined"` as `typeof x > "u"`.
    if (
      (op === ">" || op === "<") &&
      isTypeof(left) &&
      right.type === "Literal" &&
      right.value === "u"
    ) {
      t.push(op === ">" ? "b==" : "b!=");
      this.expr(left);
      t.push("s:undefined");
      return;
    }
    if (op in SWAP) {
      op = SWAP[op] as string;
      [left, right] = [right, left];
    }
    if ((op === "==" || op === "!=") && isLiteral(left) && !isLiteral(right)) {
      [left, right] = [right, left];
    }
    if ((op === "==" || op === "!=") && isTypeof(right) && !isTypeof(left)) {
      [left, right] = [right, left];
    }
    t.push(`b${op}`);
    this.expr(left);
    this.expr(right);
  }

  #property(e: Node, t: string[]): void {
    const prop = node(e, "property") as Node;
    if (!e.computed) {
      if (prop.type === "PrivateIdentifier") this.expr(prop);
      else t.push(`.${prop.name as string}`);
      return;
    }
    if (prop.type === "Literal" && typeof prop.value === "string" && IDENT.test(prop.value)) {
      t.push(`.${prop.value}`);
      return;
    }
    t.push("[");
    this.expr(prop);
  }

  /** An object or class member key: `a`, `"a"` and `["a"]` are the same key. */
  key(p: Node): void {
    const t = this.#scope.tokens;
    const key = node(p, "key") as Node;
    if (key.type === "PrivateIdentifier") {
      this.expr(key);
      return;
    }
    if (!p.computed && key.type === "Identifier") {
      t.push(`k:${key.name as string}`);
      return;
    }
    if (
      key.type === "Literal" &&
      (typeof key.value === "string" || typeof key.value === "number")
    ) {
      t.push(`k:${String(key.value)}`);
      return;
    }
    t.push("k[");
    this.expr(key);
  }

  pattern(p: Node | null | undefined): void {
    const t = this.#scope.tokens;
    if (!p) {
      t.push("_");
      return;
    }
    this.#scope.size++;
    switch (p.type) {
      case "Identifier":
        this.#ident(p);
        return;
      case "ObjectPattern":
        t.push(`{p${nodes(p, "properties").length}`);
        for (const prop of nodes(p, "properties")) {
          if (!prop) continue;
          if (prop.type === "RestElement") {
            this.pattern(prop);
            continue;
          }
          this.key(prop);
          this.pattern(node(prop, "value"));
        }
        return;
      case "ArrayPattern":
        t.push(`[p${nodes(p, "elements").length}`);
        for (const el of nodes(p, "elements")) this.pattern(el);
        return;
      case "AssignmentPattern":
        t.push("=");
        this.pattern(node(p, "left"));
        this.expr(node(p, "right") as Node);
        return;
      case "RestElement":
        t.push("...");
        this.pattern(node(p, "argument"));
        return;
      default:
        this.expr(p);
    }
  }

  #ident(id: Node | null | undefined): void {
    const t = this.#scope.tokens;
    if (!id) {
      t.push("_");
      return;
    }
    const name = id.name as string;
    t.push(GLOBALS.has(name) || name === "undefined" ? `g:${name}` : this.#scope.name(name));
  }

  #literal(e: Node): string {
    if (e.regex) {
      const r = e.regex as { pattern: string; flags: string };
      return `r:${r.pattern}/${r.flags}`;
    }
    if (e.bigint) return `i:${e.bigint as string}`;
    const v = e.value;
    if (v === null) return "null";
    if (typeof v === "string") {
      this.#string(v, e.start);
      return `s:${v}`;
    }
    if (typeof v === "boolean") return `b:${v}`;
    return `n:${String(v)}`;
  }

  #cooked(q: Node | null): string {
    const value = (q?.value ?? {}) as { cooked?: string | null; raw?: string };
    return value.cooked ?? value.raw ?? "";
  }

  #string(value: string, start: number): void {
    if (value.length >= MIN_STRING_LENGTH)
      this.strings.push({ hash: this.#hash(`str\u0001${value}`), start, value });
  }

  /** Anything not handled above: its type, scalar fields, then child nodes in key order. */
  #generic(n: Node): void {
    const t = this.#scope.tokens;
    t.push(n.type);
    for (const [k, v] of Object.entries(n)) {
      if (k === "type" || k === "start" || k === "end") continue;
      if (Array.isArray(v)) {
        for (const item of v)
          if (item && typeof item === "object" && "type" in item) this.#child(item as Node);
      } else if (v && typeof v === "object" && "type" in v) this.#child(v as Node);
      else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        t.push(`${k}=${String(v)}`);
    }
  }

  #child(n: Node): void {
    if (n.type.endsWith("Statement") || n.type.endsWith("Declaration")) this.stmt(n);
    else this.expr(n);
  }
}

/**
 * Parse code with oxc and fingerprint every function of at least `MIN_FUNCTION_NODES` nodes, plus
 * every string literal of at least `MIN_STRING_LENGTH` characters. The builder and the matcher
 * both go through here.
 */
export async function fingerprintCode(code: string, filename = "bundle.js"): Promise<CodePrints> {
  await loadHasher();
  return fingerprintCodeSync(code, filename);
}

/** `fingerprintCode` for callers that already awaited `loadHasher()`. */
export function fingerprintCodeSync(code: string, filename = "bundle.js"): CodePrints {
  let program: Node;
  let errors: { message: string }[];
  try {
    const result = parseSync(filename, code, { sourceType: "unambiguous", preserveParens: false });
    program = result.program as unknown as Node;
    errors = result.errors;
  } catch (error) {
    return { functions: [], strings: [], error: (error as Error).message };
  }
  const printer = new Printer();
  const body = nodes(program, "body");
  if (body.length === 0 && errors.length > 0)
    return { functions: [], strings: [], error: errors[0]?.message ?? "parse error" };
  try {
    printer.program(program);
  } catch (error) {
    // A stack overflow on a pathological bundle: keep what was hashed before it, so one odd file
    // costs its own evidence and never the whole run.
    if (!(error instanceof RangeError)) throw error;
    return { functions: printer.functions, strings: printer.strings, error: error.message };
  }
  return { functions: printer.functions, strings: printer.strings, error: null };
}
