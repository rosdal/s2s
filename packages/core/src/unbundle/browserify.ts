import type * as t from "@babel/types";
import {
  applyEdits,
  end,
  literalValue,
  moduleSpecifier,
  type NodePath,
  parseCode,
  quote,
  renameBinding,
  start,
  type TextEdit,
  traverse,
} from "./ast.js";
import type { ChunkTable } from "./split.js";
import type { ChunkInput, Draft, UnpackContext } from "./types.js";
import { coveringPackage } from "./vendor.js";

/**
 * Split a Browserify bundle: `prelude({1: [function (require, module, exports) {…}, {"./x": 2}]},
 * {}, [entry])`. Each module's dependency table turns `require("./x")` into the module it names.
 */
export function unpackBrowserify(
  chunk: ChunkInput,
  ctx: UnpackContext,
): { drafts: Draft[]; table: ChunkTable } {
  const ast = parseCode(chunk.code);
  let call: NodePath<t.CallExpression> | undefined;
  const fns = new Map<t.Node, NodePath<t.Function>>();
  traverse(ast, {
    Function(path) {
      fns.set(path.node, path);
    },
    CallExpression(path) {
      if (call) return;
      const [map, cache, entries] = path.node.arguments;
      if (
        map?.type !== "ObjectExpression" ||
        cache?.type !== "ObjectExpression" ||
        entries?.type !== "ArrayExpression"
      )
        return;
      const isModule = (p: t.Node) =>
        p.type === "ObjectProperty" &&
        p.value.type === "ArrayExpression" &&
        p.value.elements[0]?.type === "FunctionExpression";
      if (map.properties.length > 0 && map.properties.every(isModule)) call = path;
    },
  });
  const key = (id: string) => `browserify:${chunk.name}:${id}`;
  if (!call) return { drafts: [], table: { entry: null, exports: new Map() } };
  const [map, , entries] = call.node.arguments as [
    t.ObjectExpression,
    t.ObjectExpression,
    t.ArrayExpression,
  ];
  const entryIds = new Set(
    entries.elements.map((e) => literalValue(e)).filter((v) => v !== undefined),
  );
  const drafts: Draft[] = [];
  for (const property of map.properties as t.ObjectProperty[]) {
    const id = literalValue(property.key) ?? (property.key as t.Identifier).name;
    const [fnNode, depsNode] = (property.value as t.ArrayExpression).elements;
    const fn = fnNode ? fns.get(fnNode) : undefined;
    if (fn?.node.body.type !== "BlockStatement") continue;
    const deps = new Map<string, string>();
    if (depsNode?.type === "ObjectExpression") {
      for (const d of depsNode.properties) {
        if (d.type !== "ObjectProperty") continue;
        const name = literalValue(d.key) ?? (d.key.type === "Identifier" ? d.key.name : undefined);
        const target = literalValue(d.value);
        if (name !== undefined && target !== undefined) deps.set(name, target);
      }
    }
    const edits: TextEdit[] = [];
    const roles = ["require", "module", "exports"];
    for (const [i, param] of fn.node.params.entries()) {
      if (param.type !== "Identifier") continue;
      const binding = fn.scope.getBinding(param.name);
      const wanted = roles[i];
      if (!binding || !wanted) continue;
      if (wanted === "require") {
        for (const ref of binding.referencePaths) {
          const parent = ref.parentPath;
          if (parent?.isCallExpression() && parent.node.callee === ref.node) {
            const arg = parent.node.arguments[0];
            const spec = literalValue(arg);
            const target = spec === undefined ? undefined : deps.get(spec);
            if (arg && target !== undefined)
              edits.push({
                start: start(arg),
                end: end(arg),
                text: quote(moduleSpecifier(key(target))),
              });
          }
        }
      }
      if (param.name !== wanted) edits.push(...renameBinding(binding, wanted));
    }
    const from = start(fn.node.body) + 1;
    const to = end(fn.node.body) - 1;
    const draft: Draft = {
      key: key(id),
      id,
      chunk,
      start: start(fn.node),
      end: end(fn.node),
      boundary: "real",
      code: `${applyEdits(chunk.code, edits, from, to).replace(/^\n+/, "")}\n`,
      head: [],
      entry: entryIds.has(id),
      source: null,
      notes: [],
      vendor: null,
      vendorBytesRemoved: 0,
    };
    if (!ctx.keepVendor) {
      const span = coveringPackage(chunk.vendor, draft.start, draft.end);
      if (span) draft.vendor = { package: span.package, version: span.version };
    }
    drafts.push(draft);
  }
  const entry = drafts.find((d) => d.entry && !d.vendor) ?? drafts.find((d) => !d.vendor);
  return { drafts, table: { entry: entry?.key ?? null, exports: new Map() } };
}
