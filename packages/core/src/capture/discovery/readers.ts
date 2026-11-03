/**
 * Chunk-reference readers. Each reader takes the text of one captured file and returns the
 * JS/CSS URLs it points at. A reference can be ambiguous (a bare `assets/x.js` may be relative to
 * the file or to the site root), so each one carries candidate URLs to try in order.
 */

export type RefSource =
  | "generic"
  | "css-import"
  | "webpack"
  | "next"
  | "vite"
  | "importmap"
  | "preload"
  | "html"
  | "license";

export interface ChunkRef {
  /** Absolute URLs to try in order; the first that answers with a non-HTML 2xx wins. */
  candidates: string[];
  source: RefSource;
  /** URL of the file the reference was read from. */
  from: string;
}

const ASSET_PATH = /\.(?:m?js|css)(?:\?|$)/;

function resolve(ref: string, base: string | URL): string | undefined {
  try {
    const url = new URL(ref, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== undefined))];
}

/**
 * Candidate URLs for a reference found inside `fileUrl`. Absolute, root-relative and `./` refs
 * resolve one way. A bare `dir/x.js` is first tried against the folder that holds the file's own
 * `dir/` ancestor (Vite's `assets/x.js` read from `/assets/index.js` resolves to `/assets/x.js`;
 * Turbopack's `static/chunks/x.js` read from `/_next/static/chunks/a.js` to
 * `/_next/static/chunks/x.js`), then relative to the file, then to the site root.
 */
export function candidatesFor(ref: string, fileUrl: string): string[] {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|\.\.?\/)/i.test(ref)) return unique([resolve(ref, fileUrl)]);
  const dirPath = new URL(".", fileUrl).pathname;
  const firstSegment = ref.split("/")[0];
  const at = firstSegment ? dirPath.lastIndexOf(`/${firstSegment}/`) : -1;
  return unique([
    at !== -1 ? resolve(ref, new URL(dirPath.slice(0, at + 1), fileUrl)) : undefined,
    resolve(ref, fileUrl),
    resolve(ref, new URL("/", fileUrl)),
  ]);
}

function isPlausibleRef(ref: string): boolean {
  if (ref.length > 300 || ref.includes("${") || ref.includes("*")) return false;
  if (ref.includes("node_modules/")) return false;
  if (/^(?:data|blob|javascript):/i.test(ref)) return false;
  // A bare `name.js` is almost always a package name or a message, not a URL.
  return /^(?:[a-z]+:)?\/\//i.test(ref) || ref.includes("/");
}

const STRING_ASSET = /["'`]([^"'`\s<>{}()\\]+?\.(?:m?js|css)(?:\?[^"'`\s<>{}()\\]*)?)["'`]/g;

/** Every quoted string ending in `.js`, `.mjs` or `.css` that looks like a path. */
export function readGenericRefs(text: string, fileUrl: string): ChunkRef[] {
  const refs: ChunkRef[] = [];
  for (const match of text.matchAll(STRING_ASSET)) {
    const ref = match[1];
    if (!ref || !isPlausibleRef(ref)) continue;
    refs.push({ candidates: candidatesFor(ref, fileUrl), source: "generic", from: fileUrl });
  }
  return refs;
}

/** `@import` rules in a stylesheet. */
export function readCssRefs(text: string, fileUrl: string): ChunkRef[] {
  const refs: ChunkRef[] = [];
  const pattern = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/g;
  for (const match of text.matchAll(pattern)) {
    const ref = match[1];
    if (!ref) continue;
    const url = resolve(ref, fileUrl);
    if (url) refs.push({ candidates: [url], source: "css-import", from: fileUrl });
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------
// webpack

/** Return the end index of the expression starting at `start`: the first top-level `,` `;` or closer. */
function expressionEnd(text: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return i;
      depth--;
    } else if ((ch === "," || ch === ";") && depth === 0) return i;
  }
  return text.length;
}

/** Split on a top-level operator (`+` or `||`), respecting brackets and strings. */
function splitTopLevel(expr: string, op: "+" | "||"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let last = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(last, i));
      last = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(last));
  return parts.map((part) => part.trim());
}

const OBJECT_PAIR = /(?:"([^"]+)"|'([^']+)'|([\w$]+))\s*:\s*(?:"([^"]*)"|'([^']*)')/g;

function parseObject(literal: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of literal.matchAll(OBJECT_PAIR)) {
    const key = m[1] ?? m[2] ?? m[3];
    const value = m[4] ?? m[5];
    if (key !== undefined && value !== undefined) map.set(key, value);
  }
  return map;
}

function stripParens(expr: string): string {
  let out = expr.trim();
  while (out.startsWith("(") && expressionEnd(out, 1) === out.length - 1)
    out = out.slice(1, -1).trim();
  return out;
}

