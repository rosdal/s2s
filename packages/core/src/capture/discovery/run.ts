import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import type { APIRequestContext } from "playwright-core";
import type { BodyStore } from "../body-store.js";
import { classifyOrigin, isFirstParty } from "../origin.js";
import { assetKind, type CapturedAsset, mimeOf } from "../recorder.js";
import type { RequestLog } from "../request-log.js";
import { resourceKey } from "../url.js";
import { type ChunkRef, type RefSource, readLicenseRef, readRefs } from "./readers.js";

export interface DiscoveryEntry {
  url: string;
  source: RefSource;
  from: string;
  round: number;
  status: "fetched" | "already-captured" | "failed" | "capped";
  /** URLs tried, in order, when the reference was ambiguous or failed. */
  tried?: string[];
  hash?: string;
}

export interface MapEntry {
  /** The JS or CSS file the map belongs to. */
  file: string;
  mapUrl: string | null;
  via: "header" | "comment" | "inline" | "probe";
  hash: string;
  size: number;
}

/**
 * After this many blind `<file>.map` probes on one origin miss without a single hit, stop
 * probing that origin blindly. Maps named by a comment or header are still fetched. Sites that
 * ship unreferenced maps almost always ship them for every file, so the first probes find them.
 */
export const BLIND_PROBE_GIVE_UP = 25;

