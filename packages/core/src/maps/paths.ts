export type SourceKind = "first-party" | "vendor" | "virtual";

export type NormalizedSource =
  | {
      ok: true;
      kind: SourceKind;
      /** Forward-slash path with prefixes stripped and `..` resolved; never starts with `/` or `..`. */
      path: string;
      /** True when the raw path was absolute (a build-machine path), so a project root may need cutting. */
      absolute: boolean;
      /** How many leading `..` segments were dropped: how far the path climbed out of the map's folder. */
      climb: number;
    }
  | { ok: false; reason: string };

/** Bundler internals: runtime helpers, polyfills and other code no author wrote. */
const VIRTUAL_PATTERNS = [
  /^webpack\/(?:runtime|bootstrap|universalModuleDefinition|startup)\b/,
  /^\(webpack\)/,
  /^webpack\/before-startup|^webpack\/after-startup/,
  /^vite\//,
  /^@vite\//,
  /^rolldown\//,
  /^external(?:\s|%20)/,
  /^ignored\|/,
  /^\(ignored\)/,
  /__vite-browser-external/,
  /^commonjsHelpers\.js$/,
];

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?/i;
const WINDOWS_INVALID = /[<>:"|?*]/g;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects
const CONTROL = /[\u0000-\u001f]/;

/** Join a map's `sourceRoot` and a source the way the spec does, without resolving `..`. */
export function joinSourceRoot(sourceRoot: string | undefined | null, source: string): string {
  if (!sourceRoot || SCHEME.test(source) || source.startsWith("/")) return source;
  return sourceRoot.endsWith("/") ? `${sourceRoot}${source}` : `${sourceRoot}/${source}`;
}

/**
 * Turn a raw map source into a safe relative path and classify it.
 *
 * Prefixes like `webpack://<ns>/`, `file://`, `/@fs/`, `vite:` and `./` are stripped. A leading
 * run of `..` is dropped, because it only climbs out of the folder the map was written to
 * (`../../src/main.js` from `dist/assets/`). A `..` that climbs back past a real segment
 * (`src/../../../etc/passwd`) can only come from a hostile or broken map and is rejected.
 */
export function normalizeSource(raw: string): NormalizedSource {
  if (raw.includes("\0")) {
    const cleaned = raw.replaceAll("\0", "");
    const inner = normalizeSource(cleaned);
    return inner.ok ? { ...inner, kind: "virtual" } : inner;
  }
  let s = raw.trim();
  if (s === "") return { ok: false, reason: "empty source path" };
  let absolute = false;

  if (/^webpack-internal:\/\/\//.test(s)) s = s.replace(/^webpack-internal:\/\/\//, "");
  else if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/[^/]*/i, "");
    absolute = true;
  } else if (SCHEME.test(s)) {
    s = s.replace(SCHEME, "");
  }
  s = s.replace(/^vite:/, "");
  // Decode before splitting, so an encoded `%5C` cannot hide a `..` inside one segment.
  try {
    s = s.includes("%") ? decodeURI(s) : s;
  } catch {
    // Keep the raw text when it is not valid percent-encoding.
  }
  s = s.replaceAll("\\", "/");
  if (s.startsWith("/@fs/")) {
    s = s.slice(4);
    absolute = true;
  }
  // webpack loaders and Vite add queries (`?inline`, `?v=123`); they are not part of the file.
  const query = s.indexOf("?");
  if (query > 0) s = s.slice(0, query);
  if (/^\/?[a-z]:\//i.test(s)) {
    s = s.replace(/^\/?[a-z]:/i, "");
    absolute = true;
  }
  if (s.startsWith("/")) absolute = true;
  // Checked before sanitizing, which rewrites the `|` and `"` some of these names contain.
  const probe = s.replace(/^(?:\.?\/)+/, "");
  const virtual = VIRTUAL_PATTERNS.some((re) => re.test(probe));

  const stack: string[] = [];
  let sawReal = false;
  let climb = 0;
  for (const segment of s.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > 0) stack.pop();
      else if (sawReal) return { ok: false, reason: `path escapes its root: ${raw}` };
      else climb++;
      continue;
    }
    if (CONTROL.test(segment)) return { ok: false, reason: `control character in path: ${raw}` };
    let clean = segment.replace(WINDOWS_INVALID, "_").replace(/[. ]+$/, "");
    if (clean === "") clean = "_";
    if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
    stack.push(clean);
    sawReal = true;
  }
  if (stack.length === 0) return { ok: false, reason: `no file name in path: ${raw}` };
  const path = stack.join("/");
  const kind: SourceKind =
    virtual || VIRTUAL_PATTERNS.some((re) => re.test(path))
      ? "virtual"
      : stack.includes("node_modules")
        ? "vendor"
        : "first-party";
  return { ok: true, kind, path, absolute, climb: absolute ? 0 : climb };
}

/** Folder names that sit inside a project root, never above it. */
const SOURCE_DIRS = new Set([
  "src",
  "source",
  "app",
  "pages",
  "lib",
  "components",
  "client",
  "routes",
  "styles",
  "assets",
  "public",
]);

/**
 * The project roots shared by first-party paths, one for build-machine (absolute) paths and one
 * for paths that were already relative, since a map can mix both (Sass writes `file://` URLs,
 * esbuild relative ones). Each is the group's longest common folder, cut before `src` or else
 * the first well-known source folder (`app`, `pages`, ...). A relative group without one is
 * taken as project-relative; an absolute group keeps its whole common folder as the root.
 */
export function findProjectRoot(paths: { path: string; absolute: boolean }[]): {
  absolute: string;
  relative: string;
} {
  return {
    absolute: commonRoot(
      paths.filter((p) => p.absolute).map((p) => p.path),
      true,
    ),
    relative: commonRoot(
      paths.filter((p) => !p.absolute).map((p) => p.path),
      false,
    ),
  };
}

function commonRoot(paths: string[], absolute: boolean): string {
  if (paths.length === 0) return "";
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  const first = dirs[0] ?? [];
  let length = first.length;
  for (const dir of dirs) {
    let i = 0;
    while (i < length && i < dir.length && dir[i] === first[i]) i++;
    length = i;
  }
  const common = first.slice(0, length);
  // `src` is the strongest signal; `app` can just as well be the project folder's own name.
  const src = common.lastIndexOf("src");
  const sourceDir = src >= 0 ? src : common.findIndex((segment) => SOURCE_DIRS.has(segment));
  if (sourceDir >= 0) return common.slice(0, sourceDir).join("/");
  return absolute ? common.join("/") : "";
}

/** `path` relative to `root`; `root` must be a folder prefix of it (or empty). */
export function relativeTo(root: string, path: string): string {
  if (root === "") return path;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** Where a vendor source is kept under `_vendor/`: from its package-store folder onward. */
export function vendorPath(path: string): string {
  const segments = path.split("/");
  const yarn = segments.indexOf(".yarn");
  const nm = segments.indexOf("node_modules");
  const start = yarn >= 0 && (nm < 0 || yarn < nm) ? yarn : Math.max(nm, 0);
  return segments.slice(start).join("/");
}
