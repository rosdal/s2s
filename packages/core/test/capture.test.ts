import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BrowserContext, request } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CaptureOptions, capture, RobotsDisallowedError } from "../src/capture/capture.js";
import { readManifest } from "../src/capture/manifest.js";
import { type RequestRecord, readRequestLog } from "../src/capture/request-log.js";
import { RobotsCache } from "../src/capture/robots.js";
import { workspacePaths } from "../src/capture/workspace.js";
import {
  FIXTURES_DIR,
  type FixtureName,
  type FixtureServer,
  fixtureChunks,
  serveFixture,
} from "./helpers/fixtures.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-capture-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const FAST = {
  version: "0.0.0-test",
  quietMs: 300,
  phaseTimeoutMs: 5_000,
  maskDelayMs: 0,
  delayMs: 0,
  viewports: ["desktop"],
} satisfies Partial<CaptureOptions>;

/** Fail any request that would leave localhost, so tests never touch the real network. */
async function offline(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (route) => route.abort("internetdisconnected"),
  );
}

async function run(
  server: FixtureServer,
  name: string,
  options: Partial<CaptureOptions> = {},
  pathname = "/",
) {
  const outDir = path.join(tmp, name);
  const result = await capture({
    ...FAST,
    onContext: offline,
    ...options,
    url: new URL(pathname, server.url).href,
    outDir,
  });
  const paths = workspacePaths(outDir);
  const records = existsSync(paths.requests) ? await readRequestLog(paths.requests) : [];
  return { result, paths, records };
}

const pathOf = (url: string) => new URL(url).pathname;
const storedPaths = (records: RequestRecord[]) =>
  new Set(records.filter((r) => r.bodyHash && r.status === 200).map((r) => pathOf(r.url)));
const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, "utf8")) as T;

async function expectAllChunks(name: FixtureName, records: RequestRecord[]) {
  const expected = await fixtureChunks(name);
  expect(expected.length).toBeGreaterThan(0);
  const missing = expected.filter((chunk) => !storedPaths(records).has(chunk));
  expect(missing).toEqual([]);
}

