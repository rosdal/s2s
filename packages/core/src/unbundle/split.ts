import type * as t from "@babel/types";
import {
  applyEdits,
  type Binding,
  end,
  literalValue,
  type NodePath,
  parseCode,
  quote,
  start,
  type TextEdit,
  traverse,
} from "./ast.js";
import {
  type Boundary,
  type ChunkInput,
  chunkSpecifier,
  type Draft,
  type ImportLine,
  type UnpackContext,
} from "./types.js";
import { coveringPackage, vendorImport, wrapperEdits } from "./vendor.js";

/** One statement of the scope being split. */
interface Unit {
  index: number;
  node: t.Statement;
  start: number;
  end: number;
  declares: string[];
  /** Units whose bindings this one reads, by binding name. */
  uses: Map<string, number>;
  /** Bindings of other units this one assigns to. */
  writes: Set<number>;
  imports: { local: string; source: string; imported: string }[];
  sideEffectImport: string | null;
  /** Names the chunk exports from this unit, as `[exported, local]`. */
  exported: [string, string][];
  edits: TextEdit[];
  dropped: { package: string; version: string | null } | null;
  bytes: number;
  /** For one declarator of `var a = …, b = …`: the keyword its text needs to stand alone. */
  keyword?: string;
  /** `var a = wrap((e, m) => { m.exports = b() })`: a wrapper that only re-exports `b`. */
  aliasOf?: { name: string; target: string; start: number; end: number };
}

/** A CommonJS wrapper whose whole body is `module.exports = other()`. */
function aliasOf(node: t.Statement): Unit["aliasOf"] {
  if (node.type !== "VariableDeclaration" || node.declarations.length !== 1) return undefined;
  const d = node.declarations[0];
  const init = d?.init;
  if (d?.id.type !== "Identifier" || init?.type !== "CallExpression") return undefined;
  const fn = init.arguments[0];
  if (fn?.type !== "ArrowFunctionExpression" && fn?.type !== "FunctionExpression") return undefined;
  const body = fn.body.type === "BlockStatement" ? fn.body.body : [];
  const only = body.length === 1 ? body[0] : undefined;
  const expr = only?.type === "ExpressionStatement" ? only.expression : undefined;
  if (expr?.type !== "AssignmentExpression" || expr.operator !== "=") return undefined;
  const left = expr.left;
  const right = expr.right;
  if (
    left.type !== "MemberExpression" ||
    left.property.type !== "Identifier" ||
    left.property.name !== "exports"
  )
    return undefined;
  if (right.type !== "CallExpression" || right.callee.type !== "Identifier") return undefined;
  if (right.arguments.length > 0) return undefined;
  return { name: d.id.name, target: right.callee.name, start: start(init), end: end(init) };
}

export type SplitMode = "rollup" | "esbuild" | "whole";

const unwrap = (s: string) => s.replace(/\s+/g, "");

/** Classify a helper by the shape of its definition, minified or not. */
function helperKind(text: string): "cjs" | "esm" | "export" | undefined {
  const flat = unwrap(text);
  if (/\{exports:\{\}\}/.test(flat) && /\.exports/.test(flat)) return "cjs";
  if (/=[\w$]+\(\(?[\w$]+=0\)?\)|\(0,[\w$]+\[[\w$]+\([\w$]+\)\[0\]\]\)\([\w$]+=0\)/.test(flat))
    return "esm";
  if (/for\(var[\w$]+in[\w$]+\)/.test(flat) && /get:[\w$]+\[[\w$]+\]/.test(flat)) return "export";
  return undefined;
}

/** The call a declaration's init makes, when it is `helper(fn)` or `helper({ "path"() {} })`. */
function wrapperCall(unit: t.Statement): { helper: string } | undefined {
  if (unit.type !== "VariableDeclaration" || unit.declarations.length !== 1) return undefined;
  const init = unit.declarations[0]?.init;
  if (init?.type !== "CallExpression" || init.callee.type !== "Identifier") return undefined;
  const arg = init.arguments[0];
  const isFactory =
    arg?.type === "ArrowFunctionExpression" ||
    arg?.type === "FunctionExpression" ||
    (arg?.type === "ObjectExpression" && arg.properties.length === 1);
  return isFactory ? { helper: init.callee.name } : undefined;
}

