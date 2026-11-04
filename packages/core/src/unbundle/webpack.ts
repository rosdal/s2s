import type * as t from "@babel/types";
import {
  applyEdits,
  type Binding,
  end,
  literalValue,
  memberName,
  moduleSpecifier,
  type NodePath,
  parseCode,
  quote,
  removeExpression,
  renameBinding,
  start,
  type TextEdit,
  traverse,
} from "./ast.js";
import type { ChunkTable } from "./split.js";
import type { ChunkInput, Draft, ImportLine, UnpackContext } from "./types.js";
import { coveringPackage, wrapperEdits } from "./vendor.js";

type FnPath = NodePath<t.Function>;

interface Factory {
  id: string;
  path: FnPath;
  chunk: ChunkInput;
  group: string;
}

interface RuntimeInfo {
  group: string;
  publicPath: string | null;
  entries: Set<string>;
}

const GROUP = /\b(webpack(?:Chunk|Jsonp)[\w$]*)/;

/**
 * Split webpack bundles on their real module maps. Module ids are shared by every chunk of one
 * build (one `webpackChunk…` array), so maps spread over many chunks are merged by id, and each
 * module's `require(id)` resolves to whichever chunk defines it.
 */
export function unpackWebpack(
  chunks: ChunkInput[],
  ctx: UnpackContext,
): { drafts: Draft[]; tables: Map<string, ChunkTable>; handled: Set<string> } {
  const factories: Factory[] = [];
  const runtimeChunks = new Set<string>();
  const inlined: {
    chunk: ChunkInput;
    group: string;
    scope: FnPath;
    from: number;
    to: number;
    require: Binding;
  }[] = [];
  const runtimes = new Map<string, RuntimeInfo>();
  const runtimeOf = (group: string): RuntimeInfo => {
    let info = runtimes.get(group);
    if (!info) {
      info = { group, publicPath: null, entries: new Set() };
      runtimes.set(group, info);
    }
    return info;
  };
  const functionsOf = new Map<ChunkInput, NodePath[]>();

  for (const chunk of chunks) {
    let ast: t.File;
    try {
      ast = parseCode(chunk.code);
    } catch (error) {
      ctx.warn(`${chunk.url}: does not parse (${(error as Error).message.split("\n")[0]})`);
      continue;
    }
    const fnByNode = new Map<t.Node, FnPath>();
    const functions: NodePath[] = [];
    let requireFn: FnPath | undefined;
    const pushes: NodePath<t.CallExpression>[] = [];
    traverse(ast, {
      Function(path) {
        fnByNode.set(path.node, path);
        functions.push(path);
        if (!requireFn && isRequireFunction(path)) requireFn = path;
      },
      CallExpression(path) {
        const callee = path.node.callee;
        if (callee.type !== "MemberExpression" || memberName(callee) !== "push") return;
        const arg = path.node.arguments[0];
        if (arg?.type !== "ArrayExpression") return;
        const [ids, map] = arg.elements;
        if (
          ids?.type === "ArrayExpression" &&
          (map?.type === "ObjectExpression" || map?.type === "ArrayExpression")
        )
          pushes.push(path);
      },
    });
    functionsOf.set(chunk, functions);
    const fileGroup = GROUP.exec(chunk.code)?.[1] ?? `chunk:${chunk.name}`;

    for (const push of pushes) {
      const callee = push.node.callee as t.MemberExpression;
      const group =
        GROUP.exec(chunk.code.slice(start(callee.object), end(callee.object)))?.[1] ?? fileGroup;
      const [, map, runtime] = (push.node.arguments[0] as t.ArrayExpression).elements;
      for (const [id, fn] of moduleEntries(map as t.Node)) {
        const path = fnByNode.get(fn);
        if (path) factories.push({ id, path, chunk, group });
      }
      if (
        runtime &&
        (runtime.type === "ArrowFunctionExpression" || runtime.type === "FunctionExpression")
      ) {
        for (const id of entryCalls(runtime)) runtimeOf(group).entries.add(id);
      }
    }

    if (requireFn) {
      runtimeChunks.add(chunk.url);
      const info = runtimeOf(fileGroup);
      const scan = scanRuntime(requireFn, chunk.code);
      if (scan.publicPath !== null) info.publicPath = scan.publicPath;
      for (const id of scan.entries) info.entries.add(id);
      if (scan.map) {
        for (const [id, fn] of moduleEntries(scan.map)) {
          const path = fnByNode.get(fn);
          if (path) factories.push({ id, path, chunk, group: fileGroup });
        }
      }
      if (scan.inlined && scan.scope && scan.requireBinding)
        inlined.push({
          chunk,
          group: fileGroup,
          scope: scan.scope,
          ...scan.inlined,
          require: scan.requireBinding,
        });
    }
  }

  // ES modules among the factories: they mark their exports with `require.r` / `require.d`.
  const harmonyKeys = new Set<string>();
  for (const f of factories) {
    const param = f.path.node.params[2];
    if (param?.type !== "Identifier") continue;
    const body = f.chunk.code.slice(start(f.path.node), end(f.path.node));
    const name = param.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\w$])${name}\\.[rd]\\(`).test(body))
      harmonyKeys.add(`${f.group}:${f.id}`);
  }
  // The first chunk to define a module id owns it; later copies are duplicates.
  const seen = new Set<string>();
  const drafts: Draft[] = [];
  for (const f of factories) {
    const key = `${f.group}:${f.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const info = runtimeOf(f.group);
    const draft = fromFactory(f, key, info, functionsOf.get(f.chunk) ?? [], ctx, harmonyKeys);
    draft.entry = info.entries.has(f.id);
    drafts.push(draft);
  }
  for (const entry of inlined) {
    const key = `${entry.group}:entry:${entry.chunk.name}`;
    const info = runtimeOf(entry.group);
    const draft = fromStatements(
      entry,
      key,
      info,
      functionsOf.get(entry.chunk) ?? [],
      ctx,
      harmonyKeys,
    );
    draft.entry = true;
    drafts.push(draft);
  }

  // Whole modules inside a vendor range are dropped; so is a module that only re-exports one.
  if (!ctx.keepVendor) {
    for (const d of drafts) {
      // A CommonJS wrapper nested inside the module is replaced in place, not counted here: a
      // concatenated entry module can be mostly inlined vendor code and still be first-party.
      const own = d.chunk.vendor.filter(
        (s) => s.moduleKind !== "cjs-wrapper" || (s.start <= d.start + 2 && s.end >= d.end - 2),
      );
      const span = coveringPackage(own, d.start, d.end);
      if (span) d.vendor = { package: span.package, version: span.version };
    }
    const byKey = new Map(drafts.map((d) => [d.key, d]));
    for (let changed = true; changed; ) {
      changed = false;
      for (const d of drafts) {
        if (d.vendor) continue;
        const target = reexportTarget(d.code);
        const vendor = target ? byKey.get(target)?.vendor : undefined;
        if (vendor) {
          d.vendor = vendor;
          changed = true;
        }
      }
    }
  }

  // Dynamic imports of a chunk land on the module that chunk's runtime starts, if any.
  const tables = new Map<string, ChunkTable>();
  for (const chunk of chunks) {
    const own = drafts.filter((d) => d.chunk === chunk && !d.vendor);
    tables.set(chunk.url, {
      entry: (own.find((d) => d.entry) ?? own[0])?.key ?? null,
      exports: new Map(),
    });
  }
  for (const f of factories) runtimeChunks.add(f.chunk.url);
  return { drafts, tables, handled: runtimeChunks };
}

