import path from "node:path";
import { type ParserPlugin, parse } from "@babel/parser";
import type * as t from "@babel/types";

const posix = path.posix;

/**
 * Files the build needs that no source map can hold. A barrel that only re-exports
 * (`scene/index.ts`) compiles to no code, so no map lists it; a stylesheet whose CSS was
 * extracted into a sheet is missing too, while the code that imports it is not.
 */
export interface SynthesizedFile {
  /** Project-relative path, forward slashes (`project/src/...`). */
  path: string;
  content: string;
  kind: "barrel" | "style-stub";
  /** Files whose imports needed it. */
  importers: string[];
  /** Names a barrel was asked for that no file in its folder exports. */
  missing?: string[];
}

const CODE = /\.(?:[mc]?[jt]sx?)$/i;
const STYLE = /\.(?:css|s[ac]ss|less|styl)$/i;
const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".json",
  ".vue",
  ".svelte",
];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"];

interface Need {
  /** Imported names, with whether every use was type-only. */
  names: Map<string, boolean>;
  star: boolean;
  importers: Set<string>;
}

interface ExportInfo {
  file: string;
  type: boolean;
}

function parseModule(text: string, file: string): t.File | undefined {
  const plugins: ParserPlugin[] = /\.[mc]?tsx?$/i.test(file)
    ? ["typescript", ...(/x$/i.test(file) ? (["jsx"] as const) : [])]
    : ["jsx"];
  try {
    return parse(text, {
      sourceType: "module",
      errorRecovery: true,
      allowImportExportEverywhere: true,
      plugins,
    }) as unknown as t.File;
  } catch {
    return undefined;
  }
}

/** The module's top-level exports: name to whether it is a type. */
function exportsOf(ast: t.File): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const add = (name: string, type: boolean) => {
    // A value wins over a type of the same name (`const X` and `type X`).
    if (out.get(name) === false) return;
    out.set(name, type);
  };
  for (const node of ast.program.body) {
    if (node.type === "ExportDefaultDeclaration") add("default", false);
    if (node.type !== "ExportNamedDeclaration") continue;
    const typeOnly = node.exportKind === "type";
    const decl = node.declaration;
    if (decl) {
      switch (decl.type) {
        case "VariableDeclaration":
          for (const d of decl.declarations)
            for (const name of bindingNames(d.id)) add(name, false);
          break;
        case "FunctionDeclaration":
        case "ClassDeclaration":
        case "TSEnumDeclaration":
          if (decl.id) add(decl.id.name, false);
          break;
        case "TSTypeAliasDeclaration":
        case "TSInterfaceDeclaration":
          add(decl.id.name, true);
          break;
        case "TSModuleDeclaration":
          if (decl.id.type === "Identifier") add(decl.id.name, decl.declare === true);
          break;
        default:
          break;
      }
    }
    for (const spec of node.specifiers) {
      const exported = spec.exported;
      const name = exported.type === "Identifier" ? exported.name : exported.value;
      const specType = spec.type === "ExportSpecifier" && spec.exportKind === "type";
      add(name, typeOnly || specType);
    }
  }
  return out;
}

function bindingNames(node: t.LVal | t.Node): string[] {
  switch (node.type) {
    case "Identifier":
      return [node.name];
    case "ObjectPattern":
      return node.properties.flatMap((p) =>
        p.type === "RestElement" ? bindingNames(p.argument) : bindingNames(p.value as t.LVal),
      );
    case "ArrayPattern":
      return node.elements.flatMap((e) => (e ? bindingNames(e) : []));
    case "AssignmentPattern":
      return bindingNames(node.left);
    case "RestElement":
      return bindingNames(node.argument);
    default:
      return [];
  }
}

/** Relative specifiers a module imports or re-exports, with the names it takes from each. */
function importsOf(ast: t.File): { spec: string; names: Map<string, boolean>; star: boolean }[] {
  const out: { spec: string; names: Map<string, boolean>; star: boolean }[] = [];
  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration") {
      const names = new Map<string, boolean>();
      let star = false;
      const typeOnly = node.importKind === "type";
      for (const s of node.specifiers) {
        if (s.type === "ImportNamespaceSpecifier") star = true;
        else if (s.type === "ImportDefaultSpecifier") names.set("default", typeOnly);
        else {
          const name = s.imported.type === "Identifier" ? s.imported.name : s.imported.value;
          names.set(name, typeOnly || s.importKind === "type");
        }
      }
      out.push({ spec: node.source.value, names, star });
    } else if (node.type === "ExportNamedDeclaration" && node.source) {
      const names = new Map<string, boolean>();
      let star = false;
      for (const s of node.specifiers) {
        if (s.type === "ExportNamespaceSpecifier") star = true;
        else if (s.type === "ExportSpecifier")
          names.set(
            s.local.type === "Identifier" ? s.local.name : String(s.local),
            node.exportKind === "type" || s.exportKind === "type",
          );
      }
      out.push({ spec: node.source.value, names, star });
    } else if (node.type === "ExportAllDeclaration") {
      out.push({ spec: node.source.value, names: new Map(), star: true });
    }
  }
  return out.filter((i) => i.spec.startsWith("./") || i.spec.startsWith("../"));
}

