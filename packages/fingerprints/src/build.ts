import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fingerprintCode,
  fromHex,
  hashHex,
  NORMALIZER_VERSION,
} from "@rosdal/s2s-core/fingerprint";
import { type Fetch, fetchTarball, unpackTarball } from "./tarball.js";
import {
  bundleEntry,
  EntryError,
  entrySpecifiers,
  externalsOf,
  minifyVariants,
  type Variant,
} from "./variants.js";

/** Bumped when bundling or the variants change, so cached results are rebuilt. */
export const BUILDER_VERSION = "3";
/**
 * Bumped only when bundling or minifying changes what an entry hashes to. Separate from
 * `BUILDER_VERSION`, so result-format changes reuse the expensive per-entry work.
 */
const ENTRY_CACHE_VERSION = "2";

/** One package@version of the corpus, with where its tarball lives. */
export interface CorpusVersion {
  name: string;
  version: string;
  tarball: string;
  integrity: string;
}

export interface EntryResult {
  specifier: string;
  status: "ok" | "skipped";
  /** Why an entry was skipped: it needs Node, an import did not resolve, or it held no code. */
  reason: string | null;
  error: string | null;
  variants: Variant[];
  variantErrors: Partial<Record<Variant, string>>;
  functions: number;
}

export interface VersionResult {
  name: string;
  version: string;
  builder: string;
  normalizer: number;
  entries: EntryResult[];
  /** Distinct function hashes across entries and variants, hex. */
  functions: string[];
  /** Distinct string hashes, hex. */
  strings: string[];
  /** Runtime and peer dependencies the version declares. */
  dependencies: string[];
  ms: number;
  /** Set when the whole version failed (tarball, unpack). */
  error: string | null;
}

export function resultPath(cacheDir: string, name: string, version: string): string {
  return path.join(cacheDir, "results", `${name.replaceAll("/", "+")}@${version}.json`);
}

/** A cached result, when it was built by this builder and normalizer. */
export async function loadResult(
  cacheDir: string,
  name: string,
  version: string,
): Promise<VersionResult | undefined> {
  try {
    const result = JSON.parse(
      await readFile(resultPath(cacheDir, name, version), "utf8"),
    ) as VersionResult;
    if (result.builder !== BUILDER_VERSION || result.normalizer !== NORMALIZER_VERSION)
      return undefined;
    // A version that failed outright (a network error, a bad tarball) is built again.
    if (result.error) return undefined;
    return result;
  } catch {
    return undefined;
  }
}

export async function saveResult(cacheDir: string, result: VersionResult): Promise<void> {
  const file = resultPath(cacheDir, result.name, result.version);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(result));
  await rename(tmp, file);
}

export interface BuildOptions {
  cacheDir: string;
  fetch?: Fetch;
  /** An already-downloaded tarball (`s2s db build --from-tarball`); skips the registry. */
  tarballBytes?: Uint8Array;
}

/**
 * Fingerprint one package@version: fetch and verify its tarball, unpack it into a temp folder,
 * bundle each entry with its dependencies external, minify every variant and hash the result.
 * Entries that fail to bundle are skipped and logged in the result.
 */
export async function buildVersion(
  entry: CorpusVersion,
  options: BuildOptions,
): Promise<VersionResult> {
  const started = performance.now();
  const result: VersionResult = {
    name: entry.name,
    version: entry.version,
    builder: BUILDER_VERSION,
    normalizer: NORMALIZER_VERSION,
    entries: [],
    functions: [],
    strings: [],
    dependencies: [],
    ms: 0,
    error: null,
  };
  const dir = await mkdtemp(path.join(tmpdir(), "s2s-fp-"));
  const functions = new Set<bigint>();
  const strings = new Set<bigint>();
  try {
    const tgz =
      options.tarballBytes ??
      (await fetchTarball({
        name: entry.name,
        version: entry.version,
        url: entry.tarball,
        integrity: entry.integrity,
        cacheDir: options.cacheDir,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }));
    const pkgDir = path.join(dir, "node_modules", ...entry.name.split("/"));
    await unpackTarball(tgz, pkgDir);
    const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
    const externals = externalsOf(pkg);
    result.dependencies = [
      ...new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ]),
    ].sort();
    const files = (await readdir(pkgDir, { recursive: true, withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => path.relative(pkgDir, path.join(d.parentPath, d.name)).split(path.sep).join("/"));
    for (const specifier of entrySpecifiers(entry.name, pkg, files)) {
      const er: EntryResult = {
        specifier,
        status: "ok",
        reason: null,
        error: null,
        variants: [],
        variantErrors: {},
        functions: 0,
      };
      result.entries.push(er);
      try {
        const code = await bundleEntry(dir, specifier, externals);
        const prints = await entryPrints(code, options.cacheDir);
        er.variants = prints.variants;
        er.variantErrors = prints.errors;
        const mine = new Set(prints.functions.map(fromHex));
        for (const h of prints.strings) strings.add(fromHex(h));
        er.functions = mine.size;
        for (const h of mine) functions.add(h);
        if (mine.size === 0) {
          er.status = "skipped";
          er.reason = "empty";
        }
      } catch (error) {
        er.status = "skipped";
        er.reason = error instanceof EntryError ? error.reason : "unresolved";
        er.error = (error as Error).message;
      }
    }
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  result.functions = [...functions].map(hashHex).sort();
  result.strings = [...strings].map(hashHex).sort();
  result.ms = Math.round(performance.now() - started);
  return result;
}

interface EntryPrints {
  variants: Variant[];
  errors: Partial<Record<Variant, string>>;
  functions: string[];
  strings: string[];
}

/**
 * Hashes of one bundled entry across every variant, cached by the bundle's content: most
 * releases change a few files, so most entries bundle to exactly what an earlier version did and
 * their minify-and-hash work is skipped.
 */
async function entryPrints(code: string, cacheDir: string): Promise<EntryPrints> {
  const key = createHash("sha256")
    .update(`${ENTRY_CACHE_VERSION}\u0000${NORMALIZER_VERSION}\u0000`)
    .update(code)
    .digest("hex");
  const file = path.join(cacheDir, "entries", key.slice(0, 2), `${key}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as EntryPrints;
  } catch {
    // Not built yet.
  }
  const out = await minifyVariants(code);
  const result: EntryPrints = { variants: [], errors: out.errors, functions: [], strings: [] };
  const functions = new Set<bigint>();
  const strings = new Set<bigint>();
  for (const [variant, minified] of Object.entries(out.codes) as [Variant, string][]) {
    const prints = await fingerprintCode(minified, `${variant}.js`);
    if (prints.error) {
      result.errors[variant] = prints.error;
      continue;
    }
    result.variants.push(variant);
    for (const f of prints.functions) functions.add(f.hash);
    for (const s of prints.strings) strings.add(s.hash);
  }
  result.functions = [...functions].map(hashHex);
  result.strings = [...strings].map(hashHex);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(result));
  await rename(tmp, file).catch(() => rm(tmp, { force: true }));
  return result;
}