/** `function r(n) { … e[n](…) … return m.exports }`, webpack's runtime `require`. */
function isRequireFunction(path: FnPath): boolean {
  const node = path.node;
  const param = node.params[0];
  if (param?.type !== "Identifier" || node.params.length !== 1) return false;
  const body = node.body;
  if (body.type !== "BlockStatement" || end(body) - start(body) > 600) return false;
  let callsMap = false;
  let returnsExports = false;
  path.traverse({
    MemberExpression(member) {
      const m = member.node;
      if (m.computed && m.property.type === "Identifier" && m.property.name === param.name) {
        const parent = member.parent;
        if (parent.type === "CallExpression" && parent.callee === m) callsMap = true;
        if (parent.type === "MemberExpression" && memberName(parent) === "call") callsMap = true;
      }
      if (memberName(m) === "exports") returnsExports = true;
    },
  });
  return callsMap && returnsExports;
}

interface RuntimeScan {
  map: t.Node | undefined;
  publicPath: string | null;
  entries: string[];
  scope?: FnPath;
  requireBinding?: Binding;
  inlined?: { from: number; to: number };
}

function scanRuntime(requireFn: FnPath, code: string): RuntimeScan {
  const out: RuntimeScan = { map: undefined, publicPath: null, entries: [] };
  const param = (requireFn.node.params[0] as t.Identifier).name;
  // The map is the object indexed by the module id.
  let mapName: string | undefined;
  requireFn.traverse({
    MemberExpression(member) {
      const m = member.node;
      if (
        !mapName &&
        m.computed &&
        m.property.type === "Identifier" &&
        m.property.name === param &&
        m.object.type === "Identifier"
      ) {
        const parent = member.parent;
        if (
          (parent.type === "CallExpression" && parent.callee === m) ||
          (parent.type === "MemberExpression" && memberName(parent) === "call")
        )
          mapName = m.object.name;
      }
    },
  });
  const id = requireFn.node.type === "FunctionDeclaration" ? requireFn.node.id : undefined;
  const requireBinding = id ? requireFn.parentPath?.scope.getBinding(id.name) : undefined;
  if (mapName) {
    const binding = requireFn.scope.getBinding(mapName);
    const node = binding?.path.node;
    if (
      node?.type === "VariableDeclarator" &&
      (node.init?.type === "ObjectExpression" || node.init?.type === "ArrayExpression")
    ) {
      out.map = node.init;
    } else if (binding?.kind === "param") {
      // webpack 4: `!function(e){…}([…modules])`.
      const fn = binding.path.parentPath;
      const index = fn?.isFunction()
        ? (fn.node as t.Function).params.indexOf(binding.path.node as t.Identifier)
        : -1;
      const call = fn?.parentPath;
      const callNode = call?.isCallExpression()
        ? call.node
        : call?.parentPath?.isCallExpression()
          ? call.parentPath.node
          : undefined;
      const arg =
        callNode && index >= 0 ? (callNode as t.CallExpression).arguments[index] : undefined;
      if (arg && (arg.type === "ObjectExpression" || arg.type === "ArrayExpression")) out.map = arg;
    }
  }
  if (requireBinding) {
    out.requireBinding = requireBinding;
    for (const ref of requireBinding.referencePaths) {
      const member = ref.parentPath;
      if (!member?.isMemberExpression() || member.node.object !== ref.node) continue;
      const assign = member.parentPath;
      if (!assign?.isAssignmentExpression() || assign.node.left !== member.node) continue;
      const name = memberName(member.node);
      const value = literalValue(assign.node.right);
      if (name === "p" && value !== undefined) out.publicPath = value;
      if (name === "s" && value !== undefined) out.entries.push(value);
    }
    // webpack 5 single-file builds inline the entry module after the runtime.
    const scope = requireFn.parentPath?.isBlockStatement() ? requireFn.parentPath : undefined;
    const fn = scope?.parentPath;
    if (scope && fn?.isFunction()) {
      out.scope = fn as FnPath;
      const statements = scope.get("body") as NodePath<t.Statement>[];
      const entry = statements.filter((s) => !isRuntimeStatement(s, requireBinding, code));
      const first = entry[0];
      const last = entry.at(-1);
      if (first && last) out.inlined = { from: start(first.node), to: end(last.node) };
    }
  }
  return out;
}

