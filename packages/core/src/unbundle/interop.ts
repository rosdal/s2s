import path from "node:path";
import type * as t from "@babel/types";
import { applyEdits, end, parseCode, start, type TextEdit } from "./ast.js";

interface Written {
  /** Workspace-relative path. */
  file: string;
  code: string;
}

function exportsOf(code: string): { default: boolean; named: boolean } | undefined {
  let ast: t.File;
  try {
    ast = parseCode(code);
  } catch {
    return undefined;
  }
  let hasDefault = false;
  let named = false;
  for (const node of ast.program.body) {
    if (node.type === "ExportDefaultDeclaration") hasDefault = true;
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) named = true;
      for (const s of node.specifiers) {
        const name = s.exported.type === "Identifier" ? s.exported.name : s.exported.value;
        if (name === "default") hasDefault = true;
        else named = true;
      }
    }
  }
  return { default: hasDefault, named };
}

/**
 * Converting each module to ES syntax on its own can leave the two sides of an import
 * disagreeing: `exports.add = …` becomes `export const add`, while the importer's
 * `var cart = require("./cart.js")` becomes `import cart from`. A default import of a local
 * module that has named exports and no default is its namespace: `import * as cart`.
 * Returns how many imports were changed.
 */
export function fixDefaultImports(modules: Written[]): number {
  const byFile = new Map(modules.map((m) => [m.file.toLowerCase(), m]));
  const shapes = new Map<Written, ReturnType<typeof exportsOf>>();
  const shapeOf = (m: Written) => {
    if (!shapes.has(m)) shapes.set(m, exportsOf(m.code));
    return shapes.get(m);
  };
  let changed = 0;
  for (const m of modules) {
    let ast: t.File;
    try {
      ast = parseCode(m.code);
    } catch {
      continue;
    }
    const edits: TextEdit[] = [];
    for (const node of ast.program.body) {
      if (node.type !== "ImportDeclaration" || !node.source.value.startsWith(".")) continue;
      const def = node.specifiers.find((s) => s.type === "ImportDefaultSpecifier");
      if (!def) continue;
      const target = byFile.get(
        path.posix
          .normalize(path.posix.join(path.posix.dirname(m.file), node.source.value))
          .toLowerCase(),
      );
      const shape = target ? shapeOf(target) : undefined;
      if (!shape || shape.default || !shape.named) continue;
      const source = JSON.stringify(node.source.value);
      const rest = node.specifiers.filter((s) => s !== def && s.type === "ImportSpecifier");
      const restText = rest.map((s) => m.code.slice(start(s), end(s))).join(", ");
      const text = `import * as ${def.local.name} from ${source};${rest.length > 0 ? `\nimport { ${restText} } from ${source};` : ""}`;
      edits.push({ start: start(node), end: end(node), text });
      changed++;
    }
    if (edits.length > 0) m.code = applyEdits(m.code, edits);
  }
  return changed;
}