/**
 * Write what the recovered code imports but the project lacks: an `index.ts` for a folder
 * imported as a module, re-exporting each requested name from the file in that folder that
 * defines it, and an empty stylesheet for a missing one. `files` maps every project file (lower
 * case not required) to its text, or `undefined` for binary files.
 */
export function synthesizeMissing(files: Map<string, string | undefined>): SynthesizedFile[] {
  const known = new Set([...files.keys()].map((f) => f.toLowerCase()));
  const folders = new Set<string>();
  for (const f of known) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const resolvesToFile = (target: string) => {
    const key = target.toLowerCase();
    if (RESOLVE_EXTENSIONS.some((ext) => known.has(key + ext))) return true;
    return INDEX_FILES.some((index) => known.has(`${key}/${index}`));
  };

  const asts = new Map<string, t.File>();
  const astOf = (file: string) => {
    if (asts.has(file)) return asts.get(file);
    const text = files.get(file);
    const ast = text === undefined ? undefined : parseModule(text, file);
    if (ast) asts.set(file, ast);
    return ast;
  };

  const barrels = new Map<string, Need>();
  const styles = new Map<string, Set<string>>();
  for (const file of [...files.keys()].sort()) {
    if (!CODE.test(file) || /\.d\.[mc]?ts$/i.test(file)) continue;
    const ast = astOf(file);
    if (!ast) continue;
    for (const imp of importsOf(ast)) {
      const bare = imp.spec.split(/[?#]/, 1)[0] as string;
      const target = posix.normalize(posix.join(posix.dirname(file), bare));
      if (target.startsWith("..") || !target.startsWith("project/src/")) continue;
      if (STYLE.test(target)) {
        if (known.has(target.toLowerCase())) continue;
        const importers = styles.get(target) ?? new Set<string>();
        importers.add(file);
        styles.set(target, importers);
        continue;
      }
      if (resolvesToFile(target) || !folders.has(target.toLowerCase())) continue;
      const need = barrels.get(target) ?? { names: new Map(), star: false, importers: new Set() };
      for (const [name, type] of imp.names)
        need.names.set(name, (need.names.get(name) ?? true) && type);
      need.star ||= imp.star;
      need.importers.add(file);
      barrels.set(target, need);
    }
  }

  const out: SynthesizedFile[] = [];
  for (const [folder, need] of [...barrels.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const prefix = `${folder.toLowerCase()}/`;
    // Shallow files first, so `scene/selection.ts` beats `scene/deep/selection.ts`.
    const members = [...files.keys()]
      .filter(
        (f) => f.toLowerCase().startsWith(prefix) && CODE.test(f) && !/\.d\.[mc]?ts$/i.test(f),
      )
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    const table = new Map<string, ExportInfo>();
    for (const member of members) {
      const ast = astOf(member);
      if (!ast) continue;
      for (const [name, type] of exportsOf(ast)) {
        if (name === "default" || table.has(name)) continue;
        table.set(name, { file: member, type });
      }
    }
    const values = new Map<string, string[]>();
    const types = new Map<string, string[]>();
    const missing: string[] = [];
    for (const [name, typeUse] of [...need.names.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const found = table.get(name);
      if (!found) {
        missing.push(name);
        continue;
      }
      const group = found.type || typeUse ? types : values;
      const list = group.get(found.file) ?? [];
      list.push(name);
      group.set(found.file, list);
    }
    const specOf = (member: string) => {
      const rel = posix.relative(folder, member).replace(/\.[mc]?[jt]sx?$/i, "");
      return rel.startsWith(".") ? rel : `./${rel}`;
    };
    const lines = [
      "// s2s: this barrel compiled to no code, so no source map held it. It is rebuilt from what",
      "// the recovered code imports from this folder; check it against the original if you can.",
    ];
    if (need.star) {
      const direct = members.filter((m) => posix.dirname(m).toLowerCase() === folder.toLowerCase());
      for (const member of direct) lines.push(`export * from "${specOf(member)}";`);
    }
    for (const member of members) {
      const v = values.get(member);
      if (v) lines.push(`export { ${v.join(", ")} } from "${specOf(member)}";`);
      const ty = types.get(member);
      if (ty) lines.push(`export type { ${ty.join(", ")} } from "${specOf(member)}";`);
    }
    if (missing.length > 0)
      lines.push(`// s2s: no file in this folder exports ${missing.join(", ")}.`);
    const ts = members.some((m) => /\.[mc]?tsx?$/i.test(m));
    out.push({
      path: `${folder}/index.${ts ? "ts" : "js"}`,
      content: `${lines.join("\n")}\n`,
      kind: "barrel",
      importers: [...need.importers].sort(),
      ...(missing.length > 0 ? { missing } : {}),
    });
  }
  for (const [file, importers] of [...styles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({
      path: file,
      content:
        "/* s2s: no source map held this stylesheet. Its compiled rules are in the captured CSS the\n   entry imports; recover the original here if you need it. */\n",
      kind: "style-stub",
      importers: [...importers].sort(),
    });
  }
  return out;
}
