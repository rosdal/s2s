import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { cacheRoot } from "../detect/registry.js";
import { FingerprintIndex } from "./db.js";

/** The repository whose `fingerprints-YYYY-MM-DD` releases carry the shared index. */
export const FINGERPRINT_REPO = "Rosdal/s2s";
export type PullFetch = (url: string, init?: RequestInit) => Promise<Response>;

export const TAG_PREFIX = "fingerprints-";
export const OVERLAY_FILE = "local-overlay.sqlite";
/** `s2s detect` suggests `s2s db pull` once the shared index is older than this. */
export const STALE_DAYS = 30;

const SHARED = /^fingerprints-(\d{4}-\d{2}-\d{2})\.sqlite$/;

/** `~/.cache/s2s/fingerprints`, or the same under `$S2S_CACHE_DIR` / `$XDG_CACHE_HOME`. */
export function fingerprintDir(): string {
  return path.join(cacheRoot(), "fingerprints");
}

/** The newest shared index in the folder, by the date in its name. */
export async function findSharedIndex(dir = fingerprintDir()): Promise<string | undefined> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const newest = names
    .filter((n) => SHARED.test(n))
    .sort()
    .pop();
  return newest ? path.join(dir, newest) : undefined;
}

export interface IndexFileStatus {
  path: string;
  /** The corpus date of the shared index (from its metadata, else its file name). */
  date: string | null;
  ageDays: number | null;
  bytes: number;
  packages: number;
  versions: number;
  hashes: number;
  strings: number;
  schemaVersion: number;
  builderVersion: string | null;
  /** Set when the file exists but cannot be used. */
  error: string | null;
}

export interface IndexStatus {
  dir: string;
  shared: IndexFileStatus | null;
  overlay: IndexFileStatus | null;
}

async function fileStatus(file: string, now: Date, counts = true): Promise<IndexFileStatus> {
  const info = await stat(file);
  const fromName = SHARED.exec(path.basename(file))?.[1] ?? null;
  const base: IndexFileStatus = {
    path: file,
    date: fromName,
    ageDays: null,
    bytes: info.size,
    packages: 0,
    versions: 0,
    hashes: 0,
    strings: 0,
    schemaVersion: 0,
    builderVersion: null,
    error: null,
  };
  try {
    const index = FingerprintIndex.open(file);
    try {
      // Counting rows scans the whole index; `detect` only needs the age.
      const rows = counts ? index.counts() : { packages: index.packages.size };
      const date = index.meta.corpusDate ?? fromName;
      return {
        ...base,
        ...rows,
        date,
        schemaVersion: index.meta.schemaVersion,
        builderVersion: index.meta.builderVersion,
        ageDays: ageDays(date ?? info.mtime.toISOString(), now),
      };
    } finally {
      index.close();
    }
  } catch (error) {
    return {
      ...base,
      error: (error as Error).message,
      ageDays: fromName ? ageDays(fromName, now) : null,
    };
  }
}

function ageDays(date: string, now: Date): number | null {
  const at = Date.parse(date);
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

export async function indexStatus(
  dir = fingerprintDir(),
  now = new Date(),
  options: { counts?: boolean } = {},
): Promise<IndexStatus> {
  const shared = await findSharedIndex(dir);
  const overlay = path.join(dir, OVERLAY_FILE);
  const hasOverlay = await stat(overlay).then(
    () => true,
    () => false,
  );
  return {
    dir,
    shared: shared ? await fileStatus(shared, now, options.counts ?? true) : null,
    overlay: hasOverlay ? await fileStatus(overlay, now, options.counts ?? true) : null,
  };
}

export interface OpenedIndexes {
  indexes: FingerprintIndex[];
  /** Missing, stale or unreadable index; each says what to run. */
  warnings: string[];
  /** The shared index's corpus date, when one opened. */
  date: string | null;
}

/** Open the shared index and the local overlay, whichever exist and are usable. */
export async function openIndexes(
  dir = fingerprintDir(),
  now = new Date(),
): Promise<OpenedIndexes> {
  const status = await indexStatus(dir, now, { counts: false });
  const indexes: FingerprintIndex[] = [];
  const warnings: string[] = [];
  if (!status.shared) {
    warnings.push(
      'No fingerprint index; packages without other signals may be missed. Run "s2s db pull".',
    );
  } else if (status.shared.error) {
    warnings.push(`Fingerprint index unusable (${status.shared.error}). Run "s2s db pull".`);
  } else {
    indexes.push(FingerprintIndex.open(status.shared.path));
    if ((status.shared.ageDays ?? 0) > STALE_DAYS)
      warnings.push(
        `Fingerprint index is ${status.shared.ageDays} days old. Run "s2s db pull" for newer packages.`,
      );
  }
  if (status.overlay?.error)
    warnings.push(`Local fingerprint overlay unusable: ${status.overlay.error}`);
  else if (status.overlay) indexes.push(FingerprintIndex.open(status.overlay.path));
  return { indexes, warnings, date: status.shared?.error ? null : (status.shared?.date ?? null) };
}

export interface PullOptions {
  dir?: string;
  repo?: string;
  /** A specific release tag; defaults to the newest `fingerprints-*` release. */
  tag?: string;
  fetch?: PullFetch;
  signal?: AbortSignal;
  onProgress?: (event: PullProgress) => void;
}

export type PullProgress =
  | { kind: "release"; tag: string; bytes: number }
  | { kind: "verified"; sha256: string }
  | { kind: "installed"; path: string };

export interface PullResult {
  tag: string;
  path: string;
  /** Size of the compressed download. */
  bytes: number;
  sha256: string;
  /** False when the newest release was already installed. */
  downloaded: boolean;
}

interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}
interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export class PullError extends Error {
  override name = "PullError";
}

