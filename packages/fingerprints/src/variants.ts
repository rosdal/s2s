import { builtinModules } from "node:module";
import { build, transform } from "esbuild";
import { minifySync as oxcMinify } from "oxc-minify";
import { minify as terser } from "terser";

/**
 * The minifier settings each entry is indexed under: the minifiers behind webpack (terser),
 * Vite and Rolldown (esbuild, oxc), plus an ES2015 target for sites that build for old browsers.
 */
export const VARIANTS = ["esbuild", "terser", "oxc-es2020", "terser-es2015"] as const;
export type Variant = (typeof VARIANTS)[number];

export class EntryError extends Error {
  override name = "EntryError";
  constructor(
    message: string,
    readonly reason: "node-only" | "unresolved" | "empty",
  ) {
    super(message);
  }
}

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: unknown;
}

/** Imports that stay external: every dependency (and its subpaths), so each package's hashes cover only its own code. */
export function externalsOf(pkg: PackageJson): string[] {
  const names = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  names.delete(pkg.name ?? "");
  return [...names].flatMap((n) => [n, `${n}/*`]);
}

const NON_JS = /\.(?:css|scss|sass|less|json|d\.ts|d\.mts|d\.cts|wasm|map|md|txt|svg|png|woff2?)$/;
export const MAX_SUBPATHS = 20;

/**
 * The specifiers sites import: the package itself plus up to 20 subpath exports. A wildcard
 * subpath (`"./*"`) is expanded against the package's files.
 */
export function entrySpecifiers(name: string, pkg: PackageJson, files: string[] = []): string[] {
  const out = [name];
  const exports = pkg.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return out;
  const add = (subpath: string) => {
    const spec = `${name}${subpath.slice(1)}`;
    if (out.length <= MAX_SUBPATHS && !out.includes(spec)) out.push(spec);
  };
  const keys = Object.keys(exports).filter((k) => k.startsWith("./"));
  for (const key of keys) {
    if (key === "./package.json" || key.endsWith("/") || NON_JS.test(key)) continue;
    const value = (exports as Record<string, unknown>)[key];
    if (!hasJsTarget(value)) continue;
    if (!key.includes("*")) add(key);
  }
  for (const key of keys) {
    if (!key.includes("*") || key.split("*").length !== 2) continue;
    const target = pickTarget((exports as Record<string, unknown>)[key]);
    if (target?.split("*").length !== 2 || NON_JS.test(target)) continue;
    const [pre, post] = target.replace(/^\.\//, "").split("*") as [string, string];
    const [keyPre, keyPost] = key.split("*") as [string, string];
    for (const file of [...files].sort()) {
      if (!file.startsWith(pre) || !file.endsWith(post) || file.length < pre.length + post.length)
        continue;
      const stem = file.slice(pre.length, file.length - post.length);
      if (!stem || stem.includes("/") || stem.startsWith("_") || /\.d$/.test(stem)) continue;
      add(`${keyPre}${stem}${keyPost}`);
    }
  }
  return out;
}

const CONDITIONS = ["browser", "production", "import", "module", "default", "require"];

/** The file a browser bundler would pick from an `exports` value. */
function pickTarget(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const picked = pickTarget(t);
      if (picked) return picked;
    }
    return undefined;
  }
  if (target && typeof target === "object") {
    const record = target as Record<string, unknown>;
    for (const condition of CONDITIONS)
      if (condition in record) {
        const picked = pickTarget(record[condition]);
        if (picked) return picked;
      }
  }
  return undefined;
}

function hasJsTarget(target: unknown): boolean {
  if (typeof target === "string") return !NON_JS.test(target);
  if (Array.isArray(target)) return target.some(hasJsTarget);
  if (target && typeof target === "object")
    return Object.entries(target).some(([k, v]) => k !== "types" && hasJsTarget(v));
  return false;
}

/**
 * Bundle one specifier, unminified, from a folder whose `node_modules/<name>` holds the unpacked
 * package. The entry re-exports the whole namespace so nothing is tree-shaken away; `NODE_ENV`
 * is `production`, as on a deployed site.
 */
export async function bundleEntry(
  dir: string,
  specifier: string,
  externals: string[],
): Promise<string> {
  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await build({
      stdin: {
        contents: `import * as ns from ${JSON.stringify(specifier)};\nexport default ns;\n`,
        resolveDir: dir,
        loader: "js",
      },
      absWorkingDir: dir,
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "esnext",
      conditions: ["production"],
      mainFields: ["browser", "module", "main"],
      define: { "process.env.NODE_ENV": '"production"' },
      external: externals,
      loader: {
        ".css": "empty",
        ".svg": "empty",
        ".png": "empty",
        ".woff": "empty",
        ".woff2": "empty",
        // wasm-bindgen's bundler target imports its binary as a module (`@dimforge/rapier3d`):
        // the JS glue is what a site's bundle carries and what gets fingerprinted.
        ".wasm": "empty",
      },
      logLevel: "silent",
      metafile: true,
      legalComments: "none",
    });
  } catch (error) {
    const errors = (error as { errors?: { text: string }[] }).errors ?? [];
    const text = errors.map((e) => e.text).join("; ") || (error as Error).message;
    const builtin = errors.some((e) => {
      const m = /Could not resolve "([^"]+)"/.exec(e.text);
      return m ? BUILTINS.has(m[1] as string) : false;
    });
    throw new EntryError(text.slice(0, 300), builtin ? "node-only" : "unresolved");
  }
  const output = result.outputFiles?.[0]?.text ?? "";
  for (const input of Object.values(result.metafile?.outputs ?? {}))
    for (const imp of input.imports)
      if (imp.external && BUILTINS.has(imp.path))
        throw new EntryError(`imports Node built-in "${imp.path}"`, "node-only");
  return output;
}

export interface VariantOutput {
  codes: Partial<Record<Variant, string>>;
  /** Variants that failed (an ES2015 target cannot lower every feature), with why. */
  errors: Partial<Record<Variant, string>>;
}

const MAKERS: Record<Variant, (code: string) => Promise<string>> = {
  esbuild: async (code) =>
    (await transform(code, { minify: true, format: "esm", target: "esnext" })).code,
  terser: async (code) => (await terser(code, { module: true })).code ?? "",
  "oxc-es2020": async (code) => {
    const es2020 = (await transform(code, { format: "esm", target: "es2020" })).code;
    const out = oxcMinify("entry.js", es2020, { compress: { target: "es2020" }, mangle: true });
    if (out.errors.length > 0) throw new Error(out.errors[0]?.message ?? "oxc-minify failed");
    return out.code;
  },
  "terser-es2015": async (code) => {
    const es2015 = (await transform(code, { format: "esm", target: "es2015" })).code;
    return (await terser(es2015, { module: true, ecma: 2015 })).code ?? "";
  },
};

/** The minified variants of one bundled entry; a variant that fails is skipped, not fatal. */
export async function minifyVariants(code: string): Promise<VariantOutput> {
  const out: VariantOutput = { codes: {}, errors: {} };
  for (const variant of VARIANTS) {
    try {
      out.codes[variant] = await MAKERS[variant](code);
    } catch (error) {
      out.errors[variant] = (
        (error as { errors?: { text: string }[] }).errors?.[0]?.text ?? (error as Error).message
      ).slice(0, 200);
    }
  }
  return out;
}
