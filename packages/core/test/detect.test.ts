import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CaptureOptions, capture } from "../src/capture/capture.js";
import { readManifest } from "../src/capture/manifest.js";
import { workspacePaths } from "../src/capture/workspace.js";
import type { Evidence, EvidenceFile } from "../src/detect/evidence.js";
import { installProject, localVersion, type PackageManager } from "../src/detect/project.js";
import type { BundleRanges } from "../src/detect/ranges.js";
import type { FetchLike } from "../src/detect/registry.js";
import { type DetectOptions, detect, explain, type PackagesFile } from "../src/detect/run.js";
import { maps } from "../src/maps/run.js";
import { FIXTURES_DIR, type FixtureName, serveFixture } from "./helpers/fixtures.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-detect-"));
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

async function offline(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (route) => route.abort("internetdisconnected"),
  );
}

const REGISTRY_DIR = path.join(FIXTURES_DIR, "registry");

/** Serves `fixtures/registry/` in place of npm; anything not recorded fails the test loudly. */
const recordedFetch: FetchLike = async (url) => {
  const downloads = /\/downloads\/point\/last-week\/(.+)$/.exec(url);
  const name = downloads
    ? downloads[1]
    : decodeURIComponent(new URL(url).pathname.slice(1)).replace(/^(@[^/]+)\//, "$1/");
  const encoded = (name ?? "").startsWith("@")
    ? `@${encodeURIComponent((name ?? "").slice(1))}`
    : encodeURIComponent(name ?? "");
  const file = path.join(REGISTRY_DIR, `${encoded}${downloads ? ".downloads" : ""}.json`);
  if (!existsSync(file)) throw new Error(`No recorded registry response for ${url} (${file})`);
  const body = JSON.parse(await readFile(file, "utf8"));
  return body === null ? new Response("{}", { status: 404 }) : Response.json(body);
};

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, "utf8")) as T;

