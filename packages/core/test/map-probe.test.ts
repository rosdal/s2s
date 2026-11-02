import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type APIRequestContext, request } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { BodyStore } from "../src/capture/body-store.js";
import { BLIND_PROBE_GIVE_UP, Discovery } from "../src/capture/discovery/run.js";
import type { CapturedAsset } from "../src/capture/recorder.js";
import { RequestLog } from "../src/capture/request-log.js";

let dir: string;
let server: Server;
let base: string;
let api: APIRequestContext;
const hits: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "s2s-maps-"));
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/linked.js.map") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"version":3,"sources":[],"mappings":""}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api = await request.newContext();
});
afterAll(async () => {
  await api.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test("blind .map probing stops after repeated misses but still follows sourceMappingURL", async () => {
  const store = new BodyStore(path.join(dir, "bodies"));
  const log = new RequestLog(path.join(dir, "requests.jsonl"));
  await log.open();
  const plain = await store.put(Buffer.from("console.log(1)"));
  const linked = await store.put(Buffer.from("x()\n//# sourceMappingURL=linked.js.map"));
  const assets: CapturedAsset[] = Array.from({ length: 60 }, (_, i) => ({
    url: `${base}/chunk-${i}.js`,
    hash: plain.hash,
    kind: "js",
    headers: {},
  }));
  assets.push({ url: `${base}/linked.js`, hash: linked.hash, kind: "js", headers: {} });

  const discovery = new Discovery({
    request: () => api,
    store,
    log,
    target: new URL(base),
    limits: { maxRounds: 5, maxFiles: 100, concurrency: 1 },
    mapsDir: path.join(dir, "maps"),
    seen: new Set(),
  });
  await discovery.probeMaps(assets, (hash) => store.read(hash));
  await log.close();

  const blindProbes = hits.filter((url) => url.startsWith("/chunk-"));
  expect(blindProbes).toHaveLength(BLIND_PROBE_GIVE_UP);
  expect(discovery.blindProbesSkipped).toBe(60 - BLIND_PROBE_GIVE_UP);
  expect(discovery.maps.map((m) => [m.via, m.mapUrl])).toEqual([
    ["comment", `${base}/linked.js.map`],
  ]);
});