/** A `sourceMappingURL` comment in JS (`//#`) or CSS (`/*#`); group 1 is the URL. */
export const SOURCE_MAPPING_URL = /[#@]\s*sourceMappingURL\s*=\s*([^\s'"*]+)/g;

export interface DiscoveryLimits {
  maxRounds: number;
  maxFiles: number;
  concurrency: number;
}

export interface Fetched {
  url: string;
  status: number;
  hash: string | null;
  body: Buffer | null;
  headers: Record<string, string>;
}

/**
 * Finds and fetches chunks the page never loaded, then probes for source maps. State is kept
 * across calls, so it can run once per viewport and only scan what is new.
 */
export class Discovery {
  readonly #request: () => APIRequestContext;
  readonly #store: BodyStore;
  readonly #log: RequestLog;
  readonly #target: URL;
  readonly #limits: DiscoveryLimits;
  readonly #mapsDir: string;
  readonly #seen: Set<string>;
  readonly #scanned = new Set<string>();
  readonly #probed = new Set<string>();
  readonly #entries = new Map<string, DiscoveryEntry>();
  readonly #blindProbes = new Map<string, { hits: number; misses: number }>();
  readonly maps: MapEntry[] = [];
  /** Blind `.map` probes not sent because the origin had already missed too often. */
  blindProbesSkipped = 0;
  rounds = 0;
  fetchedCount = 0;
  capped = false;
  onFetch: (() => void) | undefined;

  constructor(deps: {
    request: () => APIRequestContext;
    store: BodyStore;
    log: RequestLog;
    target: URL;
    limits: DiscoveryLimits;
    mapsDir: string;
    /** URLs the browser already requested; shared with the recorder. */
    seen: Set<string>;
  }) {
    this.#request = deps.request;
    this.#store = deps.store;
    this.#log = deps.log;
    this.#target = deps.target;
    this.#limits = deps.limits;
    this.#mapsDir = deps.mapsDir;
    this.#seen = deps.seen;
  }

  get entries(): DiscoveryEntry[] {
    return [...this.#entries.values()];
  }

  #known(url: string): boolean {
    // Request URLs never carry a fragment, so the seen set needs no normalizing.
    return this.#seen.has(resourceKey(url));
  }

  async #fetch(
    url: string,
    phase: "discover",
    initiator: { type: "discovery" | "map-probe"; url: string },
    signal?: AbortSignal,
  ): Promise<Fetched> {
    signal?.throwIfAborted();
    this.#seen.add(url);
    const startedAt = new Date();
    let status = 0;
    let headers: Record<string, string> = {};
    let body: Buffer | null = null;
    let failure: string | undefined;
    let requestHeaders: Record<string, string> = {};
    try {
      const response = await this.#request().get(url, {
        timeout: 30_000,
        maxRedirects: 5,
        failOnStatusCode: false,
        headers: { referer: initiator.url },
      });
      status = response.status();
      headers = response.headers();
      requestHeaders = { referer: initiator.url };
      if (response.ok()) body = await response.body();
    } catch (error) {
      failure = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
    const mimeType = mimeOf(headers);
    const stored = body ? await this.#store.put(body) : undefined;
    this.#log.append({
      id: this.#log.nextId(),
      page: null,
      viewport: null,
      phase,
      method: "GET",
      url,
      resourceType: initiator.type === "map-probe" ? "sourcemap" : "discovery",
      status,
      requestHeaders,
      responseHeaders: headers,
      mimeType,
      size: body?.byteLength ?? null,
      bodyHash: stored?.hash ?? null,
      initiator,
      timing: { startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime() },
      origin: classifyOrigin({ url, mimeType, resourceType: "other" }, this.#target),
      ...(failure ? { failure } : {}),
    });
    this.onFetch?.();
    return { url, status, hash: stored?.hash ?? null, body, headers };
  }

  /**
   * Scan the given assets and HTML documents for chunk references, fetch what is new and rescan
   * what comes back, until a round finds nothing or a cap is hit. Returns the newly fetched assets.
   */
  async run(
    assets: CapturedAsset[],
    documents: { url: string; html: string }[],
    readBody: (hash: string) => Promise<Buffer>,
    signal?: AbortSignal,
  ): Promise<CapturedAsset[]> {
    const limit = pLimit(this.#limits.concurrency);
    const found: CapturedAsset[] = [];
    let queue: { url: string; kind: "js" | "css" | "html"; text: () => Promise<string> }[] = [
      ...documents.map((doc) => ({
        url: doc.url,
        kind: "html" as const,
        text: async () => doc.html,
      })),
      ...assets.map((asset) => ({
        url: asset.url,
        kind: asset.kind,
        text: async () => (await readBody(asset.hash)).toString("utf8"),
      })),
    ].filter((item) => {
      const key = `${item.kind}:${item.url}`;
      if (this.#scanned.has(key)) return false;
      this.#scanned.add(key);
      return true;
    });

    // The round cap applies per call, so each viewport gets its own budget.
    let roundsThisRun = 0;
    while (queue.length > 0) {
      signal?.throwIfAborted();
      if (roundsThisRun >= this.#limits.maxRounds) {
        this.capped = true;
        break;
      }
      roundsThisRun++;
      this.rounds++;
      const round = this.rounds;
      const refs: ChunkRef[] = [];
      const licenses: { url: string; from: string }[] = [];
      for (const item of queue) {
        const text = await item.text().catch(() => "");
        try {
          refs.push(...readRefs(item.kind, text, item.url));
          const license = item.kind === "js" ? readLicenseRef(text, item.url) : undefined;
          if (license) licenses.push({ url: license, from: item.url });
        } catch {
          // One unreadable file must not sink discovery for the rest.
        }
      }
      await this.#fetchLicenses(licenses, round, signal);

      const toFetch: ChunkRef[] = [];
      for (const ref of refs) {
        const candidates = ref.candidates.filter(
          (c) => URL.canParse(c) && isFirstParty(new URL(c), this.#target),
        );
        const first = candidates[0];
        if (!first) continue;
        const key = resourceKey(first);
        if (this.#entries.has(key)) continue;
        const known = candidates.find((c) => this.#known(c));
        if (known) {
          this.#entries.set(key, {
            url: known,
            source: ref.source,
            from: ref.from,
            round,
            status: "already-captured",
          });
          continue;
        }
        const entry: DiscoveryEntry = {
          url: first,
          source: ref.source,
          from: ref.from,
          round,
          status: "capped",
        };
        this.#entries.set(key, entry);
        if (this.fetchedCount + toFetch.length >= this.#limits.maxFiles) {
          this.capped = true;
          continue;
        }
        toFetch.push({ ...ref, candidates });
      }

      const next: typeof queue = [];
      await Promise.all(
        toFetch.map((ref) =>
          limit(async () => {
            const entry = this.#entries.get(resourceKey(ref.candidates[0] ?? ""));
            if (!entry) return;
            const tried: string[] = [];
            for (const candidate of ref.candidates) {
              if (signal?.aborted) return;
              if (this.#known(candidate) && candidate !== ref.candidates[0]) continue;
              tried.push(candidate);
              const result = await this.#fetch(
                candidate,
                "discover",
                { type: "discovery", url: ref.from },
                signal,
              );
              const kind = assetKind(mimeOf(result.headers), candidate);
              // Servers with an SPA fallback answer 200 with HTML for any path.
              if (
                result.status >= 200 &&
                result.status < 300 &&
                result.hash &&
                result.body &&
                kind &&
                kind !== "html"
              ) {
                entry.url = candidate;
                entry.status = "fetched";
                entry.hash = result.hash;
                this.fetchedCount++;
                const asset: CapturedAsset = {
                  url: candidate,
                  hash: result.hash,
                  kind,
                  headers: result.headers,
                };
                found.push(asset);
                const body = result.body;
                this.#scanned.add(`${kind}:${candidate}`);
                next.push({ url: candidate, kind, text: async () => body.toString("utf8") });
                break;
              }
            }
            if (entry.status !== "fetched") entry.status = "failed";
            if (tried.length > 1 || entry.status === "failed") entry.tried = tried;
          }),
        ),
      );
      queue = next;
    }
    return found;
  }

  /**
   * Fetch the `*.LICENSE.txt` files webpack bundles point at. Terser moves the license banners
   * there, so they carry the package names and versions Stage 3 reads. They are logged and stored
   * like any discovery fetch, but never scanned for chunk references.
   */
  async #fetchLicenses(
    licenses: { url: string; from: string }[],
    round: number,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const { url, from } of licenses) {
      signal?.throwIfAborted();
      if (!URL.canParse(url) || !isFirstParty(new URL(url), this.#target)) continue;
      const key = resourceKey(url);
      if (this.#entries.has(key) || this.#known(url)) continue;
      const entry: DiscoveryEntry = { url, source: "license", from, round, status: "failed" };
      this.#entries.set(key, entry);
      const result = await this.#fetch(url, "discover", { type: "discovery", url: from }, signal);
      const html = mimeOf(result.headers)?.includes("html") ?? false;
      if (result.status >= 200 && result.status < 300 && result.hash && !html) {
        entry.status = "fetched";
        entry.hash = result.hash;
      }
    }
  }

  /**
   * Fetch source maps for first-party JS and CSS: the `SourceMap` header, the
   * `sourceMappingURL` comment (inline `data:` maps included), or else a blind `<file>.map` probe.
   */
  async probeMaps(
    assets: CapturedAsset[],
    readBody: (hash: string) => Promise<Buffer>,
    signal?: AbortSignal,
  ): Promise<void> {
    const limit = pLimit(this.#limits.concurrency);
    await mkdir(this.#mapsDir, { recursive: true });
    await Promise.all(
      assets.map((asset) =>
        limit(async () => {
          if (signal?.aborted || this.#probed.has(asset.url)) return;
          this.#probed.add(asset.url);
          try {
            await this.#probeOne(asset, readBody, signal);
          } catch (error) {
            if (signal?.aborted) throw error;
            // A malformed sourceMappingURL or header skips this file only.
          }
        }),
      ),
    );
  }

  async #probeOne(
    asset: CapturedAsset,
    readBody: (hash: string) => Promise<Buffer>,
    signal?: AbortSignal,
  ): Promise<void> {
    const fileUrl = new URL(asset.url);
    if (!isFirstParty(fileUrl, this.#target)) return;
    const text = (await readBody(asset.hash)).toString("utf8");
    const header = asset.headers.sourcemap ?? asset.headers["x-sourcemap"];
    const comment = [...text.matchAll(SOURCE_MAPPING_URL)].at(-1)?.[1];

    if (!header && comment?.startsWith("data:")) {
      const inline = decodeDataUrl(comment);
      if (inline) await this.#saveMap(asset.url, null, "inline", inline);
      return;
    }
    let mapUrl: string;
    let via: MapEntry["via"];
    if (header) {
      mapUrl = new URL(header, fileUrl).href;
      via = "header";
    } else if (comment) {
      mapUrl = new URL(comment, fileUrl).href;
      via = "comment";
    } else {
      const bare = new URL(fileUrl);
      bare.search = "";
      bare.hash = "";
      mapUrl = `${bare.href}.map`;
      via = "probe";
    }
    if (!isFirstParty(new URL(mapUrl), this.#target)) return;
    const blind = this.#blindProbes.get(fileUrl.origin) ?? { hits: 0, misses: 0 };
    this.#blindProbes.set(fileUrl.origin, blind);
    if (via === "probe" && blind.hits === 0 && blind.misses >= BLIND_PROBE_GIVE_UP) {
      this.blindProbesSkipped++;
      return;
    }
    const result = await this.#fetch(
      mapUrl,
      "discover",
      { type: "map-probe", url: asset.url },
      signal,
    );
    const hit =
      result.body !== null &&
      result.status >= 200 &&
      result.status < 300 &&
      looksLikeMap(result.body);
    if (via === "probe") {
      if (hit) blind.hits++;
      else blind.misses++;
    }
    if (hit && result.body) await this.#saveMap(asset.url, mapUrl, via, result.body);
  }

  async #saveMap(
    file: string,
    mapUrl: string | null,
    via: MapEntry["via"],
    body: Buffer,
  ): Promise<void> {
    const { hash } = await this.#store.put(body);
    await copyFile(this.#store.path(hash), path.join(this.#mapsDir, `${hash}.map`));
    this.maps.push({ file, mapUrl, via, hash, size: body.byteLength });
  }
}

function looksLikeMap(body: Buffer): boolean {
  const head = body
    .subarray(0, 512)
    .toString("utf8")
    .replace(/^\)\]\}'?\s*/, "")
    .trimStart();
  return (
    head.startsWith("{") &&
    /"(?:mappings|sections)"/.test(body.toString("utf8", 0, Math.min(body.byteLength, 1 << 20)))
  );
}

/** Decode a `data:` URL (base64 or percent-encoded) to bytes; `undefined` when malformed. */
export function decodeDataUrl(url: string): Buffer | undefined {
  const match = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (!match) return undefined;
  try {
    return match[1]
      ? Buffer.from(match[2] ?? "", "base64")
      : Buffer.from(decodeURIComponent(match[2] ?? ""));
  } catch {
    return undefined;
  }
}