describe("static fixture", () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await serveFixture("static");
  });
  afterAll(() => server.close());

  test("records requests, both HTML states, screenshots and origins at both viewports", async () => {
    const { result, paths, records } = await run(server, "static", {
      viewports: ["desktop", "mobile"],
    });
    expect(result.status).toBe("complete");
    expect((await readManifest(paths.manifest))?.stages.capture.status).toBe("complete");
    await expectAllChunks("static", records);

    const ssr = await readFile(path.join(paths.pages, "index", "ssr.html"), "utf8");
    const dom = await readFile(path.join(paths.pages, "index", "dom.html"), "utf8");
    expect(ssr).toContain(">server-rendered<");
    expect(dom).toContain(">hydrated<");
    const pageJson = await readJson<{ title: string; finalUrl: string; tags: { tag: string }[] }>(
      path.join(paths.pages, "index", "page.json"),
    );
    expect(pageJson.title).toBe("Static fixture");
    expect(pageJson.tags.map((t) => t.tag)).toEqual(["link", "link", "script"]);

    for (const viewport of ["desktop", "mobile"]) {
      expect(existsSync(path.join(paths.screenshots, "index", `${viewport}.png`))).toBe(true);
    }
    const byPath = (p: string) => records.find((r) => pathOf(r.url) === p);
    expect(byPath("/img/dot.svg")?.origin).toBe("media");
    expect(byPath("/css/site.css")?.origin).toBe("first-party");
    expect(byPath("/")?.phase).toBe("load");
    expect(new Set(records.map((r) => r.viewport))).toEqual(new Set(["desktop", "mobile", null]));

    // Iframes and dedicated workers are recorded through the same context listeners.
    expect(byPath("/css/frame.css")?.bodyHash).toBeTruthy();
    expect(byPath("/js/worker.js")?.bodyHash).toBeTruthy();
    expect(byPath("/js/worker-dep.js")?.bodyHash).toBeTruthy();
    // Redirects are logged without a body; the target is recorded separately.
    const redirect = byPath("/old.css");
    expect(redirect).toMatchObject({ status: 302, bodyHash: null });
    expect(redirect?.redirectedTo).toMatch(/\/css\/site\.css$/);

    const runtime = await readJson<{ viewport: string }[]>(paths.runtime);
    expect(runtime.map((r) => r.viewport)).toEqual(["desktop", "mobile"]);
    const ua = byPath("/")?.requestHeaders["user-agent"] ?? "";
    expect(ua).toMatch(/s2s\/0\.0\.0-test \(\+https:\/\/github\.com\/Rosdal\/s2s\)$/);
  });

  test("a second run is a no-op; --force recaptures without duplicating bodies", async () => {
    const first = await run(server, "rerun");
    const bodies = await readdir(first.paths.bodies);
    const again = await run(server, "rerun");
    expect(again.result.skipped).toBe(true);
    const forced = await run(server, "rerun", { force: true });
    expect(forced.result.skipped).toBe(false);
    expect(forced.result.status).toBe("complete");
    expect((await readdir(forced.paths.bodies)).sort()).toEqual(bodies.sort());
    expect(forced.result.stats.bytesStored).toBe(0);
  });

  test("an aborted run is marked partial and restarts cleanly", async () => {
    const controller = new AbortController();
    const result = await capture({
      ...FAST,
      url: server.url,
      outDir: path.join(tmp, "abort"),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.kind === "phase" && event.phase === "interact") controller.abort();
      },
    });
    expect(result.status).toBe("partial");
    const paths = workspacePaths(path.join(tmp, "abort"));
    const manifest = await readManifest(paths.manifest);
    expect(manifest?.stages.capture.status).toBe("partial");
    expect((await readRequestLog(paths.requests)).length).toBeGreaterThan(0);

    const resumed = await run(server, "abort");
    expect(resumed.result.skipped).toBe(false);
    expect(resumed.result.status).toBe("complete");
    await expectAllChunks("static", resumed.records);
  });

  test("an explicit page list and a storage-state file are used", async () => {
    const authState = path.join(tmp, "state.json");
    await writeFile(
      authState,
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: "abc",
            domain: "127.0.0.1",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    );
    const { result, paths, records } = await run(server, "pages-auth", {
      // Relative entries resolve against the target.
      pages: ["/about.html"],
      authState,
    });
    expect(result.status).toBe("complete");
    expect((await readdir(paths.pages)).sort()).toEqual(["about-html", "index"]);
    const about = records.find((r) => pathOf(r.url) === "/about.html");
    expect(about?.phase).toBe("crawl");
    expect(about?.requestHeaders.cookie).toBe("session=abc");
  });

  test("a complete workspace for another URL is refused, not skipped", async () => {
    await run(server, "other-target");
    await expect(run(server, "other-target", {}, "/about.html")).rejects.toThrow(
      /holds a capture of/,
    );
  });

  test("an unreadable manifest needs --force, which replaces it", async () => {
    const outDir = path.join(tmp, "corrupt");
    await run(server, "corrupt");
    await writeFile(path.join(outDir, "manifest.json"), "{ truncated");
    await expect(run(server, "corrupt")).rejects.toThrow(/unreadable.*--force/);
    const { result } = await run(server, "corrupt", { force: true });
    expect(result.status).toBe("complete");
  });

  test("pages whose slugs collide keep separate folders", async () => {
    const { paths } = await run(server, "slugs", { pages: ["/a/b.html", "/a-b.html"] });
    expect((await readdir(paths.pages)).sort()).toEqual(["a-b-html", "a-b-html-2", "index"]);
  });

  test("--har writes a HAR next to the request log", async () => {
    const { paths } = await run(server, "har", { har: true });
    const har = await readJson<{ log: { entries: { request: { url: string } }[] } }>(paths.har);
    expect(har.log.entries.some((e) => pathOf(e.request.url) === "/js/app.js")).toBe(true);
  });
});

