import type { BrowserContext, Request } from "playwright-core";
import type { BodyStore } from "./body-store.js";
import { classifyOrigin } from "./origin.js";
import type { Phase, RequestLog } from "./request-log.js";

export interface RecordTag {
  page: string | null;
  viewport: string | null;
  phase: Phase;
}

/** A JS, CSS or HTML body the capture holds, for chunk discovery and map probing. */
export interface CapturedAsset {
  url: string;
  hash: string;
  kind: "js" | "css" | "html";
  headers: Record<string, string>;
}

export function assetKind(mimeType: string | null, url: string): CapturedAsset["kind"] | undefined {
  const mime = mimeType ?? "";
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  if (mime.includes("javascript") || mime.includes("ecmascript") || /\.m?js$/i.test(path)) {
    return mime.includes("html") ? undefined : "js";
  }
  if (mime.startsWith("text/css") || /\.css$/i.test(path))
    return mime.includes("html") ? undefined : "css";
  if (mime.startsWith("text/html")) return "html";
  return undefined;
}

export function mimeOf(headers: Record<string, string>): string | null {
  return headers["content-type"]?.split(";")[0]?.trim().toLowerCase() || null;
}

const LONG_LIVED = new Set(["eventsource", "websocket"]);

/**
 * Records every request a browser context makes into the request log and body store, and tracks
 * in-flight requests so callers can wait for the network to go quiet.
 */
export class Recorder {
  readonly #store: BodyStore;
  readonly #log: RequestLog;
  readonly #target: URL;
  readonly #maxBodyBytes: number;
  readonly #inflight = new Map<Request, number>();
  readonly #tags = new WeakMap<Request, RecordTag>();
  readonly #pending = new Set<Promise<void>>();
  #lastActivity = Date.now();

  tag: RecordTag = { page: null, viewport: null, phase: "load" };
  /** Every URL the browser requested, whatever the outcome. */
  readonly seen = new Set<string>();
  readonly assets: CapturedAsset[] = [];
  failed = 0;
  onRecord: (() => void) | undefined;

  constructor(deps: { store: BodyStore; log: RequestLog; target: URL; maxBodyBytes: number }) {
    this.#store = deps.store;
    this.#log = deps.log;
    this.#target = deps.target;
    this.#maxBodyBytes = deps.maxBodyBytes;
  }

