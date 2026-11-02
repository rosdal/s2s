import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BodyStore } from "../src/capture/body-store.js";
import { newManifest, readManifest, writeManifest } from "../src/capture/manifest.js";
import { RequestLog, type RequestRecord, readRequestLog } from "../src/capture/request-log.js";
import { pageSlug, workspaceSlug } from "../src/capture/workspace.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "s2s-ws-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("workspaceSlug", () => {
  test("joins host and path, dropping www", () => {
    expect(workspaceSlug("https://www.shopify.com/editions/winter2026")).toBe(
      "shopify-com-editions-winter2026",
    );
  });
  test("root URL is just the host, with port when set", () => {
    expect(workspaceSlug("https://example.com/")).toBe("example-com");
    expect(workspaceSlug("http://127.0.0.1:5173/")).toBe("127-0-0-1-5173");
  });
  test("long slugs are capped with a hash suffix", () => {
    const slug = workspaceSlug(`https://example.com/${"a/".repeat(100)}`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).toMatch(/-[0-9a-f]{8}$/);
  });
});

describe("pageSlug", () => {
  test("root is index; paths are slugged", () => {
    expect(pageSlug("https://example.com/")).toBe("index");
    expect(pageSlug("https://example.com/docs/Getting-Started/")).toBe("docs-getting-started");
  });
  test("query strings keep pages apart", () => {
    const a = pageSlug("https://example.com/search?q=a");
    const b = pageSlug("https://example.com/search?q=b");
    expect(a).not.toBe(b);
    expect(a.startsWith("search-q")).toBe(true);
  });
});

describe("manifest", () => {
  test("round-trips and validates", async () => {
    const file = path.join(dir, "manifest.json");
    const manifest = newManifest({
      s2sVersion: "0.0.0",
      targetUrl: "https://example.com/",
      options: { depth: 0 },
    });
    manifest.stages.capture = { status: "complete", stats: { requests: 3 } };
    await writeManifest(file, manifest);
    const read = await readManifest(file);
    expect(read?.stages.capture.status).toBe("complete");
    expect(read?.schemaVersion).toBe(1);
    expect(await readdir(dir)).toEqual(["manifest.json"]);
  });
  test("missing file reads as undefined", async () => {
    expect(await readManifest(path.join(dir, "nope.json"))).toBeUndefined();
  });
  test("rejects an unknown schema version or status", async () => {
    const file = path.join(dir, "manifest.json");
    const manifest = newManifest({ s2sVersion: "0", targetUrl: "https://x.dev/", options: {} });
    await writeFile(file, JSON.stringify({ ...manifest, schemaVersion: 99 }));
    await expect(readManifest(file)).rejects.toThrow();
    await writeFile(
      file,
      JSON.stringify({ ...manifest, stages: { capture: { status: "done", stats: {} } } }),
    );
    await expect(readManifest(file)).rejects.toThrow();
  });
});

describe("BodyStore", () => {
  test("stores by sha256 and writes each body once", async () => {
    const store = new BodyStore(path.join(dir, "bodies"));
    const body = new TextEncoder().encode("console.log(1)");
    const first = await store.put(body);
    const second = await store.put(body);
    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.read(first.hash)).toString()).toBe("console.log(1)");
    // A fresh store over the same folder sees the existing file.
    const again = await new BodyStore(path.join(dir, "bodies")).put(body);
    expect(again.written).toBe(false);
    expect(await readdir(path.join(dir, "bodies"))).toEqual([first.hash]);
  });
});

describe("RequestLog", () => {
  test("writes one JSON line per record and truncates on reopen", async () => {
    const file = path.join(dir, "raw", "requests.jsonl");
    const record = (id: string): RequestRecord => ({
      id,
      page: "index",
      viewport: "desktop",
      phase: "load",
      method: "GET",
      url: "https://example.com/",
      resourceType: "document",
      status: 200,
      requestHeaders: {},
      responseHeaders: { "content-type": "text/html" },
      mimeType: "text/html",
      size: 10,
      bodyHash: "a".repeat(64),
      initiator: { type: "page", url: null },
      timing: { startedAt: new Date().toISOString(), durationMs: 5 },
      origin: "first-party",
    });
    const log = new RequestLog(file);
    await log.open();
    log.append(record(log.nextId()));
    log.append(record(log.nextId()));
    await log.close();
    expect((await readRequestLog(file)).map((r) => r.id)).toEqual(["r1", "r2"]);

    const again = new RequestLog(file);
    await again.open();
    again.append(record(again.nextId()));
    await again.close();
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
  });
});
