import { readFile } from "node:fs/promises";
import path from "node:path";
import { assetKind } from "../capture/recorder.js";
import { type OriginClass, type RequestRecord, readRequestLog } from "../capture/request-log.js";
import type { WorkspacePaths } from "../capture/workspace.js";

export interface DetectAsset {
  hash: string;
  kind: "js" | "css";
  /** Every URL that served this body; the first is the one reported. */
  urls: string[];
  origin: OriginClass;
  size: number;
  pages: string[];
  /** The `Last-Modified` response header, when one was sent. */
  lastModified: string | null;
}

export interface LicenseFile {
  url: string;
  hash: string;
  pages: string[];
  lastModified: string | null;
}

/** What the collectors read from a workspace, loaded once. */
export interface DetectContext {
  paths: WorkspacePaths;
  records: RequestRecord[];
  /** JS and CSS bodies from the site and from CDN libraries; analytics and ads are left out. */
  assets: DetectAsset[];
  licenseFiles: LicenseFile[];
  /** Body text by hash, read lazily and kept. */
  text(hash: string): Promise<string | undefined>;
  readJson<T>(file: string): Promise<T | undefined>;
}

/** Origins whose code can be the site's own build or a library it loads on purpose. */
const SCANNED_ORIGINS = new Set<OriginClass>(["first-party", "cdn-library"]);

export async function loadContext(paths: WorkspacePaths): Promise<DetectContext> {
  const records = await readRequestLog(paths.requests).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [] as RequestRecord[];
    throw e;
  });
  const assets = new Map<string, DetectAsset>();
  const licenses = new Map<string, LicenseFile>();
  for (const record of records) {
    if (!record.bodyHash || record.status < 200 || record.status >= 300) continue;
    const lastModified = record.responseHeaders["last-modified"] ?? null;
    if (/\.LICENSE\.txt(?:\?|$)/.test(record.url)) {
      const known = licenses.get(record.url);
      if (!known)
        licenses.set(record.url, {
          url: record.url,
          hash: record.bodyHash,
          pages: record.page ? [record.page] : [],
          lastModified,
        });
      else if (record.page && !known.pages.includes(record.page)) known.pages.push(record.page);
      continue;
    }
    const kind = assetKind(record.mimeType, record.url);
    if ((kind !== "js" && kind !== "css") || !SCANNED_ORIGINS.has(record.origin)) continue;
    const asset = assets.get(record.bodyHash) ?? {
      hash: record.bodyHash,
      kind,
      urls: [],
      origin: record.origin,
      size: record.size ?? 0,
      pages: [],
      lastModified,
    };
    assets.set(record.bodyHash, asset);
    if (!asset.urls.includes(record.url)) asset.urls.push(record.url);
    if (record.page && !asset.pages.includes(record.page)) asset.pages.push(record.page);
    asset.lastModified ??= lastModified;
  }

  const texts = new Map<string, Promise<string | undefined>>();
  return {
    paths,
    records,
    assets: [...assets.values()].sort((a, b) => (a.urls[0] ?? "").localeCompare(b.urls[0] ?? "")),
    licenseFiles: [...licenses.values()].sort((a, b) => a.url.localeCompare(b.url)),
    text(hash) {
      let known = texts.get(hash);
      if (!known) {
        known = readFile(path.join(paths.bodies, hash), "utf8").catch(() => undefined);
        texts.set(hash, known);
      }
      return known;
    },
    async readJson<T>(file: string): Promise<T | undefined> {
      try {
        return JSON.parse(await readFile(file, "utf8")) as T;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}