/**
 * Split one scope-hoisted chunk (Rollup, Vite/Rolldown, esbuild, or anything kept whole) into
 * parts by its top-level statements, then give each part the imports and exports it needs to
 * stand alone. Parts come from, in order of trust: a partial source map's file ranges, path
 * comments the bundler left, esbuild/Rolldown module wrappers, and otherwise clusters of the
 * reference graph.
 */
export function splitScope(
  chunk: ChunkInput,
  ctx: UnpackContext,
  mode: SplitMode,
): { drafts: Draft[]; table: ChunkTable } {
  const code = chunk.code;
  const ast = parseCode(code);
  let container: NodePath<t.Program> | NodePath<t.BlockStatement> | undefined;
  let programPath: NodePath<t.Program> | undefined;
  const functions: NodePath[] = [];
  traverse(ast, {
    Program(path) {
      programPath = path;
    },
    Function(path) {
      functions.push(path);
    },
  });
  const empty = { drafts: [], table: { entry: null, exports: new Map() } };
  if (!programPath) return empty;
  container = programPath;
  // A whole-file IIFE (esbuild's `(() => {…})()`, webpack-free scripts) holds the real top level.
  const body = programPath.get("body");
  if (body.length <= 2) {
    for (const statement of body) {
      if (!statement.isExpressionStatement()) continue;
      let expr = statement.get("expression") as NodePath;
      if (expr.isUnaryExpression()) expr = expr.get("argument") as NodePath;
      if (!expr.isCallExpression()) continue;
      const callee = expr.get("callee") as NodePath;
      const fn = callee.isParenthesizedExpression() ? callee.get("expression") : callee;
      if (
        (fn as NodePath).isFunction() &&
        end(fn.node as t.Node) - start(fn.node as t.Node) > code.length * 0.5
      ) {
        const fnBody = (fn as NodePath<t.Function>).get("body");
        if (fnBody.isBlockStatement()) container = fnBody;
      }
    }
  }
  const scope = container.scope;
  const statements = container.get("body") as NodePath<t.Statement>[];
  // Minifiers merge every top-level `var` into one statement; each declarator is its own unit, so
  // module wrappers and unrelated bindings in one statement can land in different parts.
  const pieces: { node: t.Statement; start: number; end: number; keyword?: string }[] = [];
  for (const path of statements) {
    const node = path.node;
    if (node.type === "VariableDeclaration" && node.declarations.length > 1) {
      for (const [i, d] of node.declarations.entries()) {
        const single: t.VariableDeclaration = {
          ...node,
          declarations: [d],
          start: d.start ?? null,
          end: d.end ?? null,
          leadingComments: i === 0 ? (node.leadingComments ?? null) : null,
        };
        pieces.push({ node: single, start: start(d), end: end(d), keyword: node.kind });
      }
    } else {
      pieces.push({ node, start: start(node), end: end(node) });
    }
  }
  const units: Unit[] = pieces.map((piece, index) => ({
    index,
    node: piece.node,
    start: piece.start,
    end: piece.end,
    declares: [],
    uses: new Map(),
    writes: new Set(),
    imports: [],
    sideEffectImport: null,
    exported: [],
    edits: [],
    dropped: null,
    bytes: piece.end - piece.start,
    ...(piece.keyword ? { keyword: piece.keyword } : {}),
  }));
  if (units.length === 0) return empty;
  const unitAt = (at: number): number => {
    let lo = 0;
    let hi = units.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const u = units[mid] as Unit;
      if (at < u.start) hi = mid - 1;
      else if (at >= u.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  };

  for (const unit of units) {
    const alias = aliasOf(unit.node);
    if (alias) unit.aliasOf = alias;
  }
  // Bindings of the split scope: who declares, reads and writes each.
  const declaredIn = new Map<string, number>();
  const refsOf = new Map<string, number[]>();
  const getterCalls = new Map<string, [number, number][]>();
  const bindings = Object.entries(scope.bindings) as [string, Binding][];
  for (const [name, binding] of bindings) {
    if (binding.scope !== scope) continue;
    const at = unitAt(start(binding.path.node));
    if (at < 0) continue;
    declaredIn.set(name, at);
    (units[at] as Unit).declares.push(name);
    for (const ref of binding.referencePaths) {
      const user = unitAt(start(ref.node));
      refsOf.set(name, [...(refsOf.get(name) ?? []), start(ref.node)]);
      const call = ref.parentPath;
      if (
        call?.isCallExpression() &&
        call.node.callee === ref.node &&
        call.node.arguments.length === 0
      )
        getterCalls.set(name, [
          ...(getterCalls.get(name) ?? []),
          [start(call.node), end(call.node)],
        ]);
      if (user >= 0 && user !== at) (units[user] as Unit).uses.set(name, at);
    }
    for (const violation of binding.constantViolations) {
      const writer = unitAt(start(violation.node));
      if (writer >= 0 && writer !== at) (units[writer] as Unit).writes.add(at);
    }
  }

  // Module syntax of an ESM chunk: imports become per-part import lines, exports per-part exports.
  for (const unit of units) {
    const node = unit.node;
    if (node.type === "ImportDeclaration") {
      const source = node.source.value;
      if (node.specifiers.length === 0) unit.sideEffectImport = source;
      for (const s of node.specifiers) {
        const imported =
          s.type === "ImportDefaultSpecifier"
            ? "default"
            : s.type === "ImportNamespaceSpecifier"
              ? "*"
              : (literalValue(s.imported) ?? (s.imported as t.Identifier).name);
        unit.imports.push({ local: s.local.name, source, imported });
      }
      unit.edits.push({ start: unit.start, end: unit.end, text: "" });
    } else if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        unit.edits.push({ start: unit.start, end: start(node.declaration), text: "" });
        for (const name of unit.declares) unit.exported.push([name, name]);
      } else {
        if (node.source)
          ctx.warn(
            `${chunk.url}: re-export from ${node.source.value} is not carried over; modules that import it need fixing`,
          );
        else {
          for (const s of node.specifiers) {
            if (s.type !== "ExportSpecifier") continue;
            const exported = literalValue(s.exported) ?? (s.exported as t.Identifier).name;
            const localName = literalValue(s.local) ?? (s.local as t.Identifier).name;
            const at = declaredIn.get(localName);
            if (at !== undefined) (units[at] as Unit).exported.push([exported, localName]);
          }
          unit.edits.push({ start: unit.start, end: unit.end, text: "" });
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      const named =
        decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration" ? decl.id : null;
      if (named) {
        unit.edits.push({ start: unit.start, end: start(decl), text: "" });
        unit.exported.push(["default", named.name]);
        if (!unit.declares.includes(named.name)) unit.declares.push(named.name);
      } else {
        unit.edits.push({ start: unit.start, end: start(decl), text: "const __default = " });
        if (!code.slice(unit.start, unit.end).trimEnd().endsWith(";"))
          unit.edits.push({ start: unit.end, end: unit.end, text: ";" });
        unit.exported.push(["default", "__default"]);
        unit.declares.push("__default");
      }
    } else if (node.type === "ExportAllDeclaration") {
      ctx.warn(
        `${chunk.url}: export * from ${node.source.value} is not carried over; modules that import it need fixing`,
      );
      unit.edits.push({ start: unit.start, end: unit.end, text: "" });
    }
  }

  // Dynamic imports of sibling chunks point at the chunk until parts are placed.
  traverse(ast, {
    ImportExpression(path) {
      const arg = path.node.source;
      const value = literalValue(arg);
      if (!arg || value === undefined) return;
      const at = unitAt(start(path.node));
      if (at < 0) return;
      const url = resolveUrl(value, chunk.url);
      if (url)
        (units[at] as Unit).edits.push({
          start: start(arg),
          end: end(arg),
          text: quote(chunkSpecifier(url)),
        });
    },
  });

  // Vendor code: CommonJS wrappers become package getters (and wrappers that only re-export one
  // become getters too); statements inside a range go; getters nothing reads any more go.
  const vendorImports = new Map<number, ImportLine[]>();
  const removed = (pos: number): boolean => {
    const u = units[unitAt(pos)];
    if (u?.dropped) return true;
    return Boolean(u?.edits.some((e) => e.end > e.start && e.start <= pos && pos < e.end));
  };
  if (!ctx.keepVendor && chunk.vendor.length > 0) {
    const wrappers = wrapperEdits(functions, chunk.vendor);
    const attach = (edit: TextEdit, line: ImportLine | undefined) => {
      const at = unitAt(edit.start);
      if (at < 0) return;
      (units[at] as Unit).edits.push(edit);
      if (line) vendorImports.set(at, [...(vendorImports.get(at) ?? []), line]);
    };
    for (const edit of wrappers.edits)
      attach(
        edit,
        wrappers.imports.find((i) => edit.text.endsWith(i.namespace ?? "\0")),
      );
    const getters = wrappers.getters;
    const cjs = new Set<string>();
    for (const unit of units) {
      if (unit.node.type !== "VariableDeclaration") continue;
      for (const d of unit.node.declarations) {
        if (d.id.type !== "Identifier" || !d.init) continue;
        if (d.init.type !== "ArrowFunctionExpression" && d.init.type !== "FunctionExpression")
          continue;
        if (helperKind(code.slice(start(d.init), end(d.init))) === "cjs") cjs.add(d.id.name);
      }
    }
    const toGetter = (name: string, from: number, to: number, line: ImportLine) => {
      attach({ start: from, end: to, text: `() => ${line.namespace}` }, line);
      for (const [s, e] of getterCalls.get(name) ?? [])
        attach({ start: s, end: e, text: line.namespace ?? "" }, line);
      getters.set(name, line);
    };
    // Statements (nearly) all inside one package's ranges: a CommonJS wrapper becomes a getter,
    // anything else goes. Source-map ranges come in runs with unmapped gaps, hence "nearly".
    const rest = chunk.vendor.filter((s) => !wrappers.covered.includes(s));
    for (const unit of units) {
      if (unit.edits.some((e) => e.text.startsWith("() => __vendor_"))) continue;
      const span = coveringPackage(rest, unit.start, unit.end);
      if (!span) continue;
      const call = wrapperCall(unit.node);
      const d = (unit.node as t.VariableDeclaration).declarations?.[0];
      if (call && cjs.has(call.helper) && d?.id.type === "Identifier" && d.init) {
        toGetter(d.id.name, start(d.init), end(d.init), vendorImport(span));
      } else {
        unit.dropped = { package: span.package, version: span.version };
      }
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const unit of units) {
        const alias = unit.aliasOf;
        const line = alias ? getters.get(alias.target) : undefined;
        if (!alias || !line || getters.has(alias.name)) continue;
        toGetter(alias.name, alias.start, alias.end, line);
        changed = true;
      }
    }
    for (const [name, line] of getters) {
      const at = declaredIn.get(name);
      const unit = at === undefined ? undefined : units[at];
      if (!unit || unit.dropped || unit.exported.length > 0) continue;
      const target = line.target as { name: string };
      if ((refsOf.get(name) ?? []).every(removed))
        unit.dropped = { package: target.name, version: null };
    }
    // CommonJS wrappers that only removed vendor code read (scheduler under react-dom) are
    // dead now; wrappers are lazy, so dropping them changes nothing.
    for (let changed = true; changed; ) {
      changed = false;
      for (const unit of units) {
        if (unit.dropped || unit.exported.length > 0) continue;
        const call = wrapperCall(unit.node);
        const name = unit.declares[0];
        if (!call || !cjs.has(call.helper) || !name) continue;
        if ((refsOf.get(name) ?? []).every(removed)) {
          unit.dropped = { package: "", version: null };
          changed = true;
        }
      }
    }
  }
  let vendorBytesRemoved = 0;
  for (const unit of units) {
    if (unit.dropped) vendorBytesRemoved += unit.bytes;
    else
      for (const e of unit.edits)
        if (e.text.startsWith("() => __vendor_")) vendorBytesRemoved += e.end - e.start;
  }

  // 1. Which part each statement belongs to.
  const assignment = assignParts(chunk, units, ctx, mode, declaredIn);

  // 2. Parts must not assign to each other's bindings (imports are read-only): merge them.
  const parent = assignment.part.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i] as number] as number;
    return i;
  };
  for (const unit of units) {
    for (const target of unit.writes) {
      const a = find(assignment.part[unit.index] as number);
      const b = find(assignment.part[target] as number);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const partOf = (unit: number) => find(assignment.part[unit] as number);

  // 3. Build one draft per part, numbered in source order.
  const firstUnit = new Map<number, number>();
  for (const unit of units) {
    const p = partOf(unit.index);
    if (!unit.dropped && !isModuleSyntaxOnly(unit) && !firstUnit.has(p))
      firstUnit.set(p, unit.index);
  }
  const firstOf = (p: number) => firstUnit.get(p) ?? Number.MAX_SAFE_INTEGER;
  const partIds = [
    ...new Set(
      units.filter((u) => !u.dropped && !isModuleSyntaxOnly(u)).map((u) => partOf(u.index)),
    ),
  ].sort((a, b) => firstOf(a) - firstOf(b));
  const order = new Map(partIds.map((p, i) => [p, i + 1]));
  const single = partIds.length === 1;
  const keyOf = (part: number) =>
    `${chunk.name}/${mode === "whole" && single ? "index" : `part-${order.get(part)}`}`;
  const drafts: Draft[] = [];
  const exportsOf = new Map<number, Set<string>>();
  const needExport = (part: number, name: string) => {
    const set = exportsOf.get(part) ?? new Set<string>();
    set.add(name);
    exportsOf.set(part, set);
  };
  const heads = new Map<number, ImportLine[]>();
  const addHead = (part: number, line: ImportLine) => {
    const list = heads.get(part) ?? [];
    list.push(line);
    heads.set(part, list);
  };
  const importOf = new Map<string, Unit["imports"][number]>();
  for (const unit of units) for (const i of unit.imports) importOf.set(i.local, i);

  for (const unit of units) {
    if (unit.dropped || isModuleSyntaxOnly(unit)) continue;
    const part = partOf(unit.index);
    for (const [name, at] of unit.uses) {
      // A reference that a vendor edit replaced is gone; it needs no import.
      const here = (refsOf.get(name) ?? []).filter((p) => p >= unit.start && p < unit.end);
      if (here.length > 0 && here.every(removed)) continue;
      const owner = units[at] as Unit;
      const imp = importOf.get(name);
      if (imp) {
        const url = resolveUrl(imp.source, chunk.url);
        const line: ImportLine = url
          ? { target: { kind: "chunk-export", url, name: imp.imported }, names: [] }
          : { target: { kind: "package", name: imp.source }, names: [] };
        if (imp.imported === "*") line.namespace = name;
        else line.names.push({ imported: imp.imported, local: name });
        addHead(part, line);
        continue;
      }
      if (owner.dropped) {
        addHead(part, {
          target: { kind: "package", name: owner.dropped.package },
          names: [],
          namespace: name,
          note: `${name} was a binding inside ${owner.dropped.package}'s inlined code; import what it stands for instead`,
        });
        continue;
      }
      const ownerPart = partOf(at);
      if (ownerPart === part) continue;
      needExport(ownerPart, name);
      addHead(part, {
        target: { kind: "module", key: keyOf(ownerPart) },
        names: [{ imported: name, local: name }],
      });
    }
    for (const line of vendorImports.get(unit.index) ?? []) addHead(part, line);
  }
  // Side-effect imports of other chunks run before the first part.
  const firstPart = partIds[0];
  for (const unit of units) {
    if (unit.sideEffectImport === null || firstPart === undefined) continue;
    const url = resolveUrl(unit.sideEffectImport, chunk.url);
    if (url && !/\.css(?:$|\?)/.test(url))
      addHead(firstPart, { target: { kind: "chunk-export", url, name: "" }, names: [] });
  }

  const exportedLocals = new Map<number, [string, string][]>();
  for (const unit of units) {
    if (unit.dropped) continue;
    for (const pair of unit.exported) {
      const part = partOf(unit.index);
      exportedLocals.set(part, [...(exportedLocals.get(part) ?? []), pair]);
    }
  }
  const defaultPart = partIds.find((p) =>
    (exportedLocals.get(p) ?? []).some(([e]) => e === "default"),
  );
  const entryPart = defaultPart ?? partIds.at(-1);

  for (const part of partIds) {
    const members = units.filter(
      (u) => !u.dropped && partOf(u.index) === part && !isModuleSyntaxOnly(u),
    );
    if (members.length === 0) continue;
    const text = members
      .map((u) => {
        const body = applyEdits(code, u.edits, u.start, u.end);
        return u.keyword ? `${u.keyword} ${body};` : body;
      })
      .join("\n");
    const specifiers: string[] = [];
    for (const name of [...(exportsOf.get(part) ?? [])].sort()) specifiers.push(name);
    // Chunk exports are reached through their local names (see the chunk table), so a part never
    // exports two names that could clash; only `default` keeps its name, for dynamic imports.
    for (const [exported, local] of exportedLocals.get(part) ?? [])
      specifiers.push(exported === "default" ? `${local} as default` : local);
    const unique = [...new Set(specifiers)];
    const tail = unique.length > 0 ? `\nexport { ${unique.join(", ")} };\n` : "\n";
    const first = members[0] as Unit;
    const last = members.at(-1) as Unit;
    const removedHere = units
      .filter((u) => u.dropped && partOf(u.index) === part)
      .reduce((n, u) => n + u.bytes, 0);
    drafts.push({
      key: keyOf(part),
      id: keyOf(part).slice(chunk.name.length + 1),
      chunk,
      start: first.start,
      end: last.end,
      spans: members.map((u) => [u.start, u.end] as [number, number]),
      boundary: assignment.boundary.get(part) ?? "heuristic",
      code: text + tail,
      head: dedupeHead(heads.get(part) ?? []),
      entry: part === entryPart,
      source: assignment.source.get(part) ?? null,
      notes: [],
      vendor: null,
      vendorBytesRemoved: removedHere,
    });
  }
  // Dropped statements that no part claimed still count as removed vendor code.
  const counted = drafts.reduce((n, d) => n + d.vendorBytesRemoved, 0);
  const firstDraft = drafts[0];
  if (firstDraft) firstDraft.vendorBytesRemoved += Math.max(0, vendorBytesRemoved - counted);
  const chunkExports = new Map<string, { key: string; local: string }>();
  for (const [part, pairs] of exportedLocals)
    for (const [exported, local] of pairs)
      chunkExports.set(exported, { key: keyOf(find(part)), local });
  return {
    drafts,
    table: { entry: entryPart === undefined ? null : keyOf(entryPart), exports: chunkExports },
  };
}

function isModuleSyntaxOnly(unit: Unit): boolean {
  const type = unit.node.type;
  return (
    type === "ImportDeclaration" ||
    (type === "ExportNamedDeclaration" && !(unit.node as t.ExportNamedDeclaration).declaration)
  );
}

function dedupeHead(lines: ImportLine[]): ImportLine[] {
  const out: ImportLine[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const id = JSON.stringify(line);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(line);
  }
  return out;
}

export function resolveUrl(spec: string, base: string): string | undefined {
  if (!/^(?:\.{1,2}\/|\/|https?:)/.test(spec)) return undefined;
  try {
    const url = new URL(spec, base);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** Per chunk: which module a dynamic import lands on, and which module holds each export. */
export interface ChunkTable {
  entry: string | null;
  exports: Map<string, { key: string; local: string }>;
}

interface Assignment {
  part: number[];
  boundary: Map<number, Boundary>;
  source: Map<number, string>;
}

const PATH_COMMENT =
  /^\s*(?:#region\s+)?((?:[\w@.~-]+\/)*[\w@.~-]+\.(?:[cm]?[jt]sx?|vue|svelte|css))\s*$/;

function assignParts(
  chunk: ChunkInput,
  units: Unit[],
  ctx: UnpackContext,
  mode: SplitMode,
  declaredIn: Map<string, number>,
): Assignment {
  const part = units.map(() => 0);
  const boundary = new Map<number, Boundary>();
  const source = new Map<number, string>();
  if (mode === "whole") {
    boundary.set(0, "real");
    return { part, boundary, source };
  }

  // a. File ranges from a partial source map, or path comments the bundler left.
  const labels: (string | null)[] = units.map((u) => labelFromMap(chunk, u) ?? null);
  // `some`, not `every(l => l === null)`: the latter narrows the array's type to `null[]`.
  if (!labels.some((l) => l !== null)) {
    let current: string | null = null;
    for (const [i, unit] of units.entries()) {
      for (const comment of unit.node.leadingComments ?? []) {
        const text = comment.value;
        if (/^\s*#endregion/.test(text)) current = null;
        const match = PATH_COMMENT.exec(text);
        if (match?.[1]) current = match[1];
      }
      labels[i] = current;
    }
  }
  if (labels.some((l) => l !== null)) {
    // Unlabelled statements (bundler glue) stay with the file before them.
    let current = labels.find((l) => l !== null) ?? null;
    let id = -1;
    let previous: string | null | undefined;
    for (const [i] of units.entries()) {
      const label = labels[i] ?? current;
      current = label;
      if (label !== previous) {
        id++;
        boundary.set(id, "real");
        if (label) source.set(id, label);
        previous = label;
      }
      part[i] = id;
    }
    return { part, boundary, source };
  }

  // b. Module wrappers: `var x = __commonJS(…)` is one module; `var ns = {}; __export(ns, {…});
  //    …; var init = __esm(…)` is another.
  const helpers = new Map<string, ReturnType<typeof helperKind>>();
  for (const unit of units) {
    if (unit.node.type !== "VariableDeclaration") continue;
    for (const d of unit.node.declarations) {
      if (d.id.type !== "Identifier" || !d.init) continue;
      if (d.init.type !== "ArrowFunctionExpression" && d.init.type !== "FunctionExpression")
        continue;
      const kind = helperKind(chunk.code.slice(start(d.init), end(d.init)));
      if (kind) helpers.set(d.id.name, kind);
    }
  }
  const fixed = units.map(() => -1);
  let next = 0;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i] as Unit;
    const call = wrapperCall(unit.node);
    if (call && helpers.get(call.helper) === "cjs") {
      // A wrapper that only re-exports another (a package's `index.js`) joins that module.
      const target = unit.aliasOf ? declaredIn.get(unit.aliasOf.target) : undefined;
      const joined = target === undefined ? -1 : (fixed[target] ?? -1);
      if (joined !== -1) {
        fixed[i] = joined;
        continue;
      }
      boundary.set(next, "real");
      fixed[i] = next++;
      continue;
    }
    // `var ns = {}` then `__export(ns, {…})`.
    const exportCall = units[i + 1]?.node;
    if (
      unit.node.type === "VariableDeclaration" &&
      unit.node.declarations.length === 1 &&
      unit.node.declarations[0]?.init?.type === "ObjectExpression" &&
      exportCall?.type === "ExpressionStatement" &&
      exportCall.expression.type === "CallExpression" &&
      exportCall.expression.callee.type === "Identifier" &&
      helpers.get(exportCall.expression.callee.name) === "export"
    ) {
      let j = i + 1;
      for (; j < units.length; j++) {
        const c = wrapperCall((units[j] as Unit).node);
        if (c && helpers.get(c.helper) === "esm") break;
      }
      if (j < units.length) {
        boundary.set(next, "real");
        for (let k = i; k <= j; k++) fixed[k] = next;
        next++;
        i = j;
      }
    }
  }

  // c. Everything else: clusters of the reference graph, kept contiguous.
  let region: number[] = [];
  const flush = () => {
    if (region.length === 0) return;
    const clusters = ctx.heuristicSplit ? cluster(units, region, ctx.minPartBytes) : [region];
    for (const members of clusters) {
      // Without the heuristic, a region is the code between two real boundaries, kept whole.
      boundary.set(next, ctx.heuristicSplit ? "heuristic" : "real");
      for (const m of members) fixed[m] = next;
      next++;
    }
    region = [];
  };
  for (let i = 0; i < units.length; i++) {
    if (fixed[i] !== -1) {
      flush();
      continue;
    }
    if (isModuleSyntaxOnly(units[i] as Unit)) continue;
    region.push(i);
  }
  flush();
  // Module syntax units (imports, export lists) carry no code; give them any part.
  for (let i = 0; i < units.length; i++) {
    if (fixed[i] === -1) fixed[i] = 0;
    part[i] = fixed[i] as number;
  }
  // Heuristic parts under the size floor join a neighbouring heuristic part, across the real
  // parts the region split stopped at. Vendor code that is dropped does not count.
  for (let changed = true; changed; ) {
    changed = false;
    const firstUnit = new Map<number, number>();
    const bytes = new Map<number, number>();
    for (const [i, unit] of units.entries()) {
      const p = part[i] as number;
      if (!firstUnit.has(p)) firstUnit.set(p, i);
      if (!unit.dropped && !isModuleSyntaxOnly(unit))
        bytes.set(p, (bytes.get(p) ?? 0) + unit.bytes);
    }
    const ordered = [...firstUnit.keys()].filter((p) => (bytes.get(p) ?? 0) > 0);
    for (const [k, p] of ordered.entries()) {
      if (boundary.get(p) !== "heuristic" || (bytes.get(p) ?? 0) >= ctx.minPartBytes) continue;
      const heuristic = (q: number | undefined) =>
        q !== undefined && boundary.get(q) === "heuristic";
      const before = ordered.slice(0, k).reverse().find(heuristic);
      const after = ordered.slice(k + 1).find(heuristic);
      // Merging across other parts must not make the parts import each other in a circle:
      // module-level code reading a binding from a cycle hits it before it is initialized.
      const into = [before, after].find((q) => q !== undefined && !makesCycle(units, part, p, q));
      if (into === undefined) continue;
      for (let i = 0; i < units.length; i++) if (part[i] === p) part[i] = into;
      changed = true;
      break;
    }
  }
  // A region of only one-statement wrappers and no clusters still needs a part 0 to exist.
  if (!boundary.has(0)) boundary.set(0, "heuristic");
  return { part, boundary, source };
}

/** Whether putting parts `a` and `b` together would close an import cycle through other parts. */
function makesCycle(units: Unit[], part: number[], a: number, b: number): boolean {
  const merged = (p: number) => (p === b ? a : p);
  const edges = new Map<number, Set<number>>();
  for (const unit of units) {
    if (unit.dropped) continue;
    const from = merged(part[unit.index] as number);
    for (const at of unit.uses.values()) {
      if (units[at]?.dropped) continue;
      const to = merged(part[at] as number);
      if (to === from) continue;
      const set = edges.get(from) ?? new Set<number>();
      set.add(to);
      edges.set(from, set);
    }
  }
  const seen = new Set<number>();
  const stack = [...(edges.get(a) ?? [])];
  while (stack.length > 0) {
    const p = stack.pop() as number;
    if (p === a) return true;
    if (seen.has(p)) continue;
    seen.add(p);
    stack.push(...(edges.get(p) ?? []));
  }
  return false;
}

function labelFromMap(chunk: ChunkInput, unit: Unit): string | undefined {
  if (chunk.boundaries.length === 0) return undefined;
  // The range holding the statement's first mapped byte.
  for (const span of chunk.boundaries) {
    if (span.end <= unit.start) continue;
    if (span.start >= unit.end) break;
    return span.source;
  }
  return undefined;
}

/**
 * Group a run of statements into module-sized parts: a declaration used by only one other
 * statement goes with it, side-effect statements go with what precedes them, every group spans
 * a contiguous run (scope hoisting keeps each module's statements together), and groups smaller
 * than `minBytes` merge into the neighbour they share the most references with.
 */
function cluster(units: Unit[], region: number[], minBytes: number): number[][] {
  const inRegion = new Set(region);
  const parent = new Map(region.map((i) => [i, i]));
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root) as number;
    parent.set(i, root);
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  const users = new Map<number, Set<number>>();
  for (const i of region) {
    for (const at of (units[i] as Unit).uses.values()) {
      if (!inRegion.has(at)) continue;
      const set = users.get(at) ?? new Set<number>();
      set.add(i);
      users.set(at, set);
    }
  }
  for (const i of region) {
    const unit = units[i] as Unit;
    const set = users.get(i);
    if (unit.declares.length > 0 && unit.exported.length === 0 && set?.size === 1) {
      union(i, [...set][0] as number);
    }
  }
  for (const [k, i] of region.entries()) {
    const unit = units[i] as Unit;
    const previous = region[k - 1];
    if (unit.declares.length === 0 && previous !== undefined) union(i, previous);
  }
  // Contiguous: every group takes the statements between its first and last.
  for (let changed = true; changed; ) {
    changed = false;
    const spans = new Map<number, [number, number]>();
    for (const i of region) {
      const r = find(i);
      const s = spans.get(r);
      spans.set(r, s ? [Math.min(s[0], i), Math.max(s[1], i)] : [i, i]);
    }
    for (const [r, [lo, hi]] of spans) {
      for (const i of region) {
        if (i > lo && i < hi && find(i) !== find(r)) {
          union(i, r);
          changed = true;
        }
      }
    }
  }
  let groups = groupsOf(region, find);
  // Merge groups under the size floor into a neighbour.
  const bytesOf = (g: number[]) => g.reduce((n, i) => n + (units[i] as Unit).bytes, 0);
  const shared = (a: number[], b: number[]) => {
    const setB = new Set(b);
    let n = 0;
    for (const i of a) for (const at of (units[i] as Unit).uses.values()) if (setB.has(at)) n++;
    for (const i of b) for (const at of (units[i] as Unit).uses.values()) if (a.includes(at)) n++;
    return n;
  };
  for (let changed = true; changed && groups.length > 1; ) {
    changed = false;
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g] as number[];
      if (bytesOf(group) >= minBytes) continue;
      const before = groups[g - 1];
      const after = groups[g + 1];
      const target =
        before && after
          ? shared(group, after) > shared(group, before)
            ? g + 1
            : g - 1
          : before
            ? g - 1
            : g + 1;
      const merged = [
        ...(groups[Math.min(g, target)] as number[]),
        ...(groups[Math.max(g, target)] as number[]),
      ];
      groups = [
        ...groups.slice(0, Math.min(g, target)),
        merged,
        ...groups.slice(Math.max(g, target) + 1),
      ];
      changed = true;
      break;
    }
  }
  return groups;
}

function groupsOf(region: number[], find: (i: number) => number): number[][] {
  const groups = new Map<number, number[]>();
  for (const i of region) {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  return [...groups.values()].sort((a, b) => (a[0] as number) - (b[0] as number));
}