  attach(context: BrowserContext): void {
    context.on("request", (request) => {
      if (request.url().startsWith("data:")) return;
      this.#inflight.set(request, Date.now());
      this.#tags.set(request, { ...this.tag });
      this.#lastActivity = Date.now();
    });
    context.on("requestfinished", (request) => this.#track(this.#record(request, undefined)));
    context.on("requestfailed", (request) =>
      this.#track(this.#record(request, request.failure()?.errorText ?? "failed")),
    );
  }

  #track(promise: Promise<void>): void {
    this.#pending.add(promise);
    void promise.finally(() => this.#pending.delete(promise));
  }

  /** Wait until every response seen so far has been written. */
  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  /** Requests still open, ignoring streams and anything open longer than `staleMs`. */
  activeRequests(staleMs: number): number {
    const now = Date.now();
    let count = 0;
    for (const [request, started] of this.#inflight) {
      if (LONG_LIVED.has(request.resourceType())) continue;
      if (now - started > staleMs) continue;
      count++;
    }
    return count;
  }

  get lastActivity(): number {
    return this.#lastActivity;
  }

  async #record(request: Request, failure: string | undefined): Promise<void> {
    const url = request.url();
    if (url.startsWith("data:")) return;
    const startedAtMs = this.#inflight.get(request) ?? Date.now();
    this.#inflight.delete(request);
    this.#lastActivity = Date.now();
    const tag = this.#tags.get(request) ?? this.tag;
    try {
      const response = failure ? null : await request.response();
      const status = response?.status() ?? 0;
      const requestHeaders = await request.allHeaders().catch(() => request.headers());
      const responseHeaders = response
        ? await response.allHeaders().catch(() => response.headers())
        : {};
      const mimeType = mimeOf(responseHeaders);
      const redirectedTo = request.redirectedTo()?.url();

      let bodyHash: string | null = null;
      let size: number | null = null;
      let note = failure;
      if (response && !redirectedTo && status !== 204 && status !== 304) {
        let body = await response.body().catch(() => undefined);
        if (body?.byteLength === 0 && expectsBody(request.method(), responseHeaders)) {
          // Chromium hands Playwright an empty body when the page read the response with
          // `.blob()` (three.js's ImageBitmapLoader does). Ask for the URL again instead of
          // storing a body that can't be the real one.
          body = await this.#refetch(request, requestHeaders);
          note = body
            ? note
            : "body not stored: the browser returned an empty body and fetching it again failed";
        }
        if (body) {
          size = body.byteLength;
          if (body.byteLength > this.#maxBodyBytes) {
            note = `body not stored: ${body.byteLength} bytes is over the size cap`;
          } else {
            bodyHash = (await this.#store.put(body)).hash;
          }
        }
      }
      if (failure || status >= 400) this.failed++;
      // Requests that never got a response (aborted, network error) stay fetchable by discovery.
      if (status > 0) this.seen.add(url);

      const timing = request.timing();
      const durationMs = timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null;
      const resourceType = request.resourceType();
      const frameUrl = (() => {
        try {
          return request.frame().url();
        } catch {
          return null;
        }
      })();
      this.#log.append({
        id: this.#log.nextId(),
        page: tag.page,
        viewport: tag.viewport,
        phase: tag.phase,
        method: request.method(),
        url,
        resourceType,
        status,
        requestHeaders,
        responseHeaders,
        mimeType,
        size,
        bodyHash,
        initiator: { type: "page", url: requestHeaders.referer ?? frameUrl },
        timing: {
          startedAt: new Date(timing.startTime > 0 ? timing.startTime : startedAtMs).toISOString(),
          durationMs,
        },
        origin: classifyOrigin({ url, mimeType, resourceType }, this.#target),
        ...(redirectedTo ? { redirectedTo } : {}),
        ...(note ? { failure: note } : {}),
      });
      if (bodyHash && status >= 200 && status < 300) {
        const kind = assetKind(mimeType, url);
        if (kind && kind !== "html") {
          this.assets.push({ url, hash: bodyHash, kind, headers: responseHeaders });
        }
      }
      this.onRecord?.();
    } catch {
      // The context closed while this response was being read (Ctrl+C or page close).
    }
  }

  /** Fetch a request's URL again through its own browser context, or undefined on any failure. */
  async #refetch(request: Request, headers: Record<string, string>): Promise<Buffer | undefined> {
    const context = (() => {
      try {
        return request.frame().page()?.context();
      } catch {
        return undefined; // Service-worker requests have no frame.
      }
    })();
    if (!context) return undefined;
    try {
      const response = await context.request.get(request.url(), {
        headers: Object.fromEntries(
          Object.entries(headers).filter(([name]) => !name.startsWith(":") && !SKIP[name]),
        ),
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      if (!response.ok()) return undefined;
      const body = await response.body();
      return body.byteLength > 0 ? body : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Request headers the refetch leaves to Playwright: framing, and conditionals that yield a 304. */
const SKIP: Record<string, true> = {
  "content-length": true,
  connection: true,
  host: true,
  "if-modified-since": true,
  "if-none-match": true,
  range: true,
};

/** An empty body is only genuine on a GET whose response doesn't declare a non-zero length. */
export function expectsBody(method: string, headers: Record<string, string>): boolean {
  if (method !== "GET") return false;
  const length = headers["content-length"];
  return length === undefined || Number(length) > 0;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait until no request has started or finished for `quietMs`, counting from the later of the
 * last network activity and the call itself (so an action that triggers requests a frame later
 * still gets its full window), or until `deadline` (epoch ms). Returns false when the deadline hit
 * first.
 */
export async function waitForQuiet(
  recorder: Recorder,
  quietMs: number,
  deadline: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const staleMs = Math.max(quietMs * 5, 5_000);
  const since = Date.now();
  for (;;) {
    const now = Date.now();
    const idleFrom = Math.max(recorder.lastActivity, since);
    if (recorder.activeRequests(staleMs) === 0 && now - idleFrom >= quietMs) {
      return true;
    }
    if (now >= deadline) return false;
    await sleep(Math.min(100, Math.max(deadline - now, 1)), signal);
  }
}
