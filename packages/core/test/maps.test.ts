import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { parse } from "@babel/parser";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CaptureOptions, capture } from "../src/capture/capture.js";
import { readManifest } from "../src/capture/manifest.js";
import { workspacePaths } from "../src/capture/workspace.js";
import { maps, WorkspaceError } from "../src/maps/run.js";
import { FIXTURES_DIR, type FixtureName, serveFixture } from "./helpers/fixtures.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-maps-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const FAST = {
  version: "0.0.0-test",
  quietMs: 300,
  phaseTimeoutMs: 5_000,
  delayMs: 0,
  viewports: ["desktop"],
} satisfies Partial<CaptureOptions>;

async function offline(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (route) => route.abort("internetdisconnected"),
  );
}

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, "utf8")) as T;

interface Report {
  projectRoot: { absolute: string; relative: string };
  maps: {
    file: string;
    via: string;
    sources: { raw: string; kind: string | null; output: string | null; confidence: string }[];
  }[];
  errors: { file: string; reason: string }[];
  rejected: { source: string; reason: string }[];
  conflicts: { path: string; variants: { output: string }[] }[];
  renamed: {
    file: string;
    output: string | null;
    renamed: number;
    skipped: { from: string; to: string; reason: string }[];
  }[];
  coverage: Record<
    "overall" | "js" | "css",
    { total: number; exact: number; renamed: number; share: number }
  > & { files: { url: string; share: number }[] };
}

/** Capture a fixture, then run Stage 2 on the workspace. */
async function captureAndMap(name: FixtureName) {
  const server = await serveFixture(name);
  const outDir = path.join(tmp, name);
  try {
    const captured = await capture({ ...FAST, onContext: offline, url: server.url, outDir });
    expect(captured.status).toBe("complete");
  } finally {
    await server.close();
  }
  const result = await maps({ workspace: outDir });
  const paths = workspacePaths(outDir);
  const report = await readJson<Report>(paths.sourcemapsReport);
  return { result, paths, report, outDir };
}

/** Files under a folder, as forward-slash relative paths. */
async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replaceAll("\\", "/"))
    .sort();
}

async function expectIdentical(
  paths: ReturnType<typeof workspacePaths>,
  fixture: string,
  files: string[],
) {
  for (const file of files) {
    const recovered = await readFile(path.join(paths.recoveredSourcemap, file));
    const original = await readFile(path.join(FIXTURES_DIR, fixture, file));
    expect(recovered.equals(original), `${file} is byte-identical`).toBe(true);
  }
}

describe("sourcemaps fixture (Vite)", () => {
  test("recovers every source byte-identical at its original path, and is rerunnable", async () => {
    const { result, paths, report, outDir } = await captureAndMap("sourcemaps");
    expect(result.status).toBe("complete");
    await expectIdentical(paths, "sourcemaps", ["src/main.js", "src/greet.js", "src/lazy.js"]);
    const files = await listFiles(paths.recoveredSourcemap);
    expect(files.filter((f) => !f.startsWith("_virtual/"))).toEqual([
      "src/greet.js",
      "src/lazy.js",
      "src/main.js",
    ]);
    // The lazy chunk's map was found by probing (no comment), and is used all the same.
    expect(report.maps.map((m) => m.via).sort()).toEqual(["comment", "probe"]);
    // Vite leaves its preload helper and modulepreload polyfill unmapped, so the entry chunk is
    // mostly unexplained while most of the lazy chunk is exact.
    const lazy = report.coverage.files.find((f) => f.url.includes("/lazy-"));
    expect(lazy?.share).toBeGreaterThan(0.6);
    expect(report.coverage.js.exact).toBeGreaterThan(0);
    expect(report.coverage.js.renamed).toBe(0);
    expect(result.summary).toMatch(
      /^2 maps, \d+ sources recovered, \d+% of first-party JS covered$/,
    );

    const manifest = await readManifest(paths.manifest);
    expect(manifest?.stages.maps.status).toBe("complete");
    expect(manifest?.stages.capture.status).toBe("complete");

    // Rerun: a no-op that leaves files alone.
    const before = (await stat(path.join(paths.recoveredSourcemap, "src/main.js"))).mtimeMs;
    const again = await maps({ workspace: outDir });
    expect(again.skipped).toBe(true);
    expect(again.summary).toBe(result.summary);
    expect((await stat(path.join(paths.recoveredSourcemap, "src/main.js"))).mtimeMs).toBe(before);

    // --force: rebuilds from scratch, so a stray file disappears.
    const stray = path.join(paths.recoveredSourcemap, "src/stray.js");
    await import("node:fs/promises").then((fs) => fs.writeFile(stray, "x"));
    const forced = await maps({ workspace: outDir, force: true });
    expect(forced.skipped).toBe(false);
    expect(forced.stats).toEqual(result.stats);
    expect(existsSync(stray)).toBe(false);
    await expectIdentical(paths, "sourcemaps", ["src/main.js"]);
  });
});