type Term = (id: string) => string | undefined;

/** Compile the small expression language webpack uses for chunk file names. */
function compileChunkExpr(expr: string, param: string, ids: Set<string>): Term | undefined {
  const inner = stripParens(expr);
  const alternatives = splitTopLevel(inner, "||");
  if (alternatives.length > 1) {
    const compiled = alternatives.map((alt) => compileChunkExpr(alt, param, ids));
    if (compiled.some((c) => !c)) return undefined;
    return (id) => {
      for (const term of compiled) {
        const value = term?.(id);
        if (value !== undefined && value !== "") return value;
      }
      return undefined;
    };
  }
  const terms = splitTopLevel(inner, "+");
  if (terms.length > 1) {
    const compiled = terms.map((term) => compileChunkExpr(term, param, ids));
    if (compiled.some((c) => !c)) return undefined;
    return (id) => {
      let out = "";
      for (const term of compiled) {
        const value = term?.(id);
        if (value === undefined) return undefined;
        out += value;
      }
      return out;
    };
  }
  const term = inner;
  const str = /^(["'])(.*)\1$/s.exec(term);
  if (str) {
    const value = str[2] ?? "";
    return () => value;
  }
  if (term === param) return (id) => id;
  // The public path (`__webpack_require__.p`) is prepended separately.
  if (/^[\w$]+\.p$/.test(term)) return () => "";
  const lookup = /^\(?(\{[\s\S]*\})\)?\s*\[\s*([\w$]+)\s*\]$/.exec(term);
  if (lookup?.[1] && lookup[2] === param) {
    const map = parseObject(lookup[1]);
    for (const key of map.keys()) ids.add(key);
    return (id) => map.get(id);
  }
  return undefined;
}

const CHUNK_FN =
  /\.(?:u|miniCssF)\s*=\s*(?:function\s*\(\s*([\w$]+)\s*\)\s*\{\s*return\s+|\(?\s*([\w$]+)\s*\)?\s*=>\s*)/g;
const LEGACY_CHUNK_FN =
  /function\s+[\w$]+\s*\(\s*([\w$]+)\s*\)\s*\{\s*return\s+(?=[\w$]+\.p\s*\+)/g;

/** Chunk file names from a webpack runtime's `__webpack_require__.u` / `.miniCssF`, prefixed by `.p`. */
export function readWebpackRefs(text: string, fileUrl: string): ChunkRef[] {
  if (!text.includes(".p=") && !text.includes(".p =")) return [];
  const publicPathMatch = /[\w$]\.p\s*=\s*(["'])([^"']*)\1/.exec(text);
  const rawPublicPath = publicPathMatch?.[2];
  const publicPath =
    rawPublicPath === undefined || rawPublicPath === "auto"
      ? new URL(".", fileUrl).href
      : resolve(rawPublicPath, fileUrl);
  if (!publicPath) return [];

  const names = new Set<string>();
  for (const pattern of [CHUNK_FN, LEGACY_CHUNK_FN]) {
    for (const match of text.matchAll(pattern)) {
      const param = match[1] ?? match[2];
      if (!param) continue;
      const start = match.index + match[0].length;
      const expr = text.slice(start, expressionEnd(text, start));
      const ids = new Set<string>();
      const fn = compileChunkExpr(expr, param, ids);
      if (!fn) continue;
      for (const id of ids) {
        const name = fn(id);
        if (name && ASSET_PATH.test(name)) names.add(name);
      }
    }
  }
  return [...names].flatMap((name) => {
    const url = resolve(name, publicPath);
    return url ? [{ candidates: [url], source: "webpack" as const, from: fileUrl }] : [];
  });
}

// ---------------------------------------------------------------------------------------------
// Next.js

function nextBase(fileUrl: string): string | undefined {
  const url = new URL(fileUrl);
  const index = url.pathname.indexOf("/_next/");
  if (index !== -1) return new URL(url.pathname.slice(0, index + 7), url).href;
  const manifest = /^(.*\/)static\/[^/]+\/_(?:build|ssg)Manifest\.js$/.exec(url.pathname);
  return manifest?.[1] ? new URL(manifest[1], url).href : undefined;
}

/** `_buildManifest.js` (webpack and Turbopack forms): every page's chunk list, relative to `/_next/`. */
export function readNextRefs(text: string, fileUrl: string): ChunkRef[] {
  if (!/__BUILD_MANIFEST|__TURBOPACK_PAGE_BOOTSTRAP|__SSG_MANIFEST/.test(text)) return [];
  const base = nextBase(fileUrl);
  if (!base) return [];
  const refs: ChunkRef[] = [];
  for (const match of text.matchAll(STRING_ASSET)) {
    const ref = match[1];
    if (!ref || /^(?:[a-z]+:)?\/\//i.test(ref)) continue;
    const url = resolve(ref.replace(/^\//, ""), base);
    if (url) refs.push({ candidates: [url], source: "next", from: fileUrl });
  }
  // The SSG manifest sits next to the build manifest and is not referenced from it.
  const dir = /^(.*\/static\/[^/]+\/)_buildManifest\.js$/.exec(new URL(fileUrl).pathname);
  if (dir?.[1]) {
    for (const sibling of ["_ssgManifest.js"]) {
      const url = resolve(`${dir[1]}${sibling}`, fileUrl);
      if (url) refs.push({ candidates: [url], source: "next", from: fileUrl });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------
// Vite / Rollup

/** The dependency list in Vite's `__vite__mapDeps` helper, relative to the base URL. */
export function readViteRefs(text: string, fileUrl: string): ChunkRef[] {
  const refs: ChunkRef[] = [];
  const pattern = /__vite__mapDeps\s*=\s*\([^)]*?\.f\s*=\s*(\[[^\]]*\])/g;
  for (const match of text.matchAll(pattern)) {
    for (const item of (match[1] ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)) {
      const ref = item[1];
      if (!ref || !ASSET_PATH.test(ref)) continue;
      refs.push({ candidates: candidatesFor(ref, fileUrl), source: "vite", from: fileUrl });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------
// HTML

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * References in an HTML document: `<script src>`, stylesheet and (module)preload/prefetch links,
 * import maps, and the Next.js build manifest named by `__NEXT_DATA__.buildId`.
 */
export function readHtmlRefs(html: string, pageUrl: string): ChunkRef[] {
  const baseHref = /<base\b[^>]*>/i.exec(html)?.[0];
  const base =
    (baseHref && resolve(decodeEntities(attr(baseHref, "href") ?? ""), pageUrl)) || pageUrl;
  const refs: ChunkRef[] = [];
  const push = (ref: string | undefined, source: RefSource) => {
    if (!ref) return;
    const url = resolve(decodeEntities(ref), base);
    if (url) refs.push({ candidates: [url], source, from: pageUrl });
  };

  for (const match of html.matchAll(/<script\b[^>]*>/gi)) push(attr(match[0], "src"), "html");

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const as = (attr(tag, "as") ?? "").toLowerCase();
    const href = attr(tag, "href");
    if (!href) continue;
    if (rel.includes("stylesheet")) push(href, "html");
    else if (rel.some((r) => r === "modulepreload" || r === "preload" || r === "prefetch")) {
      if (
        rel.includes("modulepreload") ||
        as === "script" ||
        as === "style" ||
        ASSET_PATH.test(href)
      ) {
        push(href, "preload");
      }
    }
  }

  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']?importmap["']?[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const map = JSON.parse(match[1] ?? "{}") as {
        imports?: Record<string, string>;
        scopes?: Record<string, Record<string, string>>;
      };
      const targets = [
        ...Object.values(map.imports ?? {}),
        ...Object.values(map.scopes ?? {}).flatMap((scope) => Object.values(scope)),
      ];
      for (const target of targets) {
        if (typeof target === "string" && !target.endsWith("/")) push(target, "importmap");
      }
    } catch {
      // Invalid import maps are ignored by browsers too.
    }
  }

  const nextData = /<script\b[^>]*id=["']?__NEXT_DATA__["']?[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (nextData?.[1]) {
    try {
      const data = JSON.parse(nextData[1]) as { buildId?: string; assetPrefix?: string };
      if (data.buildId) {
        const prefix = (data.assetPrefix ?? "").replace(/\/$/, "");
        for (const file of ["_buildManifest.js", "_ssgManifest.js"]) {
          push(`${prefix}/_next/static/${data.buildId}/${file}`, "next");
        }
      }
    } catch {
      // Not JSON; nothing to read.
    }
  }
  return refs;
}

/**
 * The `*.LICENSE.txt` file named by webpack's `/*! For license information please see … *\/`
 * comment, as an absolute URL. The comment sits at the very top of the bundle.
 */
export function readLicenseRef(text: string, fileUrl: string): string | undefined {
  const ref = /\/\*!\s*For license information please see\s+(\S+?\.LICENSE\.txt)\s*\*\//.exec(
    text.slice(0, 2048),
  )?.[1];
  return ref ? resolve(ref, fileUrl) : undefined;
}

/** Run every reader that applies to a file of the given kind. */
export function readRefs(kind: "js" | "css" | "html", text: string, url: string): ChunkRef[] {
  if (kind === "html") return readHtmlRefs(text, url);
  if (kind === "css") return readCssRefs(text, url);
  return [
    ...readWebpackRefs(text, url),
    ...readNextRefs(text, url),
    ...readViteRefs(text, url),
    ...readGenericRefs(text, url),
  ];
}