/** Runtime setup: the module map and cache, `require` itself, `r.x = …` and runtime IIFEs. */
function isRuntimeStatement(path: NodePath<t.Statement>, require: Binding, code: string): boolean {
  const node = path.node;
  if (node.type === "FunctionDeclaration") return true;
  if (node.type === "ExpressionStatement" && node.expression.type === "StringLiteral") return true;
  if (node.type === "VariableDeclaration") {
    return node.declarations.every((d) => {
      const init = d.init;
      if (!init) return true;
      if (init.type === "ObjectExpression" || init.type === "ArrayExpression") return true;
      // `n = self.webpackChunk… = …` and other runtime wiring.
      return GROUP.test(code.slice(start(init), end(init)));
    });
  }
  if (node.type !== "ExpressionStatement") return false;
  const expressions =
    node.expression.type === "SequenceExpression" ? node.expression.expressions : [node.expression];
  const name = require.identifier.name;
  return expressions.every((e) => {
    if (e.type === "AssignmentExpression" && e.left.type === "MemberExpression") {
      return e.left.object.type === "Identifier" && e.left.object.name === name;
    }
    let call: t.Node = e;
    if (call.type === "UnaryExpression") call = call.argument;
    if (call.type === "CallExpression") {
      const callee =
        call.callee.type === "ParenthesizedExpression" ? call.callee.expression : call.callee;
      if (callee.type === "FunctionExpression" || callee.type === "ArrowFunctionExpression")
        return true;
      // `r(r.s = 3)` and `r.O()` start the entry; they are not module code.
      if (callee.type === "Identifier" && callee.name === name && call.arguments.length === 1) {
        const arg = call.arguments[0];
        return arg?.type === "AssignmentExpression" || arg?.type === "NumericLiteral";
      }
      if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === name
      )
        return true;
    }
    return false;
  });
}