describe("sourcemaps-partial fixture (esbuild, no sourcesContent)", () => {
  test("renames bindings through their scope and records file boundaries", async () => {
    const { result, paths, report } = await captureAndMap("sourcemaps-partial");
    expect(result.status).toBe("complete");
    expect(await listFiles(paths.recoveredSourcemap)).toEqual([]);

    const chunk = report.renamed[0];
    expect(chunk?.output).toMatch(/^recovered\/renamed\/[0-9a-f]{64}\.js$/);
    const code = await readFile(path.join(paths.root, chunk?.output ?? ""), "utf8");
    for (const name of [
      "computeTotal",
      "runningTotal",
      "formatPrice",
      "shoppingItems",
      "items",
      "amount",
    ]) {
      expect(code).toMatch(new RegExp(`\\b${name}\\b`));
    }
    // Both modules declared `label`; the second rename collides and is skipped, not forced.
    expect(code.match(/function label\(/g)).toHaveLength(1);
    expect(chunk?.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "label", reason: expect.stringMatching(/collides/) }),
      ]),
    );

    // The renamed chunk still parses and behaves the same.
    parse(code, { sourceType: "script" });
    const dataset: Record<string, string> = {};
    vm.runInNewContext(code, { document: { body: { dataset } } });
    expect(dataset).toEqual({ cart: "cart:7", total: "price:7.00" });

    const boundaries = await readJson<
      { renamed: string; ranges: { source: string; renamedStart?: unknown }[] }[]
    >(paths.sourcemapBoundaries);
    expect(boundaries).toHaveLength(1);
    expect(new Set(boundaries[0]?.ranges.map((r) => r.source))).toEqual(
      new Set(["src/cart.js", "src/format.js", "src/main.js"]),
    );
    expect(boundaries[0]?.ranges.every((r) => r.renamedStart)).toBe(true);

    expect(report.coverage.js.exact).toBe(0);
    expect(result.summary).toMatch(
      /^1 map, 0 sources recovered, 0% of first-party JS covered \(\d+% more renamed\)$/,
    );
    expect(report.coverage.js.renamed).toBeGreaterThan(0);
    expect(report.maps[0]?.sources.every((s) => s.confidence === "renamed")).toBe(true);
  });
});

describe("sourcemaps-inline fixture (esbuild, inline data: map)", () => {
  test("extracts the inline map and recovers its sources", async () => {
    const { paths, report } = await captureAndMap("sourcemaps-inline");
    expect(report.maps.map((m) => m.via)).toEqual(["inline"]);
    await expectIdentical(paths, "sourcemaps-inline", ["src/app.js", "src/util.js"]);
    expect(report.coverage.js.share).toBeGreaterThan(0.5);
  });
});

describe("webpack-namespace fixture", () => {
  test("strips webpack:// namespaces and routes runtime modules to _virtual/", async () => {
    const { paths, report } = await captureAndMap("webpack-namespace");
    expect(report.maps).toHaveLength(2);
    expect(report.maps.flatMap((m) => m.sources.map((s) => s.raw))).toEqual(
      expect.arrayContaining([
        "webpack://shop-ns/./src/index.js",
        "webpack://shop-ns/webpack/bootstrap",
      ]),
    );
    await expectIdentical(paths, "webpack-namespace", [
      "src/index.js",
      "src/cart.js",
      "src/checkout.js",
    ]);
    const files = await listFiles(paths.recoveredSourcemap);
    expect(files.filter((f) => f.startsWith("_virtual/webpack/runtime/")).length).toBeGreaterThan(
      3,
    );
    expect(files.filter((f) => !f.startsWith("_virtual/"))).toEqual([
      "src/cart.js",
      "src/checkout.js",
      "src/index.js",
    ]);
  });
});