/**
 * Download the shared index from the newest `fingerprints-YYYY-MM-DD` GitHub release, check it
 * against the release's SHA-256 file, decompress it (zstd) and swap it in. Older shared indexes
 * are removed; the local overlay is left alone.
 */
export async function pullIndex(options: PullOptions = {}): Promise<PullResult> {
  const dir = options.dir ?? fingerprintDir();
  const repo = options.repo ?? FINGERPRINT_REPO;
  const doFetch: PullFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const init = options.signal ? { signal: options.signal } : {};
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "s2s",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await doFetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    ...init,
    headers,
  });
  if (!res.ok) throw new PullError(`GitHub returned ${res.status} listing releases of ${repo}.`);
  const releases = ((await res.json()) as Release[])
    .filter((r) => !r.draft && r.tag_name.startsWith(TAG_PREFIX))
    .filter((r) => (options.tag ? r.tag_name === options.tag : !r.prerelease))
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name));
  const release = releases[0];
  if (!release)
    throw new PullError(
      options.tag
        ? `No release ${options.tag} in ${repo}.`
        : `No fingerprint release in ${repo} yet.`,
    );
  const asset = release.assets.find((a) => a.name.endsWith(".sqlite.zst"));
  const sum = release.assets.find((a) => a.name.endsWith(".sha256"));
  if (!asset || !sum)
    throw new PullError(`${release.tag_name} has no .sqlite.zst and .sha256 assets.`);

  const date = release.tag_name.slice(TAG_PREFIX.length);
  const target = path.join(dir, `fingerprints-${date}.sqlite`);
  options.onProgress?.({ kind: "release", tag: release.tag_name, bytes: asset.size });

  const sumRes = await doFetch(sum.browser_download_url, init);
  if (!sumRes.ok) throw new PullError(`Downloading ${sum.name} failed with ${sumRes.status}.`);
  const expected = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new PullError(`${sum.name} holds no SHA-256.`);

  await mkdir(dir, { recursive: true });
  const existing = await stat(target).then(
    () => true,
    () => false,
  );
  if (existing) {
    try {
      FingerprintIndex.open(target).close();
      return {
        tag: release.tag_name,
        path: target,
        bytes: asset.size,
        sha256: expected,
        downloaded: false,
      };
    } catch {
      // Unusable: download it again.
    }
  }

  const compressed = `${target}.zst.part`;
  const partial = `${target}.part`;
  try {
    const download = await doFetch(asset.browser_download_url, init);
    if (!download.ok || !download.body)
      throw new PullError(`Downloading ${asset.name} failed with ${download.status}.`);
    const hash = createHash("sha256");
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(download.body as import("node:stream/web").ReadableStream),
      tap,
      createWriteStream(compressed),
      options.signal ? { signal: options.signal } : {},
    );
    const actual = hash.digest("hex");
    if (actual !== expected)
      throw new PullError(
        `Checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}.`,
      );
    options.onProgress?.({ kind: "verified", sha256: actual });
    await pipeline(
      createReadStream(compressed),
      createZstdDecompress(),
      createWriteStream(partial),
    );
    try {
      FingerprintIndex.open(partial).close();
    } catch (error) {
      throw new PullError(`The downloaded index is unusable: ${(error as Error).message}`);
    }
    await rename(partial, target);
  } finally {
    await rm(compressed, { force: true });
    await rm(partial, { force: true });
  }
  for (const name of await readdir(dir))
    if (SHARED.test(name) && path.join(dir, name) !== target)
      await rm(path.join(dir, name), { force: true });
  options.onProgress?.({ kind: "installed", path: target });
  return {
    tag: release.tag_name,
    path: target,
    bytes: asset.size,
    sha256: expected,
    downloaded: true,
  };
}