/** The module functions of a map, `{123: fn}`, `{123(e,t,n){…}}` or `[fn, fn]`. */
function moduleEntries(map: t.Node): [string, t.Node][] {
  const out: [string, t.Node][] = [];
  if (map.type === "ObjectExpression") {
    for (const p of map.properties) {
      if (p.type === "ObjectMethod" && !p.computed) {
        const id = literalValue(p.key) ?? (p.key.type === "Identifier" ? p.key.name : undefined);
        if (id !== undefined) out.push([id, p]);
      } else if (p.type === "ObjectProperty" && !p.computed) {
        const id = literalValue(p.key) ?? (p.key.type === "Identifier" ? p.key.name : undefined);
        const value = p.value;
        if (
          id !== undefined &&
          (value.type === "FunctionExpression" || value.type === "ArrowFunctionExpression")
        )
          out.push([id, value]);
      }
    }
  } else if (map.type === "ArrayExpression") {
    for (const [i, el] of map.elements.entries()) {
      if (el && (el.type === "FunctionExpression" || el.type === "ArrowFunctionExpression"))
        out.push([String(i), el]);
    }
  }
  return out;
}

/** Module ids a jsonp chunk's runtime callback starts: `e => e(501)`, `e(e.s = 501)`. */
function entryCalls(fn: t.Node): string[] {
  const ids: string[] = [];
  const param = (fn as t.Function).params[0];
  if (param?.type !== "Identifier") return ids;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as t.Node;
    if (
      n.type === "CallExpression" &&
      n.callee.type === "Identifier" &&
      n.callee.name === param.name
    ) {
      const arg = n.arguments[0];
      const value =
        literalValue(arg) ??
        (arg?.type === "AssignmentExpression" ? literalValue(arg.right) : undefined);
      if (value !== undefined) ids.push(value);
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && "type" in value) visit(value);
    }
  };
  visit((fn as t.Function).body);
  return ids;
}

/** `module.exports = require("s2s-module:K")` and nothing else: the key it re-exports. */
function reexportTarget(code: string): string | undefined {
  const match =
    /^\s*(?:"use strict";?\s*)?module\.exports\s*=\s*require\("s2s-module:([^"]+)"\);?\s*$/.exec(
      code,
    );
  return match?.[1];
}

function freshName(scope: FnPath, wanted: string): string {
  const taken = new Set<string>();
  scope.traverse({
    Scope(p) {
      for (const name of Object.keys(p.scope.bindings)) taken.add(name);
    },
  });
  for (const name of Object.keys(scope.scope.bindings)) taken.add(name);
  let name = wanted;
  while (taken.has(name)) name = `_${name}`;
  return name;
}

interface Roles {
  module?: Binding;
  exports?: Binding;
  require?: Binding;
}

function fromFactory(
  f: Factory,
  key: string,
  info: RuntimeInfo,
  functions: NodePath[],
  ctx: UnpackContext,
  harmonyKeys: Set<string>,
): Draft {
  const node = f.path.node;
  const params = node.params.map((p) =>
    p.type === "Identifier" ? f.path.scope.getBinding(p.name) : undefined,
  );
  const roles: Roles = {};
  if (params[0]) roles.module = params[0];
  if (params[1]) roles.exports = params[1];
  if (params[2]) roles.require = params[2];
  const body = node.body;
  const block = body.type === "BlockStatement";
  const from = block ? start(body) + 1 : start(body);
  const to = block ? end(body) - 1 : end(body);
  return buildModule({
    harmonyKeys,
    key,
    id: f.id,
    chunk: f.chunk,
    scope: f.path,
    from,
    to,
    span: [start(node), end(node)],
    roles,
    info,
    functions,
    expressionBody: !block,
    ctx,
  });
}