describe("pnpm-vendor fixture", () => {
  test("reads exact versions from .pnpm paths and hints pnpm", async () => {
    const { paths, report } = await captureAndMap("pnpm-vendor");
    const installed = await readJson<{ version: string }>(
      path.join(FIXTURES_DIR, "pnpm-vendor/node_modules/clsx/package.json"),
    );
    const evidence = await readJson<{
      packageManager: { value: string };
      packages: {
        name: string;
        version: string | null;
        source: string;
        files: number;
        totalBytes: number;
      }[];
    }>(paths.sourcemapPackages);
    expect(evidence.packages).toEqual([
      expect.objectContaining({
        name: "clsx",
        version: installed.version,
        source: "sourcemap",
        files: 1,
      }),
    ]);
    expect(evidence.packages[0]?.totalBytes).toBeGreaterThan(0);
    expect(evidence.packageManager.value).toBe("pnpm");

    const hints = await readJson<{
      packageManager: { value: string };
      language: { value: string };
    }>(paths.projectHints);
    expect(hints.packageManager.value).toBe("pnpm");
    expect(hints.language.value).toBe("javascript");

    // Vendor sources are kept for reference, outside the project tree.
    const files = await listFiles(paths.recoveredSourcemap);
    expect(files).toContain("src/main.js");
    expect(files.some((f) => /^_vendor\/node_modules\/\.pnpm\/clsx@/.test(f))).toBe(true);
    expect(report.maps[0]?.sources.find((s) => s.kind === "vendor")?.output).toMatch(/^_vendor\//);
  });
});

describe("css-preprocessor fixture", () => {
  test("recovers .scss and .module.css sources and hints their styling", async () => {
    const { paths, report } = await captureAndMap("css-preprocessor");
    await expectIdentical(paths, "css-preprocessor", [
      "src/styles/site.scss",
      "src/components/card.module.css",
      "src/main.js",
    ]);
    expect(report.coverage.css.share).toBeGreaterThan(0.5);
    const hints = await readJson<{ styling: { value: string }[] }>(paths.projectHints);
    expect(hints.styling.map((s) => s.value)).toEqual(["scss", "css-modules"]);
  });
});

describe("hostile-map fixture", () => {
  test("rejects path escapes, lists broken maps and keeps both sides of a conflict", async () => {
    const { result, paths, report, outDir } = await captureAndMap("hostile-map");
    expect(result.status).toBe("complete");

    expect(report.rejected).toHaveLength(2);
    expect(report.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "src/../../../evil.js",
          reason: expect.stringMatching(/escapes/),
        }),
        // `src/utils` was written as a file first, so the folder it would need cannot exist.
        expect.objectContaining({
          source: "src/utils/index.js",
          reason: expect.stringMatching(/cannot write src\/utils\/index\.js/),
        }),
      ]),
    );
    const all = await listFiles(outDir);
    expect(all.some((f) => f.endsWith("evil.js"))).toBe(false);
    // A leading `../` run only climbs out of the map's folder, so it lands inside the output.
    expect(await listFiles(paths.recoveredSourcemap)).toEqual(
      expect.arrayContaining(["etc/passwd", "src/ok.js"]),
    );

    const errors = Object.fromEntries(
      report.errors.map((e) => [new URL(e.file).pathname, e.reason]),
    );
    expect(errors["/broken.js"]).toMatch(/reference source 7/);
    expect(errors["/truncated.js"]).toMatch(/not valid JSON/);

    // Paths differing only in case are one file on Windows and macOS, so they conflict too.
    expect(report.conflicts.map((c) => c.path).sort()).toEqual(["src/App.js", "src/dup.js"]);
    const caseClash = report.conflicts.find((c) => c.path === "src/App.js");
    expect(caseClash?.variants.map((v) => v.output)).toEqual([
      "src/App.js",
      expect.stringMatching(/^src\/app\.[0-9a-f]{8}\.js$/),
    ]);
    for (const variant of caseClash?.variants ?? []) {
      expect(existsSync(path.join(paths.recoveredSourcemap, variant.output))).toBe(true);
    }
    const dup = report.conflicts.find((c) => c.path === "src/dup.js");
    const outputs = dup?.variants.map((v) => v.output) ?? [];
    expect(outputs[0]).toBe("src/dup.js");
    expect(outputs[1]).toMatch(/^src\/dup\.[0-9a-f]{8}\.js$/);
    const contents = await Promise.all(
      outputs.map((o) => readFile(path.join(paths.recoveredSourcemap, o), "utf8")),
    );
    expect(contents.sort()).toEqual(["export const v = 1;\n", "export const v = 2;\n"]);
    expect(result.warnings.join("\n")).toMatch(/unusable/);
  });
});

describe("workspaces without maps", () => {
  test("finish cleanly with 0% coverage", async () => {
    const server = await serveFixture("static");
    const outDir = path.join(tmp, "no-maps");
    try {
      await capture({ ...FAST, onContext: offline, url: server.url, outDir });
    } finally {
      await server.close();
    }
    const result = await maps({ workspace: outDir });
    expect(result.status).toBe("complete");
    expect(result.stats.maps).toBe(0);
    expect(result.stats.coverage).toBe(0);
    expect(result.summary).toBe("0 maps, 0 sources recovered, 0% of first-party JS covered");
    const paths = workspacePaths(outDir);
    const report = await readJson<Report>(paths.sourcemapsReport);
    expect(report.coverage.js.total).toBeGreaterThan(0);
    expect(report.coverage.js.exact).toBe(0);
    expect(existsSync(paths.projectHints)).toBe(true);
    expect(existsSync(paths.sourcemapPackages)).toBe(true);
    expect((await readManifest(paths.manifest))?.stages.maps.status).toBe("complete");
  });

  test("a folder without a workspace is an error", async () => {
    await expect(maps({ workspace: path.join(tmp, "nothing-here") })).rejects.toThrow(
      WorkspaceError,
    );
  });
});