interface Run {
  outDir: string;
  packages: PackagesFile;
  ranges: BundleRanges[];
  packageJson: { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  review: { packages: { name: string; reason: string }[] };
  evidence: (collector: string) => Promise<Evidence[]>;
}

const captured = new Map<FixtureName, Promise<string>>();

/** Capture a fixture and run Stage 2 once; each detect run works on its own copy. */
function capturedWorkspace(name: FixtureName): Promise<string> {
  let known = captured.get(name);
  if (!known) {
    known = (async () => {
      const server = await serveFixture(name);
      const outDir = path.join(tmp, "captures", name);
      try {
        const result = await capture({ ...FAST, onContext: offline, url: server.url, outDir });
        expect(result.status).toBe("complete");
      } finally {
        await server.close();
      }
      expect((await maps({ workspace: outDir })).status).toBe("complete");
      return outDir;
    })();
    captured.set(name, known);
  }
  return known;
}

let runs = 0;
async function detectFixture(
  name: FixtureName,
  options: Partial<DetectOptions> = {},
): Promise<Run> {
  const source = await capturedWorkspace(name);
  const outDir = path.join(tmp, "runs", `${name}-${runs++}`);
  await cp(source, outDir, { recursive: true });
  const result = await detect({
    workspace: outDir,
    registry: { fetch: recordedFetch, cacheDir: path.join(outDir, ".registry-cache") },
    managerVersion: () => undefined,
    ...options,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe("complete");
  const analysis = path.join(outDir, "analysis");
  return {
    outDir,
    packages: await readJson(path.join(analysis, "packages.json")),
    ranges: (await readJson<{ bundles: BundleRanges[] }>(path.join(analysis, "vendor-ranges.json")))
      .bundles,
    packageJson: await readJson(path.join(outDir, "project", "package.json")),
    review: await readJson(path.join(analysis, "packages-review.json")),
    evidence: async (collector) =>
      (await readJson<EvidenceFile>(path.join(analysis, "evidence", `${collector}.json`))).evidence,
  };
}

/** The fixture's own dependencies, at the versions its install resolved: the answer key. */
async function answerKey(name: string): Promise<Map<string, string>> {
  const dir = path.join(FIXTURES_DIR, name);
  const manifest = await readJson<{ dependencies?: Record<string, string> }>(
    path.join(dir, "package.json"),
  );
  const key = new Map<string, string>();
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    const installed = await readJson<{ version: string }>(
      path.join(dir, "node_modules", dep, "package.json"),
    );
    key.set(dep, installed.version);
  }
  return key;
}

/**
 * The plan's "done when" for one fixture: every dependency in the key that left a signal is
 * found, at the right version wherever a signal carried one, and nothing outside the key (or
 * brought in by a key package) reaches medium confidence.
 */
function checkAgainstKey(run: Run, key: Map<string, string>) {
  const records = new Map(run.packages.packages.map((p) => [p.name, p]));
  for (const [dep, version] of key) {
    const record = records.get(dep);
    expect(record, `${dep} not found`).toBeDefined();
    const versioned = record?.versions.some((v) => v.version !== null) ?? false;
    if (versioned) expect(record?.version, `${dep} version`).toBe(version);
  }
  for (const record of run.packages.packages) {
    if (key.has(record.name)) continue;
    const fromKey =
      record.transitiveOf.some((p) => key.has(p)) || record.impliedBy.some((p) => key.has(p));
    if (record.confidence !== "low")
      expect(fromKey, `${record.name} is a false positive`).toBe(true);
    expect(record.status, `${record.name} must not be a dependency`).not.toBe("dependency");
  }
}

describe("s2s detect on fixtures", () => {
  test("cdn-libs: CDN evidence flows through to exact pins", async () => {
    const run = await detectFixture("cdn-libs");
    const html = await readFile(path.join(FIXTURES_DIR, "cdn-libs", "index.html"), "utf8");
    // The answer key is the pinned CDN URLs in the page.
    const key = new Map<string, string>();
    for (const m of html.matchAll(
      /(?:npm\/|unpkg\.com\/|esm\.sh\/|skypack\.dev\/)((?:@[\w.-]+\/)?[\w.-]+)@([\d.]+)/g,
    ))
      key.set(m[1] ?? "", m[2] ?? "");
    key.set("jquery", "3.7.1");
    checkAgainstKey(run, key);
    for (const [dep, version] of key) expect(run.packageJson.dependencies[dep]).toBe(version);
    const cdn = await run.evidence("cdn");
    expect(cdn.every((e) => e.signal === "cdn-url" && e.trusted)).toBe(true);
    expect(cdn.find((e) => e.package === "lodash")?.strength).toBe("exact");
  });

  test("pnpm-vendor: source-map evidence with exact versions; pm defaults to pnpm", async () => {
    const run = await detectFixture("pnpm-vendor");
    checkAgainstKey(run, await answerKey("pnpm-vendor"));
    const clsx = run.packages.packages.find((p) => p.name === "clsx");
    expect(clsx).toMatchObject({
      confidence: "high",
      status: "dependency",
      signals: ["sourcemap-path"],
    });
    expect(run.packages.packageManager).toMatchObject({ name: "pnpm", source: "sourcemap-hint" });
    const range = run.ranges.flatMap((b) => b.ranges).find((r) => r.package === "clsx");
    expect(range?.method).toBe("sourcemap");
  });

  test("webpack-license: .LICENSE.txt banners and module-bounded vendor ranges", async () => {
    const run = await detectFixture("webpack-license");
    checkAgainstKey(run, await answerKey("webpack-license"));
    const licenses = await run.evidence("license-files");
    expect([...new Set(licenses.map((e) => e.package))].sort()).toEqual([
      "gsap",
      "react",
      "react-dom",
      "scheduler",
    ]);
    expect(licenses.find((e) => e.package === "gsap")?.version).toBe("3.15.0");
    expect(licenses[0]?.location.file).toMatch(/\.js\.LICENSE\.txt$/);
    expect(licenses[0]?.pages).toEqual(["index"]);
    // scheduler comes with react-dom, so it is installed through it rather than listed.
    expect(run.packages.packages.find((p) => p.name === "scheduler")?.status).toBe("transitive");
    const ranges = run.ranges.flatMap((b) => b.ranges);
    expect(
      ranges.filter((r) => r.package === "react-dom").every((r) => r.method === "module"),
    ).toBe(true);
    expect(ranges.find((r) => r.package === "react")?.module?.kind).toBe("cjs-wrapper");
  });

  test("vite-banners: inline banners; ranges end at module boundaries", async () => {
    const run = await detectFixture("vite-banners");
    checkAgainstKey(run, await answerKey("vite-banners"));
    const banners = await run.evidence("banners");
    expect(new Set(banners.map((e) => e.package))).toEqual(
      new Set(["gsap", "react", "react-dom", "scheduler"]),
    );
    const [bundle] = run.ranges;
    const body = await readFile(
      path.join(workspacePaths(run.outDir).bodies, bundle?.bodyHash ?? ""),
    );
    const bannerStarts = banners.map((e) => e.location.offset);
    const gsap = bundle?.ranges.filter((r) => r.package === "gsap") ?? [];
    expect(gsap.length).toBeGreaterThan(0);
    for (const range of gsap) {
      expect(range.method).toBe("banner-to-boundary");
      expect(body.subarray(range.start, range.start + 3).toString()).toBe("/*!");
      // Each gsap range stops where the next banner (another package, or a gsap plugin) starts.
      expect(bannerStarts).toContain(range.end);
    }
    // The app's own code, at the end of the bundle, is never marked.
    const app = body.indexOf("swiper-wrapper");
    expect(bundle?.ranges.some((r) => r.start <= app && app < r.end)).toBe(false);
  });

  test("version-strings: signature matches need anchors; loose strings never count", async () => {
    const run = await detectFixture("version-strings");
    checkAgainstKey(run, await answerKey("version-strings"));
    const strings = await run.evidence("version-strings");
    expect(strings.some((e) => e.version === "4.17.21")).toBe(false);
    for (const pkg of ["react", "react-dom", "lodash", "gsap", "three"])
      expect(
        strings.some((e) => e.package === pkg && e.version !== null),
        pkg,
      ).toBe(true);
    expect(
      await readJson(path.join(run.outDir, "analysis", "evidence", "banners.json")),
    ).toMatchObject({
      evidence: [],
    });
    // three's REVISION gives "0.187.x"; the registry narrows it to the published version.
    expect(run.packages.packages.find((p) => p.name === "three")).toMatchObject({
      version: "0.187.0",
      versionSource: "range",
    });
  });

  test("vue-app: runtime and framework collectors on a non-React stack", async () => {
    const run = await detectFixture("vue-app");
    checkAgainstKey(run, await answerKey("vue-app"));
    expect((await run.evidence("runtime")).map((e) => [e.package, e.version, e.strength])).toEqual([
      ["vue", "3.5.44", "exact"],
    ]);
    expect((await run.evidence("framework")).some((e) => e.package === "vue")).toBe(true);
    expect(run.packageJson.dependencies).toEqual({ vue: "3.5.44" });
  });

  test("hostile-banner: names only site text gives land in review, never in package.json", async () => {
    const run = await detectFixture("hostile-banner", { install: true, pm: "npm" });
    const hostile = ["reakt-dom", "s2s-unpublished-banner-pkg", "s2s-unpublished-license-pkg"];
    expect(run.review.packages.map((p) => p.name).sort()).toEqual(hostile);
    for (const name of hostile) {
      const record = run.packages.packages.find((p) => p.name === name);
      expect(record).toMatchObject({ status: "review", confidence: "low", trusted: false });
      expect(run.packageJson.dependencies).not.toHaveProperty(name);
    }
    expect(run.ranges).toEqual([]);
    // Nothing to install, so nothing hostile could be fetched.
    expect(run.packageJson.dependencies).toEqual({});
  });

  test("--offline skips only registry checks; no evidence is lost", async () => {
    const online = await detectFixture("vite-banners");
    const off = await detectFixture("vite-banners", { offline: true });
    for (const collector of [
      "cdn",
      "sourcemap",
      "banners",
      "license-files",
      "version-strings",
      "runtime",
      "framework",
    ])
      expect(await off.evidence(collector), collector).toEqual(await online.evidence(collector));
    expect(off.packages.packages.map((p) => p.name)).toEqual(
      online.packages.packages.map((p) => p.name),
    );
    expect(off.packages.packages.every((p) => p.registry?.status !== "passed")).toBe(true);
    const manifest = await readManifest(workspacePaths(off.outDir).manifest);
    expect(manifest?.stages.detect.stats.registryRequests).toBe(0);
  });

  test("explain lists every piece of evidence behind a package", async () => {
    const run = await detectFixture("webpack-license");
    const explanation = await explain(run.outDir, "gsap");
    expect(explanation.record?.status).toBe("dependency");
    expect(new Set(explanation.evidence.map((e) => e.signal))).toEqual(
      new Set(["license-file", "version-string"]),
    );
    expect(explanation.evidence.every((e) => e.excerpt)).toBe(true);
  });

  test("--accept, --reject, --ranges caret and --min-confidence", async () => {
    const run = await detectFixture("vite-banners", {
      accept: ["swiper@14.4.0", "left-pad"],
      reject: ["gsap"],
      ranges: "caret",
    });
    expect(run.packageJson.dependencies).toMatchObject({
      swiper: "^14.4.0",
      react: "^19.3.1",
      "react-dom": "^19.3.1",
      "left-pad": "latest",
    });
    expect(run.packageJson.dependencies).not.toHaveProperty("gsap");
    expect(run.review.packages.find((p) => p.name === "gsap")?.reason).toContain("--reject");
    const high = await detectFixture("vite-banners", { minConfidence: "high" });
    expect(Object.keys(high.packageJson.dependencies)).toEqual(["gsap"]);
  });

  test("a rerun is a no-op unless forced or the options change", async () => {
    const run = await detectFixture("pnpm-vendor");
    const again = await detect({ workspace: run.outDir });
    expect(again.skipped).toBe(true);
    expect(again.packages.map((p) => p.name)).toEqual(["clsx"]);
    // Going offline changes every registry result, so it reruns; repeating it does not.
    const offline = await detect({ workspace: run.outDir, offline: true });
    expect(offline.skipped).toBe(false);
    expect((await detect({ workspace: run.outDir, offline: true })).skipped).toBe(true);
    const forced = await detect({ workspace: run.outDir, offline: true, force: true });
    expect(forced.skipped).toBe(false);
  });

  test("a workspace without a capture is refused", async () => {
    await expect(detect({ workspace: path.join(tmp, "nothing-here") })).rejects.toThrow(
      /s2s capture/,
    );
  });
});

/** Managers to try: every one installed here. CI machines without yarn or bun skip those. */
const MANAGERS = (["pnpm", "npm", "yarn", "bun"] as const).map((pm) => ({
  pm,
  version: localVersion(pm),
}));

describe("install-matrix", () => {
  for (const { pm, version } of MANAGERS) {
    test.skipIf(!version)(`${pm}: writes a lockfile and never runs install scripts`, async () => {
      const marker = path.join(tmp, "install", pm, "marker-pkg");
      const project = path.join(tmp, "install", pm, "project");
      await cp(path.join(FIXTURES_DIR, "install-matrix", "marker-pkg"), marker, {
        recursive: true,
      });
      await mkdir(project, { recursive: true });
      await writeFile(
        path.join(project, "package.json"),
        JSON.stringify({
          name: "install-matrix",
          version: "0.0.0",
          private: true,
          dependencies: { "s2s-postinstall-marker": `file:${marker.replaceAll("\\", "/")}` },
        }),
      );
      const result = await installProject(project, { name: pm as PackageManager, version });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.lockfile).not.toBeNull();
      const everywhere = await readdir(path.join(tmp, "install", pm), { recursive: true });
      expect(everywhere.filter((f) => f.endsWith("POSTINSTALL_RAN"))).toEqual([]);
    });
  }

  test("Ctrl+C during the install marks the stage partial, not complete", async () => {
    const pm = MANAGERS.find((m) => m.version && (m.pm === "npm" || m.pm === "pnpm"));
    if (!pm?.version) return;
    const outDir = path.join(tmp, "runs", `interrupted-${runs++}`);
    await cp(await capturedWorkspace("hostile-banner"), outDir, { recursive: true });
    const controller = new AbortController();
    const result = await detect({
      workspace: outDir,
      offline: true,
      install: true,
      pm: pm.pm,
      managerVersion: localVersion,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.kind === "install") controller.abort(new Error("Interrupted"));
      },
    });
    expect(result).toMatchObject({ status: "partial", error: "Interrupted" });
    const manifest = await readManifest(workspacePaths(outDir).manifest);
    expect(manifest?.stages.detect.status).toBe("partial");
    // A rerun must not skip a stage that never finished.
    expect((await detect({ workspace: outDir, offline: true })).skipped).toBe(false);
  });

  test("detect --install records the exit code and lockfile in the manifest", async () => {
    const pm = MANAGERS.find((m) => m.version && (m.pm === "npm" || m.pm === "pnpm"));
    if (!pm?.version) return;
    const run = await detectFixture("hostile-banner", {
      install: true,
      pm: pm.pm,
      managerVersion: localVersion,
    });
    const manifest = await readManifest(workspacePaths(run.outDir).manifest);
    expect(manifest?.stages.detect.stats.installExitCode).toBe(0);
    expect(manifest?.stages.detect.details?.lockfile).toMatch(/lock/);
    expect(
      existsSync(
        path.join(run.outDir, "project", String(manifest?.stages.detect.details?.lockfile)),
      ),
    ).toBe(true);
  });
});