function fromStatements(
  entry: { chunk: ChunkInput; scope: FnPath; from: number; to: number; require: Binding },
  key: string,
  info: RuntimeInfo,
  functions: NodePath[],
  ctx: UnpackContext,
  harmonyKeys: Set<string>,
): Draft {
  return buildModule({
    harmonyKeys,
    key,
    id: "entry",
    chunk: entry.chunk,
    scope: entry.scope,
    from: entry.from,
    to: entry.to,
    span: [entry.from, entry.to],
    roles: { require: entry.require },
    info,
    functions,
    expressionBody: false,
    ctx,
  });
}

interface BuildInput {
  /** Modules that are ES modules (they call `require.r` or `require.d`). */
  harmonyKeys: Set<string>;
  key: string;
  id: string;
  chunk: ChunkInput;
  scope: FnPath;
  from: number;
  to: number;
  span: [number, number];
  roles: Roles;
  info: RuntimeInfo;
  functions: NodePath[];
  expressionBody: boolean;
  ctx: UnpackContext;
}

interface ExportItem {
  name: string;
  local?: string;
  expr?: [number, number];
}

/**
 * One webpack module as an ES module: the factory's `(module, exports, require)` parameters get
 * their real names, `require.d` export tables become `export` lists, `require(id)` points at the
 * module's key, and `require.e(…).then(require.bind(require, id))` becomes `import()`.
 */
