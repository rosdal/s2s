import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../fs-util.js";

/** What s2s keeps of a packument: enough to check versions, dates and dependencies. */
export interface PackageInfo {
  name: string;
  latest: string | null;
  /** Each published version, with the names of its runtime dependencies and its peer ranges. */
  versions: Record<string, { dependencies: string[]; peers?: Record<string, string> }>;
  /** Publish time per version (ISO). */
  time: Record<string, string>;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface RegistryOptions {
  /** Where responses are cached; defaults to `~/.cache/s2s/registry`. */
  cacheDir?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  registryUrl?: string;
  downloadsUrl?: string;
  /** How long a cached answer stays fresh. Defaults to 24 hours. */
  ttlMs?: number;
  signal?: AbortSignal;
}

interface Cached<T> {
  fetchedAt: string;
  /** `null` for a 404: the package does not exist. */
  value: T | null;
}

export class RegistryError extends Error {
  override name = "RegistryError";
}

/** The s2s cache root: `$S2S_CACHE_DIR`, then `$XDG_CACHE_HOME/s2s`, then `~/.cache/s2s`. */
export function cacheRoot(): string {
  return (
    process.env.S2S_CACHE_DIR ??
    (process.env.XDG_CACHE_HOME
      ? path.join(process.env.XDG_CACHE_HOME, "s2s")
      : path.join(homedir(), ".cache", "s2s"))
  );
}

/** The registry response cache, under `cacheRoot()`. */
export function defaultCacheDir(): string {
  return path.join(cacheRoot(), "registry");
}

/** Reduce a full or abbreviated packument to `PackageInfo`. */
export function trimPackument(body: unknown): PackageInfo {
  const doc = (body ?? {}) as {
    name?: string;
    "dist-tags"?: Record<string, string>;
    versions?: Record<
      string,
      { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    >;
    time?: Record<string, string>;
  };
  const versions: PackageInfo["versions"] = {};
  for (const [version, meta] of Object.entries(doc.versions ?? {})) {
    const peers = meta?.peerDependencies;
    versions[version] = {
      dependencies: Object.keys(meta?.dependencies ?? {}).sort(),
      ...(peers && Object.keys(peers).length > 0 ? { peers } : {}),
    };
  }
  const time: Record<string, string> = {};
  for (const [version, at] of Object.entries(doc.time ?? {})) {
    if (version in versions && typeof at === "string") time[version] = at;
  }
  return { name: doc.name ?? "", latest: doc["dist-tags"]?.latest ?? null, versions, time };
}

/**
 * A small npm registry client: package metadata and weekly downloads, over plain `fetch`, with an
 * on-disk cache so repeat runs make no requests.
 */
export class Registry {
  readonly #cacheDir: string;
  readonly #fetch: FetchLike;
  readonly #registryUrl: string;
  readonly #downloadsUrl: string;
  readonly #ttlMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #memory = new Map<string, Promise<unknown>>();
  requests = 0;
  cacheHits = 0;

  /** True once the run's signal has fired; callers rethrow instead of carrying on. */
  get aborted(): boolean {
    return this.#signal?.aborted ?? false;
  }

  constructor(options: RegistryOptions = {}) {
    this.#cacheDir = options.cacheDir ?? defaultCacheDir();
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#registryUrl = (options.registryUrl ?? "https://registry.npmjs.org").replace(/\/$/, "");
    this.#downloadsUrl = (options.downloadsUrl ?? "https://api.npmjs.org/downloads").replace(
      /\/$/,
      "",
    );
    this.#ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.#signal = options.signal;
  }

  /** Metadata for a package, or `null` when the registry has no such package. */
  packageInfo(name: string): Promise<PackageInfo | null> {
    // `.v2`: entries cached before peer ranges were kept would hide them for a day.
    return this.#cached(`${encodeName(name)}.v2.json`, async () => {
      const body = await this.#get(`${this.#registryUrl}/${encodeName(name)}`);
      return body === null ? null : trimPackument(body);
    });
  }

  /** Downloads in the last week, or `null` when the package is unknown. */
  weeklyDownloads(name: string): Promise<number | null> {
    return this.#cached(`${encodeName(name)}.downloads.json`, async () => {
      const body = (await this.#get(`${this.#downloadsUrl}/point/last-week/${name}`)) as {
        downloads?: number;
      } | null;
      return typeof body?.downloads === "number" ? body.downloads : null;
    });
  }

  #cached<T>(file: string, load: () => Promise<T | null>): Promise<T | null> {
    const known = this.#memory.get(file);
    if (known) return known as Promise<T | null>;
    const promise = (async () => {
      const full = path.join(this.#cacheDir, file);
      try {
        const cached = JSON.parse(await readFile(full, "utf8")) as Cached<T>;
        if (Date.now() - Date.parse(cached.fetchedAt) < this.#ttlMs) {
          this.cacheHits++;
          return cached.value;
        }
      } catch {
        // Missing or corrupt cache entries are refetched.
      }
      const value = await load();
      try {
        await mkdir(this.#cacheDir, { recursive: true });
        await writeJsonAtomic(full, { fetchedAt: new Date().toISOString(), value } as Cached<T>);
      } catch {
        // The cache only saves requests; an unwritable one must not fail the stage.
      }
      return value;
    })();
    this.#memory.set(file, promise);
    return promise;
  }

  async #get(url: string): Promise<unknown> {
    this.requests++;
    let response: Response;
    try {
      response = await this.#fetch(url, this.#signal ? { signal: this.#signal } : {});
    } catch (error) {
      // An interrupt is not an unreachable registry: let it stop the stage.
      if (this.#signal?.aborted) throw error;
      throw new RegistryError(`Could not reach ${url}: ${(error as Error).message}`);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new RegistryError(`${url} answered ${response.status}`);
    try {
      return await response.json();
    } catch (error) {
      if (this.#signal?.aborted) throw error;
      // A proxy or captive portal answering with HTML.
      throw new RegistryError(`${url} did not answer with JSON`);
    }
  }
}

/** `@scope/name` becomes `@scope%2fname`, the form the registry and the cache both use. */
export function encodeName(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

// --- Version helpers -------------------------------------------------------------------------

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export function parseVersion(version: string): Parsed | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return a.localeCompare(b);
  return (
    x.major - y.major ||
    x.minor - y.minor ||
    x.patch - y.patch ||
    (x.pre === y.pre ? 0 : x.pre === null ? 1 : y.pre === null ? -1 : x.pre.localeCompare(y.pre))
  );
}

/** True for an x-range like `0.187.x` or `5.x`. */
export function isXRange(version: string): boolean {
  return /^\d+(?:\.\d+)?\.x$/.test(version);
}

function inXRange(version: string, range: string): boolean {
  const prefix = range.slice(0, -1);
  return version.startsWith(prefix);
}

/**
 * The newest stable version published on or before `cutoff` (and inside `range`, when given). Falls
 * back to the oldest matching version when every match is newer than the cutoff.
 */
export function resolveVersion(
  info: PackageInfo,
  cutoff: Date | null,
  range?: string,
): string | null {
  const candidates = Object.keys(info.versions)
    .filter((v) => parseVersion(v)?.pre === null)
    .filter((v) => !range || inXRange(v, range))
    .sort(compareVersions);
  if (candidates.length === 0) return null;
  if (!cutoff) return candidates.at(-1) ?? null;
  const limit = cutoff.getTime();
  const before = candidates.filter((v) => {
    const at = info.time[v];
    return at !== undefined && Date.parse(at) <= limit;
  });
  return before.at(-1) ?? candidates[0] ?? null;
}
