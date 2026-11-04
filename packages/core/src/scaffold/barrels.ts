import path from "node:path";
import { type ParserPlugin, parse } from "@babel/parser";
import type * as t from "@babel/types";
import { resolveWorkspaceSpecifier, type WorkspacePackage } from "./workspaces.js";

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
  kind: "barrel" | "style-stub" | "chunk-stand-in";
  /** Files whose imports needed it. */
  importers: string[];
  /** Value names a barrel was asked for that no recovered file exports. */
  missing?: string[];
  /** Type names no recovered file defines, exported as `any`. */
  placeholderTypes?: string[];
}

/**
 * A chunk the unbundler split without a map. Vite names a lazy chunk after its entry module
 * (`firebaseSDK-BRg0yXND.js` for `./firebaseSDK`), so an import of that module that nothing
 * recovered answers can load the split parts instead.
 */
export interface SplitChunk {
  /** The chunk's file name without its content hash (`firebaseSDK`, `subset-shared.chunk`). */
  stem: string;
  /** The chunk's own `export { local as exported }` list. */
  exports: { local: string; exported: string }[];
  /** Project paths of the parts the unbundler split it into. */
  parts: string[];
}

/** `firebaseSDK-BRg0yXND.js` gives `firebaseSDK`; a name without a hash gives undefined. */
export function chunkStem(url: string): string | undefined {
  const base =
    url
      .replace(/[?#].*$/, "")
      .split("/")
      .pop() ?? "";
  // Greedy: `subset-shared.chunk-D3ioWSie.js` keeps `.chunk` in the name.
  return /^(.+)[-.][A-Za-z0-9_-]{8,}\.m?js$/.exec(base)?.[1];
}

/** The `export { a as b }` list that ends a chunk, or an empty list. */
export function chunkExports(code: string): { local: string; exported: string }[] {
  const tail = code.replace(/\s*(?:\/\/[#@] sourceMappingURL=[^\n]*\s*)?$/, "");
  const m = /export\s*\{([^}]*)\}\s*;?$/.exec(tail);
  if (!m) return [];
  return (m[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [local = s, exported = local] = s.split(/\s+as\s+/);
      return { local: local.trim(), exported: exported.trim() };
    });
}

/** Length of the common folder prefix of two paths, in segments. */
function sharedPrefix(a: string, b: string): number {
  const x = a.toLowerCase().split("/");
  const y = b.toLowerCase().split("/");
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
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

/** Specifiers a module imports or re-exports, with the names it takes from each. */
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
  return out;
}

/**
 * Write what the recovered code imports but the project lacks: an `index.ts` for a folder
 * imported as a module, re-exporting each requested name from the file in that folder that
 * defines it, and an empty stylesheet for a missing one. `files` maps every project file to its
 * text, or `undefined` for binary files. Bare imports of `workspace` packages resolve in their
 * folders like relative ones.
 */
export function synthesizeMissing(
  files: Map<string, string | undefined>,
  workspace: WorkspacePackage[] = [],
  chunks: SplitChunk[] = [],
): SynthesizedFile[] {
  const chunkByStem = new Map<string, SplitChunk | null>();
  for (const c of chunks)
    chunkByStem.set(c.stem.toLowerCase(), chunkByStem.has(c.stem.toLowerCase()) ? null : c);
  const standIns = new Map<string, { chunk: SplitChunk; importers: Set<string> }>();
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
    // `import("./x")` and `typeof import("./x")` take the whole module.
    const dynamic = [
      ...(files.get(file) ?? "").matchAll(/\bimport\s*\(\s*["'](\.{1,2}\/[^"'\n]+)["']\s*\)/g),
    ].map((m) => ({ spec: m[1] as string, names: new Map<string, boolean>(), star: true }));
    for (const imp of [...importsOf(ast), ...dynamic]) {
      const bare = imp.spec.split(/[?#]/, 1)[0] as string;
      const relative = bare.startsWith("./") || bare.startsWith("../");
      const aliased = relative ? undefined : resolveWorkspaceSpecifier(bare, workspace);
      if (!relative && aliased === undefined) continue;
      const target = aliased ?? posix.normalize(posix.join(posix.dirname(file), bare));
      if (target.startsWith("..") || !target.startsWith("project/src/")) continue;
      if (STYLE.test(target)) {
        if (known.has(target.toLowerCase())) continue;
        const importers = styles.get(target) ?? new Set<string>();
        importers.add(file);
        styles.set(target, importers);
        continue;
      }
      if (resolvesToFile(target)) continue;
      if (!folders.has(target.toLowerCase())) {
        const chunk = chunkByStem.get(posix.basename(target).toLowerCase());
        if (!chunk || !relative) continue;
        const standIn = standIns.get(target) ?? { chunk, importers: new Set<string>() };
        standIn.importers.add(file);
        standIns.set(target, standIn);
        continue;
      }
      const need = barrels.get(target) ?? { names: new Map(), star: false, importers: new Set() };
      for (const [name, type] of imp.names)
        need.names.set(name, (need.names.get(name) ?? true) && type);
      need.star ||= imp.star;
      need.importers.add(file);
      barrels.set(target, need);
    }
  }

  let allExports: Map<string, Map<string, boolean>> | undefined;
  const projectExports = () => {
    if (allExports) return allExports;
    allExports = new Map();
    for (const file of [...files.keys()].sort()) {
      if (!CODE.test(file) || /\.d\.[mc]?ts$/i.test(file)) continue;
      const ast = astOf(file);
      if (ast) allExports.set(file, exportsOf(ast));
    }
    return allExports;
  };

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
    // `Component.tsx` with a default export answers `import { Component } from "./folder"`.
    const defaults = new Map<string, string>();
    for (const member of members) {
      const ast = astOf(member);
      if (!ast) continue;
      for (const [name, type] of exportsOf(ast)) {
        if (name === "default") {
          const base = posix.basename(member).replace(/\.[^.]+$/, "");
          if (!defaults.has(base)) defaults.set(base, member);
          continue;
        }
        if (table.has(name)) continue;
        table.set(name, { file: member, type });
      }
    }
    // A barrel may re-export from another package (`scene/index.ts` from `@excalidraw/element`):
    // a name the folder lacks comes from the closest file elsewhere that exports it.
    const elsewhere = (name: string): ExportInfo | undefined => {
      let best: { info: ExportInfo; shared: number } | undefined;
      for (const [file, names] of projectExports()) {
        const type = names.get(name);
        if (type === undefined) continue;
        const shared = sharedPrefix(file, folder);
        if (!best || shared > best.shared) best = { info: { file, type }, shared };
      }
      return best?.info;
    };
    // file -> entries `name` or `default as name`, split by value and type.
    const values = new Map<string, string[]>();
    const types = new Map<string, string[]>();
    const placeholders: string[] = [];
    const missing: string[] = [];
    const push = (group: Map<string, string[]>, file: string, entry: string) => {
      const list = group.get(file) ?? [];
      list.push(entry);
      group.set(file, list);
    };
    for (const [name, typeUse] of [...need.names.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const found = table.get(name) ?? (defaults.has(name) ? undefined : elsewhere(name));
      const defaultFile = defaults.get(name);
      if (found) push(found.type || typeUse ? types : values, found.file, name);
      else if (defaultFile) push(typeUse ? types : values, defaultFile, `default as ${name}`);
      // Type-only files compile to nothing, so no map holds them; `any` keeps the type usable.
      else if (typeUse) placeholders.push(name);
      else missing.push(name);
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
    const sources = [...new Set([...values.keys(), ...types.keys()])].sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    );
    for (const source of sources) {
      const v = values.get(source);
      if (v) lines.push(`export { ${v.join(", ")} } from "${specOf(source)}";`);
      const ty = types.get(source);
      if (ty) lines.push(`export type { ${ty.join(", ")} } from "${specOf(source)}";`);
    }
    if (placeholders.length > 0) {
      lines.push("// s2s: no recovered file defines these types (type-only files leave no code).");
      for (const name of placeholders) lines.push(`export type ${name} = any;`);
    }
    if (missing.length > 0) lines.push(`// s2s: no recovered file exports ${missing.join(", ")}.`);
    const ts = members.some((m) => /\.[mc]?tsx?$/i.test(m));
    out.push({
      path: `${folder}/index.${ts ? "ts" : "js"}`,
      content: `${lines.join("\n")}\n`,
      kind: "barrel",
      importers: [...need.importers].sort(),
      ...(missing.length > 0 ? { missing } : {}),
      ...(placeholders.length > 0 ? { placeholderTypes: placeholders } : {}),
    });
  }
  for (const [target, { chunk, importers }] of [...standIns.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const owner = new Map<string, string>();
    for (const part of chunk.parts) {
      const ast = astOf(part);
      if (!ast) continue;
      for (const name of exportsOf(ast).keys()) if (!owner.has(name)) owner.set(name, part);
    }
    const byPart = new Map<string, string[]>();
    const missing: string[] = [];
    for (const { local, exported } of chunk.exports) {
      const part = owner.get(local);
      if (!part) {
        missing.push(exported);
        continue;
      }
      const list = byPart.get(part) ?? [];
      list.push(local === exported ? local : `${local} as ${exported}`);
      byPart.set(part, list);
    }
    if (byPart.size === 0) continue;
    const dir = posix.dirname(target);
    const lines = [
      "// s2s: no source map held this module. Its chunk was split without one; this file",
      "// re-exports the chunk's exports from the split parts under their public names.",
      ...[...byPart.entries()].map(([part, names]) => {
        const rel = posix.relative(dir, part);
        return `export { ${names.join(", ")} } from "${rel.startsWith(".") ? rel : `./${rel}`}";`;
      }),
    ];
    if (missing.length > 0) lines.push(`// s2s: no split part defines ${missing.join(", ")}.`);
    out.push({
      path: `${target}.js`,
      content: `${lines.join("\n")}\n`,
      kind: "chunk-stand-in",
      importers: [...importers].sort(),
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