describe("bundler fixtures", () => {
  test("vite-react: scroll trigger and __vite__mapDeps discovery of the unvisited route", async () => {
    const server = await serveFixture("vite-react");
    try {
      const { result, records, paths } = await run(server, "vite-react");
      expect(result.status).toBe("complete");
      await expectAllChunks("vite-react", records);
      const footer = records.find((r) => /\/Footer-[\w-]+\.js$/.test(r.url) && r.status === 200);
      expect(footer?.phase).toBe("interact");
      const admin = records.find((r) => /\/Admin-[\w-]+\.js$/.test(r.url) && r.status === 200);
      expect(admin?.phase).toBe("discover");
      const discovery = await readJson<{
        entries: { url: string; source: string; status: string }[];
      }>(paths.discovery);
      expect(discovery.entries.find((e) => /Admin-[\w-]+\.js$/.test(e.url))).toMatchObject({
        source: "vite",
        status: "fetched",
      });
    } finally {
      await server.close();
    }
  });

  test("webpack-react: click trigger and chunk-map discovery", async () => {
    const server = await serveFixture("webpack-react");
    try {
      const { result, records, paths } = await run(server, "webpack-react");
      expect(result.status).toBe("complete");
      await expectAllChunks("webpack-react", records);
      const menu = records.find((r) => r.url.includes("/menu-panel.") && r.status === 200);
      expect(menu?.phase).toBe("interact");
      const discovery = await readJson<{
        entries: { url: string; source: string; status: string }[];
      }>(paths.discovery);
      expect(discovery.entries.find((e) => e.url.includes("/settings."))).toMatchObject({
        source: "webpack",
        status: "fetched",
      });
    } finally {
      await server.close();
    }
  });

  test("nextjs-pages: crawl, _buildManifest discovery and the __NEXT_DATA__ probe", async () => {
    const server = await serveFixture("nextjs-pages");
    try {
      const { result, records, paths } = await run(server, "nextjs", { depth: 1 });
      expect(result.status).toBe("complete");
      await expectAllChunks("nextjs-pages", records);
      expect((await readdir(paths.pages)).sort()).toEqual(["about", "blog-first-post", "index"]);
      expect(records.some((r) => r.phase === "crawl")).toBe(true);
      const discovery = await readJson<{ entries: { source: string; status: string }[] }>(
        paths.discovery,
      );
      expect(discovery.entries.some((e) => e.source === "next" && e.status === "fetched")).toBe(
        true,
      );
      const runtime = await readJson<
        { page: string; frameworks: { next?: { router: string; buildId: string } } }[]
      >(paths.runtime);
      expect(runtime.find((r) => r.page === "index")?.frameworks.next).toMatchObject({
        router: "pages",
        buildId: expect.any(String),
      });
    } finally {
      await server.close();
    }
  });

  test("sourcemaps: finds linked and unlinked maps", async () => {
    const server = await serveFixture("sourcemaps");
    try {
      const { result, paths, records } = await run(server, "sourcemaps");
      expect(result.status).toBe("complete");
      await expectAllChunks("sourcemaps", records);
      const maps = await readJson<{ file: string; via: string; hash: string }[]>(
        path.join(paths.maps, "index.json"),
      );
      const via = Object.fromEntries(
        maps.map((m) => [pathOf(m.file).split("/").pop()?.split("-")[0], m.via]),
      );
      expect(via).toEqual({ index: "comment", lazy: "probe" });
      for (const map of maps)
        expect(existsSync(path.join(paths.maps, `${map.hash}.map`))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("cdn-libs fixture", () => {
  const STUBS: Record<string, string> = {
    "lodash.min.js": 'window._={VERSION:"4.17.21"};',
  };
  /** Real copies of files the page loads with an integrity hash, which a stub would fail. */
  const VENDORED: Record<string, string> = {
    "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js": "jquery-3.7.1.min.js",
  };

  /** Serve CDN URLs from stubs; everything else outside localhost fails. */
  async function mockCdns(context: BrowserContext): Promise<void> {
    await context.route(
      (url) => url.hostname !== "127.0.0.1",
      async (route) => {
        const url = new URL(route.request().url());
        const file = url.pathname.split("/").pop() ?? "";
        const isCss = url.pathname.endsWith(".css") || url.hostname === "fonts.googleapis.com";
        const vendored = VENDORED[url.href];
        await route.fulfill({
          status: 200,
          contentType: isCss ? "text/css" : "text/javascript",
          // A CORS response, as the CDN sends: `crossorigin` scripts need one to run.
          headers: { "access-control-allow-origin": "*" },
          body: vendored
            ? await readFile(path.join(FIXTURES_DIR, "cdn-libs", "vendor", vendored))
            : (STUBS[file] ?? (isCss ? "body{}" : `/* ${url.href} */`)),
        });
      },
    );
  }

  test("extracts CDN packages and tags origins without real network access", async () => {
    const server = await serveFixture("cdn-libs");
    try {
      const { result, records, paths } = await run(server, "cdn-libs", { onContext: mockCdns });
      expect(result.status).toBe("complete");
      await expectAllChunks("cdn-libs", records);
      const packages = await readJson<{ name: string; version: string; registry: string }[]>(
        paths.cdnPackages,
      );
      expect(packages.map((p) => `${p.registry}:${p.name}@${p.version}`).sort()).toEqual([
        "cdnjs:jquery@3.7.1",
        "npm:@picocss/pico@2.0.6",
        "npm:canvas-confetti@1.9.3",
        "npm:dayjs@1.11.13",
        "npm:lodash@4.17.21",
        "npm:nanoid@5.0.7",
      ]);
      const origin = (host: string) =>
        records.find((r) => new URL(r.url).hostname === host)?.origin;
      expect(origin("www.googletagmanager.com")).toBe("analytics-ads");
      expect(origin("fonts.googleapis.com")).toBe("fonts");
      expect(origin("unpkg.com")).toBe("cdn-library");
      const runtime = await readJson<{ frameworks: Record<string, { version?: string }> }[]>(
        paths.runtime,
      );
      expect(runtime[0]?.frameworks.jquery?.version).toBe("3.7.1");
      expect(runtime[0]?.frameworks.lodash?.version).toBe("4.17.21");
    } finally {
      await server.close();
    }
  });
});

describe("hostile fixture", () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await serveFixture("hostile");
  });
  afterAll(() => server.close());

  test("caps quiet waits, aborts navigations and honours robots.txt while crawling", async () => {
    const started = Date.now();
    const { result, records, paths } = await run(server, "hostile", {
      depth: 1,
      phaseTimeoutMs: 2_000,
    });
    expect(result.status).toBe("complete");
    // Two pages, each with a load and an interact phase capped at 2 s, plus overhead.
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(result.warnings.some((w) => w.includes("never went quiet"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("/private/secret.html"))).toBe(true);
    expect((await readdir(paths.pages)).sort()).toEqual(["index", "second-html"]);

    const navigations = records.filter((r) => /\/(away|submitted)\.html/.test(r.url));
    expect(navigations.every((r) => r.status === 0)).toBe(true);
    expect(records.some((r) => r.url.includes("/private/"))).toBe(false);
    const dom = await readFile(path.join(paths.pages, "index", "dom.html"), "utf8");
    expect(dom).toContain("<title>Hostile fixture</title>");
    const runtime = await readJson<{ interactions: { abortedNavigations: number } }[]>(
      paths.runtime,
    );
    expect(runtime[0]?.interactions.abortedNavigations).toBeGreaterThanOrEqual(1);
  });

  test("caps interactions per page", async () => {
    const { paths } = await run(server, "hostile-cap", {
      phaseTimeoutMs: 1_000,
      maxInteractions: 1,
    });
    const runtime = await readJson<{ interactions: Record<string, number> }[]>(paths.runtime);
    const { hovers = 0, clicks = 0, focuses = 0 } = runtime[0]?.interactions ?? {};
    expect(hovers + clicks + focuses).toBe(1);
  });

  test("reads Crawl-delay and Disallow rules from robots.txt", async () => {
    const api = await request.newContext();
    try {
      const robots = new RobotsCache(api);
      expect(await robots.crawlDelayMs(server.url)).toBe(1_000);
      expect(await robots.isAllowed(new URL("private/secret.html", server.url).href)).toBe(false);
      expect(await robots.isAllowed(new URL("second.html", server.url).href)).toBe(true);
    } finally {
      await api.dispose();
    }
  });

  test("refuses a target that robots.txt disallows unless told to ignore it", async () => {
    await expect(run(server, "robots", {}, "/private/secret.html")).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    const { result } = await run(
      server,
      "robots-ignored",
      { ignoreRobots: true },
      "/private/secret.html",
    );
    expect(result.status).toBe("complete");
  });
});