function buildModule(input: BuildInput): Draft {
  const { chunk, scope, from, to, roles, info } = input;
  const code = chunk.code;
  const group = info.group;
  const edits: TextEdit[] = [];
  const head: ImportLine[] = [];
  const notes: string[] = [];
  const exportItems: ExportItem[] = [];
  let harmony = false;
  const spec = (id: string) => quote(moduleSpecifier(`${group}:${id}`));
  const inside = (n: t.Node) => start(n) >= from && end(n) <= to;

  const names = {
    module: roles.module ? freshName(scope, "module") : "module",
    exports: roles.exports ? freshName(scope, "exports") : "exports",
    require: roles.require ? freshName(scope, "require") : "require",
  };
  if (roles.module && roles.module.identifier.name !== names.module)
    edits.push(...renameBinding(roles.module, names.module));
  if (roles.exports && roles.exports.identifier.name !== names.exports)
    edits.push(...renameBinding(roles.exports, names.exports));

  const requireRefs = roles.require?.referencePaths.filter((r) => inside(r.node)) ?? [];
  const isExportsRef = (n: t.Node | undefined) =>
    n?.type === "Identifier" &&
    roles.exports !== undefined &&
    n.name === roles.exports.identifier.name;

  for (const ref of requireRefs) {
    const parent = ref.parentPath;
    if (!parent) continue;
    // require(id)
    if (parent.isCallExpression() && parent.node.callee === ref.node) {
      const id = literalValue(parent.node.arguments[0]);
      if (id === undefined) continue;
      edits.push({
        start: start(parent.node),
        end: end(parent.node),
        text: `${names.require}(${spec(id)})`,
      });
      continue;
    }
    if (!parent.isMemberExpression() || parent.node.object !== ref.node) {
      edits.push({ start: start(ref.node), end: end(ref.node), text: names.require });
      continue;
    }
    const member = memberName(parent.node);
    const call =
      parent.parentPath?.isCallExpression() && parent.parentPath.node.callee === parent.node
        ? parent.parentPath
        : undefined;
    switch (member) {
      case "r":
        if (call) {
          harmony = true;
          edits.push(removeExpression(call));
          continue;
        }
        break;
      case "d":
        if (call && isExportsRef(call.node.arguments[0] as t.Node)) {
          harmony = true;
          exportItems.push(...exportTable(call.node, scope));
          edits.push(removeExpression(call));
          continue;
        }
        break;
      case "n":
        if (call) {
          const arg = call.node.arguments[0];
          if (arg) {
            const x = `(${applyEdits(code, edits, start(arg), end(arg))})`;
            const value = `${x} && ${x}.__esModule ? ${x}.default : ${x}`;
            edits.push({
              start: start(call.node),
              end: end(call.node),
              text: `Object.assign(() => (${value}), { a: ${value} })`,
            });
            continue;
          }
        }
        break;
      case "o":
        if (call) {
          edits.push({
            start: start(parent.node),
            end: end(parent.node),
            text: "Object.prototype.hasOwnProperty.call",
          });
          continue;
        }
        break;
      case "g":
        edits.push({ start: start(parent.node), end: end(parent.node), text: "globalThis" });
        continue;
      case "p":
        edits.push({
          start: start(parent.node),
          end: end(parent.node),
          text: quote(info.publicPath ?? "/"),
        });
        continue;
      case "e": {
        const dynamic = dynamicImport(call, roles.require as Binding);
        if (dynamic) {
          edits.push({
            start: start(dynamic.call.node),
            end: end(dynamic.call.node),
            text: `import(${spec(dynamic.id)})`,
          });
          continue;
        }
        break;
      }
      case "t":
        if (call) {
          const id = literalValue(call.node.arguments[0]);
          if (id !== undefined) {
            edits.push({
              start: start(call.node),
              end: end(call.node),
              text: `${names.require}(${spec(id)})`,
            });
            continue;
          }
        }
        break;
    }
    edits.push({ start: start(ref.node), end: end(ref.node), text: names.require });
    if (member && !notes.includes(member)) notes.push(member);
  }

  // `var a = require(id)` at the top of an ES module, or of any module when `id` is an ES
  // module, is `import * as a`: webpack hands over the target's namespace object.
  const imports = new Set<string>();
  const esTarget = (d: t.VariableDeclarator) => {
    const id = d.init?.type === "CallExpression" ? literalValue(d.init.arguments[0]) : undefined;
    return id !== undefined && input.harmonyKeys.has(`${group}:${id}`);
  };
  if (roles.require) {
    const bodyPath = input.scope.get("body") as NodePath;
    const statements =
      input.expressionBody || !bodyPath.isBlockStatement()
        ? []
        : (bodyPath.get("body") as NodePath<t.Statement>[]).filter((s) => inside(s.node));
    for (const statement of statements) {
      if (!statement.isVariableDeclaration()) continue;
      const decls = statement.node.declarations;
      const isImport = (d: t.VariableDeclarator) =>
        d.id.type === "Identifier" &&
        d.init?.type === "CallExpression" &&
        d.init.callee.type === "Identifier" &&
        d.init.callee.name === roles.require?.identifier.name &&
        literalValue(d.init.arguments[0]) !== undefined &&
        (harmony || esTarget(d));
      if (!decls.some(isImport)) continue;
      const rest: string[] = [];
      const lines: string[] = [];
      for (const d of decls) {
        if (isImport(d)) {
          const local = (d.id as t.Identifier).name;
          lines.push(
            `import * as ${local} from ${spec(literalValue((d.init as t.CallExpression).arguments[0]) as string)};`,
          );
          imports.add(local);
        } else rest.push(applyEdits(code, edits, start(d), end(d)));
      }
      const tail = rest.length > 0 ? `\n${statement.node.kind} ${rest.join(", ")};` : "";
      edits.push({
        start: start(statement.node),
        end: end(statement.node),
        text: lines.join("\n") + tail,
      });
    }
  }

  // Vendor code inside a kept module (CommonJS wrappers in a concatenated module).
  let vendorBytesRemoved = 0;
  if (!input.ctx.keepVendor && chunk.vendor.length > 0) {
    const local = chunk.vendor.filter((s) => s.start >= from && s.end <= to);
    const inner = input.functions.filter((p) => start(p.node) >= from && end(p.node) <= to);
    const wrappers = wrapperEdits(inner, local);
    edits.push(...wrappers.edits);
    head.push(...wrappers.imports);
    vendorBytesRemoved += wrappers.removed;
  }

  let text = applyEdits(code, edits, from, to);
  if (input.expressionBody) text = `${text};`;
  const lines: string[] = [];
  const specifiers: string[] = [];
  for (const item of exportItems) {
    if (item.local) {
      specifiers.push(item.local === item.name ? item.local : `${item.local} as ${item.name}`);
    } else if (item.expr) {
      const local = `__export_${item.name.replace(/[^\w$]/g, "_")}`;
      lines.push(`const ${local} = ${applyEdits(code, edits, item.expr[0], item.expr[1])};`);
      specifiers.push(`${local} as ${item.name}`);
    }
  }
  if (specifiers.length > 0) lines.push(`export { ${specifiers.join(", ")} };`);
  const out = lines.length > 0 ? `${text}\n${lines.join("\n")}\n` : `${text}\n`;
  if (notes.length > 0)
    input.ctx.warn(
      `${chunk.url}: module ${input.id} uses webpack runtime helpers ${notes.map((n) => `require.${n}`).join(", ")}`,
    );
  return {
    key: input.key,
    id: input.id,
    chunk,
    start: input.span[0],
    end: input.span[1],
    boundary: "real",
    code: out,
    head,
    entry: false,
    source: null,
    notes: notes.map(
      (n) => `uses the webpack runtime helper require.${n}, which has no ES module equivalent`,
    ),
    vendor: null,
    vendorBytesRemoved,
  };
}

