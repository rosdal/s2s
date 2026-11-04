import type { RequestRecord } from "../capture/request-log.js";

export interface ReplayEntry {
  status: number;
  headers: Record<string, string>;
  bodyHash: string;
}

const DROP_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "strict-transport-security",
  "content-security-policy",
  "alt-svc",
]);

const stripHash = (url: string) => url.replace(/#.*$/, "");

/**
 * Captured responses `s2s verify` may serve again. The site's own scripts are left out: the
 * rebuilt project replaces them, and serving the originals would hide a broken build. So are
 * analytics and ads. Everything else the capture got a body for (API responses, stylesheets,
 * fonts, images, CDN libraries) is replayed; requests for anything not here are blocked.
 */
export class ReplayIndex {
  readonly #byUrl = new Map<string, ReplayEntry>();
  readonly #byPath = new Map<string, ReplayEntry>();
  /** Paths and URLs that failed in the capture too, so failing again is not a regression. */
  readonly #failed = new Set<string>();
  readonly #firstPartyOrigins = new Set<string>();

  constructor(records: RequestRecord[], targetUrl: string) {
    this.#firstPartyOrigins.add(new URL(targetUrl).origin);
    for (const r of records) {
      if (r.origin === "first-party") {
        try {
          this.#firstPartyOrigins.add(new URL(r.url).origin);
        } catch {
          // Not a URL; skip it.
        }
      }
    }
    for (const r of records) {
      let url: URL;
      try {
        url = new URL(stripHash(r.url));
      } catch {
        continue;
      }
      const pathKey = url.pathname + url.search;
      if (r.status === 0 || r.status >= 400) {
        this.#failed.add(url.href);
        if (this.#firstPartyOrigins.has(url.origin)) this.#failed.add(pathKey);
        continue;
      }
      if (r.method !== "GET" || !r.bodyHash || r.status < 200 || r.status >= 300) continue;
      if (r.origin === "analytics-ads") continue;
      if (r.resourceType === "document") continue;
      if (r.origin === "first-party" && isScript(r)) continue;
      const entry: ReplayEntry = {
        status: r.status,
        headers: Object.fromEntries(
          Object.entries(r.responseHeaders).filter(([k]) => !DROP_HEADERS.has(k.toLowerCase())),
        ),
        bodyHash: r.bodyHash,
      };
      if (!this.#byUrl.has(url.href)) this.#byUrl.set(url.href, entry);
      if (this.#firstPartyOrigins.has(url.origin) && !this.#byPath.has(pathKey))
        this.#byPath.set(pathKey, entry);
    }
  }

  /** A captured response for a request the rebuilt site makes. */
  lookup(requestUrl: string, localOrigin: string): ReplayEntry | undefined {
    const url = new URL(stripHash(requestUrl));
    if (url.origin === localOrigin) return this.#byPath.get(url.pathname + url.search);
    return this.#byUrl.get(url.href);
  }

  /** Whether the capture saw this request fail as well. */
  failedInCapture(requestUrl: string, localOrigin: string): boolean {
    const url = new URL(stripHash(requestUrl));
    if (url.origin === localOrigin) return this.#failed.has(url.pathname + url.search);
    return this.#failed.has(url.href);
  }

  get size(): number {
    return this.#byUrl.size;
  }
}

function isScript(r: RequestRecord): boolean {
  if (r.resourceType === "script") return true;
  const mime = r.mimeType ?? "";
  return /javascript|ecmascript/.test(mime) || /\.m?js(?:$|\?)/.test(r.url);
}
