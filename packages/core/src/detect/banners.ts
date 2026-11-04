import { isNpmName } from "./evidence.js";

export type BannerShape = "name-version" | "name-at-version" | "license-name-version" | "file-name";

export interface BannerHit {
  name: string;
  version: string | null;
  shape: BannerShape;
}

export interface BannerComment {
  /** String index of the comment's first character. */
  index: number;
  text: string;
}

/**
 * Display names in banners that differ from the npm name. Keys are lowercase. React ships one
 * banner per build file (`react-dom-client.production.js`), and those files belong to a package
 * with a shorter name.
 */
const ALIASES: Record<string, string> = {
  cssplugin: "gsap",
  scrolltrigger: "gsap",
  draggable: "gsap",
  flip: "gsap",
  "chart.js": "chart.js",
  chartjs: "chart.js",
  "core-js": "core-js",
  "react-dom-client": "react-dom",
  "react-dom-server": "react-dom",
  "react-dom-server-legacy": "react-dom",
  "react-dom-server.browser": "react-dom",
  "react-dom-test-utils": "react-dom",
  "react-dom-profiling": "react-dom",
  "react-jsx-runtime": "react",
  "react-jsx-dev-runtime": "react",
  "react-compiler-runtime": "react",
  "react-is": "react-is",
  // React's shim package names its build files after the entry point, not the package.
  "use-sync-external-store-shim": "use-sync-external-store",
  "use-sync-external-store-with-selector": "use-sync-external-store",
  "three.js": "three",
  "vue.js": "vue",
};

/** Words that sit before a version in banners without being a package name. */
const NOT_NAMES = new Set([
  "copyright",
  "license",
  "licensed",
  "version",
  "v",
  "mit",
  "isc",
  "bsd",
  "apache",
  "gpl",
  "lgpl",
  "mpl",
  "released",
  "under",
  "the",
  "and",
  "by",
  "from",
  "at",
  "of",
  "is",
  "build",
  "date",
  "http",
  "https",
]);

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const NAME = String.raw`@?[A-Za-z0-9][\w.~-]*(?:\/[A-Za-z0-9][\w.~-]*)?`;

const LICENSE_NAME_VERSION = new RegExp(`@license\\s+(${NAME})\\s+v?(${SEMVER})(?![\\w.])`, "g");
const NAME_AT_VERSION = new RegExp(`(?:^|[\\s(\\[,])(${NAME})@(${SEMVER})(?![\\w.])`, "g");
const NAME_VERSION = new RegExp(`(?:^|[\\s(\\[,|*!])(${NAME})\\s+v?(${SEMVER})(?![\\w.])`, "g");
const FILE_NAME =
  /(?:^|[\s/])((?:@[\w.-]+\/)?[A-Za-z0-9][\w.-]*?)\.(?:production|development|profiling)(?:\.min)?\.js\b/g;

/** A React build-file line, capturing its first path segment (or the whole name without one). */
const REACT_FILE_PATH =
  /(?:^|\s)((?:@[\w.-]+\/)?[A-Za-z0-9][\w.-]*?)(?:\/[\w./-]+?)?\.(?:production|development|profiling)(?:\.min)?\.js\b/g;

/** Normalize a banner name to an npm name, or `undefined` when it cannot be one. */
export function bannerName(raw: string): string | undefined {
  let name = raw.toLowerCase().replace(/[.,;:]+$/, "");
  if (NOT_NAMES.has(name)) return undefined;
  name = ALIASES[name] ?? name;
  if (name.endsWith(".js") && !ALIASES[name]) name = name.slice(0, -3);
  if (name.length < 2 || !isNpmName(name) || NOT_NAMES.has(name)) return undefined;
  return name;
}

/**
 * Read package names and versions from one banner comment. Handles `name vX.Y.Z`,
 * `name@X.Y.Z`, `@license name X.Y.Z` and React's `name.production.min.js` file lines. Each
 * package is reported once, with a version when any shape gave one.
 */
export function parseBanner(comment: string): BannerHit[] {
  const body = comment
    .replace(/^\/\*+!?|\*+\/$/g, "")
    .replace(/^\/\/!?/gm, "")
    .replace(/^\s*\*+ ?/gm, " ");
  const hits = new Map<string, BannerHit>();
  const add = (raw: string | undefined, version: string | null, shape: BannerShape) => {
    const name = raw ? bannerName(raw) : undefined;
    if (!name) return;
    const known = hits.get(name);
    if (!known || (known.version === null && version !== null))
      hits.set(name, { name, version, shape });
  };
  // React's banners name the project, then the build file: `@license React v17.0.2` above
  // `react-dom.production.min.js`. The version (only before React 18) belongs to the file's package.
  const react = /@license\s+React\b(?:\s+v?([\d.]+\d))?/.exec(body);
  if (react) {
    // `use-sync-external-store-shim/with-selector.production.js` is one build file: the folder
    // names the package, the rest is the entry point inside it.
    for (const m of body.matchAll(REACT_FILE_PATH)) add(m[1], react[1] ?? null, "file-name");
    return [...hits.values()];
  }
  for (const m of body.matchAll(LICENSE_NAME_VERSION))
    add(m[1], m[2] ?? null, "license-name-version");
  for (const m of body.matchAll(NAME_AT_VERSION)) add(m[1], m[2] ?? null, "name-at-version");
  for (const m of body.matchAll(NAME_VERSION)) add(m[1], m[2] ?? null, "name-version");
  for (const m of body.matchAll(FILE_NAME)) add(m[1], null, "file-name");
  return [...hits.values()];
}

/** True for comments that carry license or attribution text worth parsing. */
export function isBannerComment(text: string): boolean {
  return text.startsWith("/*!") || text.startsWith("//!") || /@license|@preserve/.test(text);
}

// Block comments, plus `//!` line comments. Bundles are minified, so a comment-like run inside a
// string is rare, and anything found still has to pass the banner and registry checks.
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/![^\n]*/g;

/** Every banner comment in a JS or CSS body, with its position. */
export function findBanners(text: string): BannerComment[] {
  const out: BannerComment[] = [];
  for (const m of text.matchAll(COMMENT)) {
    if (isBannerComment(m[0])) out.push({ index: m.index, text: m[0] });
  }
  return out;
}