/** Exports from `r.d(exports, {name: () => x})`, `r.d(exports, ["A", 0, value])` or v4's `r.d(e, "a", fn)`. */
function exportTable(call: t.CallExpression, scope: FnPath): ExportItem[] {
  const [, table, getter] = call.arguments;
  const items: ExportItem[] = [];
  const add = (name: string | undefined, value: t.Node | null | undefined, isGetter: boolean) => {
    if (name === undefined || !value) return;
    const returned = isGetter ? getterResult(value) : (value as t.Expression);
    if (!returned) return;
    if (returned.type === "Identifier" && scope.scope.getOwnBinding(returned.name))
      items.push({ name, local: returned.name });
    else items.push({ name, expr: [start(returned), end(returned)] });
  };
  if (table?.type === "ObjectExpression") {
    for (const p of table.properties) {
      if (p.type === "SpreadElement") continue;
      const name = literalValue(p.key) ?? (p.key.type === "Identifier" ? p.key.name : undefined);
      add(name, p.type === "ObjectMethod" ? p : p.value, true);
    }
  } else if (table?.type === "ArrayExpression") {
    const els = table.elements;
    for (let i = 0; i < els.length; ) {
      const name = literalValue(els[i]);
      const kind = els[i + 1];
      if (kind?.type === "NumericLiteral" && kind.value === 0) {
        add(name, els[i + 2], false);
        i += 3;
      } else {
        add(name, kind, true);
        i += 2;
      }
    }
  } else if (table && getter) {
    add(literalValue(table), getter, true);
  }
  return items;
}

/** What `() => x`, `function () { return x }` or `get() { return x }` returns. */
function getterResult(node: t.Node): t.Expression | undefined {
  if (
    node.type !== "ArrowFunctionExpression" &&
    node.type !== "FunctionExpression" &&
    node.type !== "ObjectMethod"
  )
    return undefined;
  const body = node.body;
  if (body.type !== "BlockStatement") return body as t.Expression;
  const ret = body.body[0];
  return ret?.type === "ReturnStatement" && ret.argument ? ret.argument : undefined;
}

/** `require.e(c).then(require.bind(require, id))` and friends: the `.then` call and the id. */
function dynamicImport(
  eCall: NodePath | undefined,
  require: Binding,
): { call: NodePath; id: string } | undefined {
  if (!eCall) return undefined;
  let p: NodePath | null = eCall;
  // `Promise.all([require.e(1), require.e(2)])`
  if (p.parentPath?.isArrayExpression() && p.parentPath.parentPath?.isCallExpression())
    p = p.parentPath.parentPath;
  const member = p.parentPath;
  const then = member?.parentPath;
  if (
    !member?.isMemberExpression() ||
    memberName(member.node) !== "then" ||
    !then?.isCallExpression()
  )
    return undefined;
  const arg = then.node.arguments[0];
  const name = require.identifier.name;
  const isRequire = (n: t.Node | undefined | null) => n?.type === "Identifier" && n.name === name;
  let id: string | undefined;
  if (
    arg?.type === "CallExpression" &&
    arg.callee.type === "MemberExpression" &&
    memberName(arg.callee) === "bind"
  ) {
    const target = arg.callee.object;
    if (
      isRequire(target) ||
      (target.type === "MemberExpression" && isRequire(target.object) && memberName(target) === "t")
    )
      id = literalValue(arg.arguments[1]);
  } else if (arg && (arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression")) {
    const result = getterResult(arg);
    if (result?.type === "CallExpression") {
      const callee = result.callee;
      if (
        isRequire(callee) ||
        (callee.type === "MemberExpression" &&
          isRequire(callee.object) &&
          memberName(callee) === "t")
      )
        id = literalValue(result.arguments[0]);
    }
  }
  return id === undefined ? undefined : { call: then, id };
}
