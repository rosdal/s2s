import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CaptureOptions, capture } from "../src/capture/capture.js";
import type { BundleRanges } from "../src/detect/ranges.js";
import { detect } from "../src/detect/run.js";
import { maps } from "../src/maps/run.js";
import { parses } from "../src/unbundle/ast.js";
import type { ModulesFile } from "../src/unbundle/graph.js";
import { type UnbundleOptions, unbundle } from "../src/unbundle/run.js";
import { similarity } from "../src/unbundle/similarity.js";
import { FIXTURES_DIR, type FixtureName, serveFixture } from "./helpers/fixtures.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-unbundle-"));
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

const prepared = new Map<FixtureName, Promise<string>>();

/** Stages 1 to 3 once per fixture (detect offline); each unbundle run gets its own copy. */
function preparedWorkspace(name: FixtureName): Promise<string> {
  let known = prepared.get(name);
  if (!known) {
    known = (async () => {
      const server = await serveFixture(name);
      const outDir = path.join(tmp, "prepared", name);
      try {
        const result = await capture({ ...FAST, onContext: offline, url: server.url, outDir });
        expect(result.status).toBe("complete");
      } finally {
        await server.close();
      }
      expect((await maps({ workspace: outDir })).status).toBe("complete");
      const detected = await detect({
        workspace: outDir,
        offline: true,
        managerVersion: () => undefined,
      });
      expect(detected.status).toBe("complete");
      return outDir;
    })();
    prepared.set(name, known);
  }
  return known;
}

interface Run {
  dir: string;
  modules: ModulesFile;
  report: {
    totals: Record<string, number>;
    modules: {
      id: string;
      chunk: string;
      range: { start: number; end: number };
      vendorBytesRemoved: number;
      errors: string[];
    }[];
  };
  files: Map<string, string>;
  js: { file: string; code: string }[];
}

let runs = 0;
async function unbundleFixture(
  name: FixtureName,
  options: Partial<UnbundleOptions> = {},
): Promise<Run> {
  const source = await preparedWorkspace(name);
  const dir = path.join(tmp, "runs", `${name}-${runs++}`);
  await cp(source, dir, { recursive: true });
  const result = await unbundle({ workspace: dir, ...options });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe("complete");
  return load(dir);
}

async function load(dir: string): Promise<Run> {
  const files = new Map<string, string>();
  const root = path.join(dir, "recovered", "unbundled");
  if (existsSync(root)) {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      files.set(path.relative(dir, file).split(path.sep).join("/"), await readFile(file, "utf8"));
    }
  }
  return {
    dir,
    modules: await readJson(path.join(dir, "analysis", "modules.json")),
    report: await readJson(path.join(dir, "analysis", "unbundle-report.json")),
    files,
    js: [...files].filter(([f]) => f.endsWith(".js")).map(([file, code]) => ({ file, code })),
  };
}

