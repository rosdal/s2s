import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class TarballError extends Error {
  override name = "TarballError";
}

/** Check bytes against an SRI string (`sha512-…`, or several separated by spaces). */
export function checkIntegrity(bytes: Uint8Array, integrity: string): boolean {
  for (const entry of integrity.trim().split(/\s+/)) {
    const dash = entry.indexOf("-");
    const algorithm = entry.slice(0, dash);
    if (!["sha512", "sha384", "sha256", "sha1"].includes(algorithm)) continue;
    if (createHash(algorithm).update(bytes).digest("base64") === entry.slice(dash + 1)) return true;
  }
  return false;
}

/**
 * The registry tarball for `name@version`, from the cache or the network, verified against its
 * integrity before it is used or stored. Nothing is installed and no scripts run.
 */
export async function fetchTarball(options: {
  name: string;
  version: string;
  url: string;
  integrity: string;
  cacheDir: string;
  fetch?: Fetch;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  const file = path.join(
    options.cacheDir,
    "tarballs",
    `${options.name.replace("/", "+")}-${options.version}.tgz`,
  );
  const cached = await readFile(file).catch(() => undefined);
  if (cached && checkIntegrity(cached, options.integrity)) return cached;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const res = await doFetch(options.url, options.signal ? { signal: options.signal } : {});
  if (!res.ok) throw new TarballError(`GET ${options.url} returned ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!checkIntegrity(bytes, options.integrity))
    throw new TarballError(`${options.name}@${options.version}: tarball fails its integrity check`);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
  return bytes;
}

/**
 * Unpack a gzipped tarball into `dir`, dropping the first path component (`package/`). Only
 * regular files are written; links, devices and any path that would land outside `dir` are
 * skipped.
 */
export async function unpackTarball(tgz: Uint8Array, dir: string): Promise<number> {
  const tar = gunzipSync(tgz);
  const root = path.resolve(dir);
  let written = 0;
  let longName: string | undefined;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x") {
      // A pax header: `<len> path=<value>\n` records.
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (match) longName = match[1];
      continue;
    }
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "g") continue;
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    if (type !== "0" && type !== "7") continue;
    const relative = name.replace(/\\/g, "/").split("/").slice(1).join("/");
    if (!relative) continue;
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    written++;
  }
  return written;
}
