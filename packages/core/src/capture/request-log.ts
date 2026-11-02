import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const Phase = z.enum(["load", "interact", "discover", "crawl"]);
export type Phase = z.infer<typeof Phase>;

export const OriginClass = z.enum([
  "first-party",
  "cdn-library",
  "analytics-ads",
  "fonts",
  "media",
]);
export type OriginClass = z.infer<typeof OriginClass>;

export const RequestRecord = z.object({
  id: z.string(),
  /** Page slug the request belongs to; `null` for discovery fetches not tied to one page. */
  page: z.string().nullable(),
  viewport: z.string().nullable(),
  phase: Phase,
  method: z.string(),
  url: z.string(),
  resourceType: z.string(),
  /** HTTP status; 0 when the request failed before a response. */
  status: z.number().int(),
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()),
  mimeType: z.string().nullable(),
  /** Body size in bytes, or `null` when no body was stored. */
  size: z.number().int().nullable(),
  bodyHash: z.string().nullable(),
  initiator: z.object({
    /** `page`: made by the page itself; `discovery`/`map-probe`: fetched by s2s. */
    type: z.enum(["page", "discovery", "map-probe"]),
    /** The referring document or the file a chunk reference was found in. */
    url: z.string().nullable(),
  }),
  timing: z.object({
    startedAt: z.iso.datetime(),
    durationMs: z.number().nullable(),
  }),
  origin: OriginClass,
  redirectedTo: z.string().optional(),
  failure: z.string().optional(),
});
export type RequestRecord = z.infer<typeof RequestRecord>;

/** Append-only `requests.jsonl` writer. */
export class RequestLog {
  readonly #file: string;
  #stream: WriteStream | undefined;
  #nextId = 1;
  count = 0;

  constructor(file: string) {
    this.#file = file;
  }

  /** Open the log, truncating anything from an earlier run. */
  async open(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    this.#stream = createWriteStream(this.#file, { flags: "w" });
    await new Promise<void>((resolve, reject) => {
      this.#stream?.once("open", () => resolve());
      this.#stream?.once("error", reject);
    });
  }

  nextId(): string {
    return `r${this.#nextId++}`;
  }

  append(record: RequestRecord): void {
    if (!this.#stream) throw new Error("RequestLog is not open");
    this.#stream.write(`${JSON.stringify(record)}\n`);
    this.count++;
  }

  /** Flush pending writes and close the file. Safe to call twice. */
  async close(): Promise<void> {
    const stream = this.#stream;
    this.#stream = undefined;
    if (!stream) return;
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }
}

export async function readRequestLog(file: string): Promise<RequestRecord[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => RequestRecord.parse(JSON.parse(line)));
}