async function sourcesOf(fixture: string): Promise<{ file: string; code: string }[]> {
  const root = path.join(FIXTURES_DIR, fixture, "src");
  const out: { file: string; code: string }[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:[cm]?js|jsx)$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    out.push({ file: path.relative(root, file), code: await readFile(file, "utf8") });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

const jsModules = (run: Run) =>
  run.modules.modules.filter((m) => m.origin !== "sourcemap-exact" && m.file.endsWith(".js"));

/** Checks every fixture must pass: output parses, and vendor bytes in a module's range were removed. */
async function common(run: Run): Promise<void> {
  for (const { file, code } of run.js) expect(parses(code), `${file} parses`).toBe(true);
  const vendor = (
    await readJson<{ bundles: BundleRanges[] }>(
      path.join(run.dir, "analysis", "vendor-ranges.json"),
    )
  ).bundles;
  const requests = (await readFile(path.join(run.dir, "raw", "requests.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { url: string; bodyHash: string | null });
  for (const m of run.report.modules) {
    const hash = requests.find((r) => r.url === m.chunk)?.bodyHash;
    const ranges = vendor.find((b) => b.bodyHash === hash)?.ranges ?? [];
    const overlap = ranges.reduce(
      (n, r) => n + Math.max(0, Math.min(r.end, m.range.end) - Math.max(r.start, m.range.start)),
      0,
    );
    // Whatever vendor code sat inside a module's range was replaced (a few bytes of wrapper
    // syntax around a range are not counted as removed).
    expect(overlap - m.vendorBytesRemoved, `${m.id} keeps no vendor code`).toBeLessThan(64);
  }
}

const SNAPSHOT = path.join(import.meta.dirname, "__snapshots__", "unbundle-similarity.json");
const scores = new Map<string, number>();

/** Record the fixture's similarity score; CI fails when it drops below the committed one. */
async function checkSimilarity(name: string, run: Run, sourceFixture = name): Promise<number> {
  const result = similarity(await sourcesOf(sourceFixture), run.js);
  scores.set(name, result.score);
  const committed = existsSync(SNAPSHOT) ? await readJson<Record<string, number>>(SNAPSHOT) : {};
  if (process.env.S2S_UPDATE_SIMILARITY) {
    committed[name] = result.score;
    const sorted = Object.fromEntries(
      Object.entries(committed).sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(SNAPSHOT, `${JSON.stringify(sorted, null, 2)}\n`);
  } else {
    expect(
      committed[name],
      `similarity snapshot for ${name} (run with S2S_UPDATE_SIMILARITY=1)`,
    ).toBeDefined();
    expect(result.score, `${name} similarity`).toBeGreaterThanOrEqual(committed[name] as number);
  }
  return result.score;
}

describe("webpack", () => {
  test("webpack-react: module map across chunks, JSX, vendor import rewrite", async () => {
    const run = await unbundleFixture("webpack-react");
    await common(run);
    // index.js, MenuPanel.js and Settings.js: react's modules are gone, react's index alias too.
    expect(
      jsModules(run)
        .map((m) => m.id)
        .sort(),
    ).toEqual(["main/501", "menu-panel/210", "settings/48"]);
    expect(jsModules(run).every((m) => m.boundary === "real")).toBe(true);
    const panel = run.files.get("recovered/unbundled/menu-panel/210.js") ?? "";
    expect(panel).toContain('import * as a from "react";');
    expect(panel).toMatch(/<ul className="menu-panel">/);
    const entry = run.files.get("recovered/unbundled/main/501.js") ?? "";
    expect(entry).toContain('import("../menu-panel/210.js")');
    expect(entry).toContain('from "react-dom"');
    const routes = run.modules.modules.filter((m) => m.kind === "route").map((m) => m.id);
    expect(routes.sort()).toEqual(["menu-panel/210", "settings/48"]);
    expect(run.modules.modules.find((m) => m.id === "main/501")?.dynamicImports).toEqual([
      "menu-panel/210",
      "settings/48",
    ]);
    const pkg = await readJson<{ devDependencies: Record<string, string> }>(
      path.join(run.dir, "project", "package.json"),
    );
    expect(pkg.devDependencies.webpack).toBe("^5.0.0");
    const bundler = await readJson<{ bundler: string; version: string }>(
      path.join(run.dir, "analysis", "bundler.json"),
    );
    expect(bundler).toMatchObject({ bundler: "webpack", version: "5" });
    expect(run.report.totals.vendorDroppedBytes).toBeGreaterThan(
      (run.report.totals.totalBytes ?? 0) * 0.9,
    );
    await checkSimilarity("webpack-react", run);
  });

  test("babel-legacy: webpack 4 modules with class, async/await and spread restored", async () => {
    const run = await unbundleFixture("babel-legacy");
    await common(run);
    expect(jsModules(run)).toHaveLength(3);
    const all = run.js.map((m) => m.code).join("\n");
    expect(all).toMatch(/\bclass \w*\s*\{/);
    expect(all).toMatch(/async load\(/);
    expect(all).toMatch(/\bawait Promise\.resolve\(\)/);
    expect(all).toMatch(/async function \w+\(/);
    expect(all).toContain("[...this.items, ...");
    expect(all).toMatch(/\{ \.\.\.\w+, \.\.\.\w+ \}/);
    expect(all).toMatch(/\?\./);
    expect(all).toMatch(/for \(\w+ of /);
    expect(all).not.toContain("Cannot call a class as a function");
    expect(all).not.toContain("regenerator-runtime");
    const bundler = await readJson<{ version: string }>(
      path.join(run.dir, "analysis", "bundler.json"),
    );
    expect(bundler.version).toBe("4");
    await checkSimilarity("babel-legacy", run);
  });

  test("css-modules: class maps become `import styles` and local class names come back", async () => {
    const run = await unbundleFixture("css-modules");
    await common(run);
    expect(jsModules(run)).toHaveLength(5);
    const card = run.files.get("recovered/unbundled/styles/Card.module.css") ?? "";
    expect(card).toMatch(/\.card \.title \{/);
    expect(card).not.toMatch(/Card-module__/);
    const button = run.files.get("recovered/unbundled/styles/Button.module.css") ?? "";
    expect(button).toMatch(/\.primary \{/);
    const global = run.files.get("recovered/unbundled/styles/app.css") ?? "";
    expect(global).toContain("font-family: system-ui");
    expect(global).not.toMatch(/module__/);
    const imports = run.js.filter((m) =>
      /import styles from "\.\.\/styles\/(?:Card|Button)\.module\.css";/.test(m.code),
    );
    expect(imports).toHaveLength(2);
    const entry = run.files.get("recovered/unbundled/app/entry.js") ?? "";
    expect(entry).toMatch(/import \* as \w+ from "\.\/329\.js";/);
    const styling = await readJson<{ cssModules: { detected: boolean; classMaps: number } }>(
      path.join(run.dir, "analysis", "styling.json"),
    );
    expect(styling.cssModules).toMatchObject({ detected: true, classMaps: 2 });
    expect(run.modules.modules.filter((m) => m.kind === "style").length).toBeGreaterThanOrEqual(2);
    await checkSimilarity("css-modules", run);
  });
});

describe("Vite and Rollup", () => {
  test("vite-react: heuristic split, dynamic-import chunks as routes", async () => {
    const run = await unbundleFixture("vite-react");
    await common(run);
    const sources = await sourcesOf("vite-react");
    const count = jsModules(run).length;
    // Scope hoisting erases boundaries: within twice the source's module count.
    expect(count).toBeGreaterThanOrEqual(sources.length);
    expect(count).toBeLessThanOrEqual(sources.length * 2);
    expect(jsModules(run).some((m) => m.boundary === "heuristic")).toBe(true);
    const routes = run.modules.modules.filter((m) => m.kind === "route").map((m) => m.chunk);
    expect(routes.sort()).toEqual(["Admin", "Footer"]);
    const app = run.js.find((m) => m.code.includes("Vite React fixture"))?.code ?? "";
    expect(app).toMatch(/<h1>Vite React fixture<\/h1>/);
    expect(app).toContain('import("../Admin/part-1.js")');
    const footer = run.files.get("recovered/unbundled/Footer/part-1.js") ?? "";
    expect(footer).toMatch(/<footer className="footer">/);
    expect(footer).toContain('from "../shared/');
    const pkg = await readJson<{ devDependencies: Record<string, string> }>(
      path.join(run.dir, "project", "package.json"),
    );
    expect(pkg.devDependencies.vite).toBeDefined();
    await checkSimilarity("vite-react", run);
  });

  test("vite-react-mapped: partial-map boundaries beat the heuristic split", async () => {
    const run = await unbundleFixture("vite-react-mapped");
    await common(run);
    expect(jsModules(run).filter((m) => m.boundary === "real").length).toBeGreaterThan(0);
    expect(run.modules.modules.some((m) => m.origin === "renamed")).toBe(true);
    const all = run.js.map((m) => m.code).join("\n");
    expect(all).toContain("<h1>Vite React mapped fixture</h1>");
    expect(all).toMatch(/<footer className="footer">/);
    const mapped = await checkSimilarity("vite-react-mapped", run);
    const heuristic = await unbundleFixture("vite-react");
    const guessed = similarity(await sourcesOf("vite-react"), heuristic.js).score;
    expect(mapped).toBeGreaterThan(guessed);
  });

  test("assets: images and fonts copied under readable names, references rewritten", async () => {
    const run = await unbundleFixture("assets");
    await common(run);
    const assets = (await readdir(path.join(run.dir, "assets"))).sort();
    expect(assets).toEqual(["banner.png", "fixture-sans.woff2", "logo.png"]);
    const css = [...run.files].find(([f]) => f.endsWith(".css"))?.[1] ?? "";
    expect(css).toContain('url("../../../assets/banner.png")');
    expect(css).toContain('url("../../../assets/fixture-sans.woff2")');
    const js = run.js.map((m) => m.code).join("\n");
    expect(js).toMatch(/import \w+ from "\.\.\/\.\.\/\.\.\/assets\/logo\.png";/);
    expect(js).not.toContain("/assets/logo-");
  });
});

describe("source precedence", () => {
  test("chunks whose first-party code Stage 2 recovered exactly are linked, not reprocessed", async () => {
    const run = await unbundleFixture("sourcemaps");
    const exact = run.modules.modules.filter((m) => m.origin === "sourcemap-exact");
    expect(exact.map((m) => m.file).sort()).toEqual(
      expect.arrayContaining([
        "recovered/sourcemap/src/greet.js",
        "recovered/sourcemap/src/main.js",
      ]),
    );
    const main = exact.find((m) => m.file.endsWith("src/main.js"));
    expect(main?.imports).toContain("src/greet.js");
    expect(run.report.totals.exactChunks).toBeGreaterThan(0);
    // Nothing from those chunks was unpacked again.
    expect(run.js.some((m) => m.code.includes("greet"))).toBe(false);
  });
});

describe("other bundlers", () => {
  test("esbuild-app: __esm/__commonJS boundaries and CommonJS to ESM", async () => {
    const run = await unbundleFixture("esbuild-app");
    await common(run);
    const real = jsModules(run).filter((m) => m.boundary === "real");
    expect(real.length).toBeGreaterThanOrEqual(2);
    const all = run.js.map((m) => m.code).join("\n");
    expect(all).toMatch(/slugify/);
    expect(all).toMatch(/title\(t\)/);
    const bundler = await readJson<{ bundler: string }>(
      path.join(run.dir, "analysis", "bundler.json"),
    );
    expect(bundler.bundler).toBe("esbuild");
    await checkSimilarity("esbuild-app", run);
  });

  test("browserify-legacy: one module per id, require graph kept", async () => {
    const run = await unbundleFixture("browserify-legacy");
    await common(run);
    expect(jsModules(run)).toHaveLength(3);
    const main = run.js.find((m) => m.code.includes("cart.add"))?.code ?? "";
    expect(main).toMatch(/import \* as cart from "\.\/1\.js";/);
    const cart = run.js.find((m) => m.code.includes("prices"))?.code ?? "";
    expect(cart).toMatch(/export const add/);
    await checkSimilarity("browserify-legacy", run);
  });

  test("obfuscated: string arrays resolved, module marked, stage completes", async () => {
    const run = await unbundleFixture("obfuscated");
    await common(run);
    const [only] = jsModules(run);
    expect(only?.obfuscated).toBe(true);
    const code = run.js[0]?.code ?? "";
    expect(code).toContain('"Bonjour"');
    expect(code).toContain('document.getElementById("list")');
    expect(code).not.toMatch(/_0x[0-9a-f]{4,}\(0x/);
    await checkSimilarity("obfuscated", run);
  });
});

describe("stage behaviour", () => {
  const hashTree = async (dir: string): Promise<string> => {
    const hash = createHash("sha256");
    for (const folder of ["recovered/unbundled", "assets"]) {
      const root = path.join(dir, folder);
      if (!existsSync(root)) continue;
      const entries = (await readdir(root, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath, e.name))
        .sort();
      for (const file of entries)
        hash.update(path.relative(dir, file)).update(await readFile(file));
    }
    for (const file of ["modules.json", "bundler.json", "styling.json", "unbundle-report.json"])
      hash.update(await readFile(path.join(dir, "analysis", file)));
    hash.update(await readFile(path.join(dir, "project", "package.json")));
    return hash.digest("hex");
  };

  test("same input, byte-identical output; reruns are no-ops; --force rebuilds", async () => {
    const a = await unbundleFixture("vite-react");
    const b = await unbundleFixture("vite-react");
    expect(await hashTree(a.dir)).toBe(await hashTree(b.dir));

    const marker = path.join(a.dir, "analysis", "modules.json");
    const before = (await stat(marker)).mtimeMs;
    const again = await unbundle({ workspace: a.dir });
    expect(again.skipped).toBe(true);
    expect((await stat(marker)).mtimeMs).toBe(before);

    const forced = await unbundle({ workspace: a.dir, force: true });
    expect(forced.skipped).toBe(false);
    expect(await hashTree(a.dir)).toBe(await hashTree(b.dir));
  });

  test("--skip, --keep-vendor and --no-heuristic-split change the output", async () => {
    const skipped = await unbundleFixture("webpack-react", { skip: ["jsx", "prettier"] });
    const panel = skipped.files.get("recovered/unbundled/menu-panel/210.js") ?? "";
    expect(panel).not.toContain("<ul");
    const report = await readJson<{ modules: { passes: { pass: string; status: string }[] }[] }>(
      path.join(skipped.dir, "analysis", "unbundle-report.json"),
    );
    expect(report.modules[0]?.passes.find((p) => p.pass === "jsx")?.status).toBe("skipped");

    const kept = await unbundleFixture("webpack-react", {
      keepVendor: true,
      skip: ["unminify", "detranspile", "jsx", "esm"],
    });
    expect(kept.report.totals.vendorDroppedBytes).toBe(0);
    expect(jsModules(kept).length).toBeGreaterThan(3);

    const whole = await unbundleFixture("vite-react", { noHeuristicSplit: true });
    expect(jsModules(whole).every((m) => m.boundary === "real")).toBe(true);
  });

  test("modules.json: work order puts dependencies first; groups respect --max-group-kb", async () => {
    const run = await unbundleFixture("vite-react", { maxGroupKb: 2 });
    const order = new Map(run.modules.modules.map((m) => [m.id, m.order]));
    for (const m of run.modules.modules) {
      for (const dep of m.imports) {
        // Within a strongly connected component order is arbitrary; elsewhere deps come first.
        const back = run.modules.modules.find((x) => x.id === dep)?.imports.includes(m.id);
        if (!back) expect(order.get(dep) as number).toBeLessThan(m.order);
      }
    }
    expect(run.modules.groups.length).toBeGreaterThan(1);
    // A group stays under the limit unless one module (or one cycle of them) is bigger on its own.
    for (const g of run.modules.groups)
      expect(g.bytes <= 2048 || g.modules.length === 1).toBe(true);
    for (const m of run.modules.modules) {
      expect(Object.keys(m).sort()).toEqual(
        [
          "boundary",
          "bytes",
          "chunk",
          "dynamicImports",
          "file",
          "group",
          "id",
          "imports",
          "kind",
          "obfuscated",
          "order",
          "origin",
          "packageImports",
          "pages",
          "range",
          "source",
        ].sort(),
      );
    }
  });

  test("a workspace without capture fails cleanly", async () => {
    await expect(unbundle({ workspace: path.join(tmp, "nothing-here") })).rejects.toThrow(
      /No workspace/,
    );
  });
});
