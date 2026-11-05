import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type * as t from "@babel/types";
import type { WorkspacePaths } from "../capture/workspace.js";
import { writeFileAtomic, writeJsonAtomic } from "../fs-util.js";
import { applyEdits, parseCode, type TextEdit, traverse } from "../unbundle/ast.js";
import { webglDir } from "./capture-pass.js";

export interface LiteralString {
  value: string;
  /** String offsets of the whole literal, quotes included. */
  start: number;
  end: number;
}

/** Every string and expression-free template literal in `code`. */
export function literalStrings(code: string, filter?: (value: string) => boolean): LiteralString[] {
  let ast: t.File;
  try {
    ast = parseCode(code);
  } catch {
    return [];
  }
  const out: LiteralString[] = [];
  const keep = (value: string, node: t.Node) => {
    if (node.start == null || node.end == null) return;
    if (filter && !filter(value)) return;
    out.push({ value, start: node.start, end: node.end });
  };
  traverse(ast, {
    StringLiteral(p) {
      keep(p.node.value, p.node);
    },
    TemplateLiteral(p) {
      if (p.node.expressions.length > 0) return;
      const cooked = p.node.quasis[0]?.value.cooked;
      if (typeof cooked === "string") keep(cooked, p.node);
    },
  });
  return out;
}

