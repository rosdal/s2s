import { posix } from "node:path";

/**
 * Relative map sources say where a file sat relative to the map: `../../index.tsx` and
 * `../../../packages/ui/x.ts` from `/assets/` put `index.tsx` one folder below the folder that
 * holds `packages/`. Dropping every leading `..` flattens that, and an import such as
 * `../app/sentry` from `index.tsx` then points nowhere. These helpers keep the depth.
 */

/** Name for the `level`th unnamed folder above a map's served root (1 is the outermost). */
export const placeholderFolder = (level: number) => `_dir${level}`;
const PLACEHOLDER = /^_dir(\d+)$/;

/** Folder segments of a map URL's directory: `https://x.com/a/b/c.js.map` gives `["a", "b"]`. */
export function urlDirectory(url: string | null | undefined): string[] {
  if (!url) return [];
  try {
    return new URL(url).pathname.split("/").filter(Boolean).slice(0, -1);
  } catch {
    return [];
  }
}

/**
 * How many folders above the served root (the URL's `/`) a source climbed: `../../../x` from
 * `/assets/` climbs 3 and the folder holds 1, so it lands 2 above. Never negative.
 */
export function escapeOf(climb: number, mapDirectory: string[]): number {
  return Math.max(0, climb - mapDirectory.length);
}

/**
 * Place a source that escaped `escaped` folders when the deepest one escaped `deepest`. The build's
 * root sits `deepest` folders above the served root, so this source sits `deepest - escape`
 * folders below that, in folders whose names the map does not record.
 */
export function placeSource(path: string, escaped: number, deepest: number): string {
  const depth = deepest - escaped;
  if (depth <= 0) return path;
  const prefix = Array.from({ length: depth }, (_, i) => placeholderFolder(i + 1));
  return [...prefix, path].join("/");
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|@import\s+(?:url\(\s*)?)["'](\.{1,2}\/[^"'\n]*)["']/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss"];
const INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/** Relative import specifiers in a JS, TS or CSS source. */
export function relativeImports(content: string): string[] {
  return [...content.matchAll(IMPORT_SPECIFIER)].map((m) => m[1] as string);
}

/** True when `target` (no extension) names a file or a folder with files in `known`. */
export function resolvesIn(target: string, known: Set<string>, folders: Set<string>): boolean {
  const key = target.toLowerCase();
  if (EXTENSIONS.some((ext) => known.has(key + ext))) return true;
  if (INDEX.some((ext) => known.has(key + ext))) return true;
  return folders.has(key);
}

/**
 * Real names for placeholder folders, read from imports that only resolve if the folder had that
 * name. A file inside `_dir1/` importing `../excalidraw-app/sentry` when `_dir1/sentry.ts` exists
 * says `_dir1` is `excalidraw-app`. Placeholders nothing names keep their placeholder name.
 */
export function inferFolderNames(
  files: { path: string; content: string | null }[],
): Map<string, string> {
  const known = new Set(files.map((f) => f.path.toLowerCase()));
  const folders = new Set<string>();
  for (const f of files) {
    const parts = f.path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  // Placeholder folder path (`_dir1`, `_dir1/_dir2`) to name votes.
  const votes = new Map<string, Map<string, number>>();
  for (const file of files) {
    if (!file.content || !PLACEHOLDER.test(file.path.split("/")[0] ?? "")) continue;
    const dir = posix.dirname(file.path);
    for (const spec of relativeImports(file.content)) {
      const target = posix.normalize(posix.join(dir, spec));
      if (resolvesIn(target, known, folders)) continue;
      const parts = target.split("/");
      const fileParts = file.path.split("/");
      // The import climbed to the placeholder's parent and named a sibling: `<parent>/<name>/rest`.
      for (let level = 0; level < fileParts.length - 1; level++) {
        const placeholder = fileParts[level] as string;
        if (!PLACEHOLDER.test(placeholder)) break;
        const parent = fileParts.slice(0, level);
        if (parts.length <= level + 1 || parts.slice(0, level).join("/") !== parent.join("/"))
          continue;
        const name = parts[level] as string;
        if (name === placeholder || name === "..") continue;
        const inside = [...parent, placeholder, ...parts.slice(level + 1)].join("/");
        if (!resolvesIn(inside, known, folders)) continue;
        const key = fileParts.slice(0, level + 1).join("/");
        const tally = votes.get(key) ?? new Map<string, number>();
        tally.set(name, (tally.get(name) ?? 0) + 1);
        votes.set(key, tally);
      }
    }
  }
  const names = new Map<string, string>();
  for (const [key, tally] of votes) {
    const [name] =
      [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
    if (!name) continue;
    const parent = posix.dirname(key);
    const sibling = (parent === "." ? name : `${parent}/${name}`).toLowerCase();
    // A real folder already has that name: renaming would merge two trees.
    if (folders.has(sibling) || /[\\/:*?"<>|]/.test(name)) continue;
    names.set(key, name);
  }
  return names;
}

/**
 * Apply `inferFolderNames` results to a path: `_dir1/x.ts` becomes `excalidraw-app/x.ts`. A
 * placeholder no import named is dropped, which is the flat layout a map without that evidence
 * always got.
 */
export function renameFolders(path: string, names: Map<string, string>): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (!PLACEHOLDER.test(part)) {
      out.push(part);
      continue;
    }
    const name = names.get(parts.slice(0, i + 1).join("/"));
    if (name) out.push(name);
  }
  return out.join("/");
}