export const looksLikeShader = (text: string) =>
  text.length >= 20 &&
  /\bvoid\s+main\s*\(/.test(text) &&
  /gl_Position|gl_FragColor|gl_FragData|pc_fragColor|#include\s*</.test(text);

const CHUNK_KEYS = ["common", "begin_vertex", "project_vertex"];

/**
 * three's `ShaderChunk`, read from the bundle that ships it: the object literal whose keys include
 * `common`, `begin_vertex` and `project_vertex`. The text is exactly the detected revision's.
 */
export function findShaderChunks(code: string): Record<string, string> | null {
  if (!code.includes("begin_vertex") || !code.includes("project_vertex")) return null;
  let ast: t.File;
  try {
    ast = parseCode(code);
  } catch {
    return null;
  }
  let found: Record<string, string> | null = null;
  traverse(ast, {
    ObjectExpression(p) {
      if (found || p.node.properties.length < 40) return;
      const chunks: Record<string, string> = {};
      for (const prop of p.node.properties) {
        if (prop.type !== "ObjectProperty") continue;
        const key =
          prop.key.type === "Identifier"
            ? prop.key.name
            : prop.key.type === "StringLiteral"
              ? prop.key.value
              : null;
        if (!key) continue;
        const v = prop.value;
        if (v.type === "StringLiteral") chunks[key] = v.value;
        else if (v.type === "TemplateLiteral" && v.expressions.length === 0)
          chunks[key] = v.quasis[0]?.value.cooked ?? "";
      }
      if (CHUNK_KEYS.every((k) => k in chunks)) {
        found = chunks;
        p.stop();
      }
    },
  });
  return found;
}

const INCLUDE = /^[ \t]*#include +<([\w\d./]+)>/gm;

/** three's own include resolution: `#include <name>` replaced by the chunk, recursively. */
export function resolveIncludes(source: string, chunks: Record<string, string>, depth = 0): string {
  if (depth > 16) return source;
  return source.replace(INCLUDE, (whole, name: string) => {
    const chunk = chunks[name];
    return chunk === undefined ? whole : resolveIncludes(chunk, chunks, depth + 1);
  });
}

/**
 * Fold three's built-in chunks in a final GLSL source back to `#include <name>` lines: each
 * chunk's expanded text, longest first, where it starts and ends on a line boundary.
 */
export function foldChunks(
  source: string,
  chunks: Record<string, string>,
): { text: string; folded: string[] } {
  const expanded = Object.entries(chunks)
    .map(([name, text]) => ({ name, text: resolveIncludes(text, chunks) }))
    .filter((c) => c.text.trim().length >= 40)
    .sort((a, b) => b.text.length - a.text.length || a.name.localeCompare(b.name));
  let text = source;
  const folded: string[] = [];
  for (const chunk of expanded) {
    let from = 0;
    let out = "";
    let hit = false;
    for (let i = text.indexOf(chunk.text); i >= 0; i = text.indexOf(chunk.text, from)) {
      const end = i + chunk.text.length;
      const lineStart = i === 0 || text[i - 1] === "\n";
      const lineEnd = end === text.length || text[end] === "\n" || chunk.text.endsWith("\n");
      if (!lineStart || !lineEnd) {
        out += text.slice(from, i + 1);
        from = i + 1;
        continue;
      }
      out += `${text.slice(from, i)}#include <${chunk.name}>${chunk.text.endsWith("\n") ? "\n" : ""}`;
      from = end;
      hit = true;
    }
    if (hit) {
      text = out + text.slice(from);
      folded.push(chunk.name);
    }
  }
  return { text, folded: folded.sort() };
}

export interface CapturedProgram {
  id: string;
  name: string | null;
  vertex: string;
  fragment: string;
  pages: string[];
}

export interface ProgramMatch {
  program: CapturedProgram;
  /** A built-in three material: nothing of the site's own. */
  builtin: boolean;
  vertex: { literal: LiteralString & { file: string }; source: string } | null;
  fragment: { literal: LiteralString & { file: string }; source: string } | null;
}

const BUILTIN_SHADERS =
  /^(?:mesh\w+|points|linedashed|shadow|sprite|background\w*|cube|equirect|distance\w*|depth|normal)_(?:vert|frag)$/;

/** Whether a program is one of three's own materials (its whole body is a ShaderLib entry). */
export function isBuiltinProgram(
  program: CapturedProgram,
  chunks: Record<string, string>,
): boolean {
  // Since r150 three writes the material type into every program it builds.
  const type = /#define SHADER_TYPE (\w+)/.exec(program.vertex)?.[1];
  if (type) return type !== "ShaderMaterial" && type !== "RawShaderMaterial";
  for (const [name, text] of Object.entries(chunks)) {
    if (!BUILTIN_SHADERS.test(name) || !name.endsWith("_vert")) continue;
    const frag = chunks[name.replace(/_vert$/, "_frag")];
    if (!frag) continue;
    if (
      program.vertex.includes(resolveIncludes(text, chunks).trim()) &&
      program.fragment.includes(resolveIncludes(frag, chunks).trim())
    )
      return true;
  }
  return false;
}

/** Pair each program's stages with the bundle literal it was built from. */
export function matchPrograms(
  programs: CapturedProgram[],
  literals: (LiteralString & { file: string })[],
  chunks: Record<string, string> | null,
): ProgramMatch[] {
  const table = chunks ?? {};
  const builtins = new Set(Object.values(table));
  const candidates = literals
    .filter((l) => looksLikeShader(l.value) && !builtins.has(l.value))
    .map((l) => ({ literal: l, expanded: resolveIncludes(l.value, table).trim() }))
    // Longest first, so a literal that contains another wins.
    .sort((a, b) => b.expanded.length - a.expanded.length);
  return programs.map((program) => {
    const find = (stage: string) => {
      const hit = candidates.find((c) => c.expanded.length > 0 && stage.includes(c.expanded));
      return hit ? { literal: hit.literal, source: hit.literal.value } : null;
    };
    const vertex = find(program.vertex);
    const fragment = find(program.fragment);
    return {
      program,
      builtin: !vertex && !fragment && isBuiltinProgram(program, table),
      vertex,
      fragment,
    };
  });
}

/** `GlowMaterial` → `glow`, `Water shader` → `water-shader`. */
export function shaderBaseName(name: string | null, fallback: string): string {
  const base = (name ?? "")
    .replace(/Material$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || fallback;
}

export interface ShaderFileRecord {
  name: string;
  program: string;
  material: string | null;
  stage: "vert" | "frag";
  file: string;
  /** `bundle`: the literal the site shipped; `folded`: the running program with chunks folded. */
  source: "bundle" | "folded";
  module: string | null;
  folded: string[];
}

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

const posix = (p: string) => p.split(path.sep).join("/");

/**
 * The unbundle hook: write every custom program's GLSL to `recovered/unbundled/shaders/` and point
 * the recovered module that held it at the file through a `?raw` import. Returns what it wrote,
 * also recorded in `analysis/shaders.json`.
 */
export async function recoverShaders(
  paths: WorkspacePaths,
  warn: (message: string) => void,
): Promise<ShaderFileRecord[]> {
  const shaderIndex = path.join(webglDir(paths), "shaders", "index.json");
  if (!existsSync(shaderIndex)) return [];
  const list = JSON.parse(await readFile(shaderIndex, "utf8")) as {
    id: string;
    name: string | null;
    vertex: string;
    fragment: string;
    pages: string[];
  }[];
  const programs: CapturedProgram[] = [];
  for (const p of list)
    programs.push({
      id: p.id,
      name: p.name,
      pages: p.pages,
      vertex: await readFile(path.join(webglDir(paths), "shaders", p.vertex), "utf8"),
      fragment: await readFile(path.join(webglDir(paths), "shaders", p.fragment), "utf8"),
    });

  // three's chunks from whichever captured script ships them.
  let chunks: Record<string, string> | null = null;
  const bodies = await listFiles(paths.bodies);
  for (const body of bodies) {
    const text = await readFile(body, "utf8").catch(() => "");
    if (!text.includes("begin_vertex")) continue;
    chunks = findShaderChunks(text);
    if (chunks) break;
  }
  if (!chunks)
    warn("three's ShaderChunk was not found in the capture; shaders are written unfolded.");

  // Shader literals in the recovered modules (the agent's copy) — these get rewritten.
  const moduleFiles = (await listFiles(paths.unbundled)).filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  const literals: (LiteralString & { file: string })[] = [];
  const texts = new Map<string, string>();
  for (const file of moduleFiles) {
    const text = await readFile(file, "utf8");
    if (!/void\s+main/.test(text)) continue;
    texts.set(file, text);
    for (const l of literalStrings(text, looksLikeShader)) literals.push({ ...l, file });
  }
  // And in exact sources from maps, which are read-only but still tell where a shader lives.
  for (const file of (await listFiles(paths.recoveredSourcemap)).filter((f) =>
    /\.[cm]?[jt]sx?$/.test(f),
  )) {
    const text = await readFile(file, "utf8");
    if (!/void\s+main/.test(text)) continue;
    for (const l of literalStrings(text, looksLikeShader)) literals.push({ ...l, file });
  }

  const matches = matchPrograms(programs, literals, chunks);
  const out = path.join(paths.unbundled, "shaders");
  const records: ShaderFileRecord[] = [];
  const edits = new Map<string, { edits: TextEdit[]; imports: string[] }>();
  const taken = new Set<string>();
  let index = 0;
  for (const match of matches) {
    if (match.builtin) continue;
    index++;
    const literalFile = match.vertex?.literal.file ?? match.fragment?.literal.file ?? null;
    const stem = literalFile ? path.basename(literalFile).replace(/\.[^.]+$/, "") : "shader";
    let name = shaderBaseName(match.program.name, `${stem}-${index}`);
    for (let n = 2; taken.has(name); n++) name = `${shaderBaseName(match.program.name, stem)}-${n}`;
    taken.add(name);
    for (const stage of ["vert", "frag"] as const) {
      const hit = stage === "vert" ? match.vertex : match.fragment;
      const finalSource = stage === "vert" ? match.program.vertex : match.program.fragment;
      let text: string;
      let folded: string[] = [];
      if (hit) text = hit.source.replace(/^\n/, "");
      else {
        const result = chunks ? foldChunks(finalSource, chunks) : { text: finalSource, folded: [] };
        folded = result.folded;
        text = `// s2s: the final GLSL of the running program (${match.program.id}), with three's chunks folded back.\n// No literal in the bundle matched it (built with onBeforeCompile or string edits?); trim three's prefix above your code.\n${result.text}`;
      }
      const file = path.join(out, `${name}.${stage}.glsl`);
      await mkdir(out, { recursive: true });
      await writeFileAtomic(file, text);
      const rel = posix(path.relative(paths.root, file));
      records.push({
        name,
        program: match.program.id,
        material: match.program.name,
        stage,
        file: rel,
        source: hit ? "bundle" : "folded",
        module: hit ? posix(path.relative(paths.root, hit.literal.file)) : null,
        folded,
      });
      if (hit && texts.has(hit.literal.file)) {
        const id = `${name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/^(\d)/, "_$1")}${stage === "vert" ? "Vertex" : "Fragment"}Shader`;
        const entry = edits.get(hit.literal.file) ?? { edits: [], imports: [] };
        if (!entry.edits.some((e) => e.start === hit.literal.start)) {
          entry.edits.push({ start: hit.literal.start, end: hit.literal.end, text: id });
          let spec = posix(path.relative(path.dirname(hit.literal.file), file));
          if (!spec.startsWith(".")) spec = `./${spec}`;
          entry.imports.push(`import ${id} from "${spec}?raw";`);
        }
        edits.set(hit.literal.file, entry);
      }
    }
  }
  for (const [file, entry] of edits) {
    const text = texts.get(file) as string;
    const body = applyEdits(text, entry.edits);
    // Imports go after any leading comments and existing imports' first line.
    await writeFileAtomic(file, `${entry.imports.join("\n")}\n${body}`);
  }
  await writeJsonAtomic(path.join(paths.analysis, "shaders.json"), {
    programs: matches.map((m) => ({
      id: m.program.id,
      material: m.program.name,
      builtin: m.builtin,
      pages: m.program.pages,
    })),
    files: records,
  });
  return records;
}
