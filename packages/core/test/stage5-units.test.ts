import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { RequestRecord } from "../src/capture/request-log.js";
import { installCommand } from "../src/detect/project.js";
import {
  agentsMd,
  claudeSettings,
  progressMd,
  promptMd,
  slashCommandMd,
} from "../src/scaffold/agent-files.js";
import { type AgentFacts, DEFAULT_THRESHOLDS, projectScript } from "../src/scaffold/facts.js";
import { buildIndexHtml } from "../src/scaffold/html.js";
import { hasJsx, relocateReferences } from "../src/scaffold/relocate.js";
import { addMissingImports, chooseTarget } from "../src/scaffold/run.js";
import { mainTs, scaffoldPackageJson } from "../src/scaffold/templates.js";
import { callableClass } from "../src/unbundle/adapter.js";
import type { ModulesFile } from "../src/unbundle/graph.js";
import { usesJsxRuntime } from "../src/unbundle/passes.js";
import { vendorNamespaceLines } from "../src/unbundle/vendor.js";
import { loadThresholds } from "../src/verify/config.js";
import { comparePixels, diffRegions, dynamicMask, type Image } from "../src/verify/image.js";
import { ReplayIndex } from "../src/verify/replay.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-stage5-units-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const FACTS: AgentFacts = {
  site: "https://shop.example.com/",
  pages: [
    { slug: "index", url: "https://shop.example.com/" },
    { slug: "cart", url: "https://shop.example.com/cart" },
  ],
  viewports: ["desktop", "mobile"],
  target: "react",
  fallbackFrom: null,
  stack: [
    {
      label: "UI library",
      value: "react 18.3.1",
      confidence: "high confidence",
      source: "analysis/packages.json",
    },
    {
      label: "Original bundler",
      value: "webpack 5",
      confidence: "high confidence",
      source: "analysis/bundler.json",
    },
  ],
  packageManager: "pnpm",
  packages: [
    { name: "react", version: "18.3.1", confidence: "high", dev: false },
    { name: "react-dom", version: "18.3.1", confidence: "high", dev: false },
  ],
  review: [{ name: "scheduler", version: null, confidence: "low", reason: "license comment only" }],
  modules: { total: 3, exact: 0, renamed: 0, unbundled: 3, obfuscated: 0, styles: 1 },
  groups: [
    {
      id: "g1",
      bytes: 9286,
      modules: [
        {
          file: "project/src/_recovered/cart/12.jsx",
          original: "recovered/unbundled/cart/12.js",
          kind: "component",
          origin: "unbundled",
        },
        {
          file: "project/src/_recovered/main/501.js",
          original: "recovered/unbundled/main/501.js",
          kind: "entry",
          origin: "unbundled",
        },
      ],
    },
  ],
  notes: 2,
  thresholds: DEFAULT_THRESHOLDS,
};

describe("agent files", () => {
  test("match their snapshots", async () => {
    await expect(agentsMd(FACTS)).toMatchFileSnapshot("__snapshots__/stage5/AGENTS.md");
    await expect(promptMd(FACTS)).toMatchFileSnapshot("__snapshots__/stage5/PROMPT.md");
    await expect(progressMd(FACTS)).toMatchFileSnapshot("__snapshots__/stage5/PROGRESS.md");
    await expect(claudeSettings(FACTS)).toMatchFileSnapshot("__snapshots__/stage5/settings.json");
  });

  test("the slash command carries the prompt", () => {
    expect(slashCommandMd(FACTS)).toContain(promptMd(FACTS).trim());
  });

  test("an SSR framework fallback is stated", () => {
    const text = agentsMd({ ...FACTS, fallbackFrom: "Next.js" });
    expect(text).toContain("built with Next.js");
    expect(text).toContain("don't add Next.js");
  });

  test("the allowlist matches the commands the files tell the agent to run", () => {
    const settings = JSON.parse(claudeSettings(FACTS)) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toContain(`Bash(${projectScript("pnpm", "build")})`);
    expect(agentsMd(FACTS)).toContain(projectScript("pnpm", "build"));
    expect(progressMd(FACTS)).toContain(projectScript("pnpm", "typecheck"));
  });
});

describe("index.html", () => {
  const html = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="/assets/index-abc.css">
    <link rel="modulepreload" href="/assets/vendor-abc.js">
    <link rel="icon" href="/favicon.ico">
    <script defer src="/static/runtime.js"></script>
    <script defer src="/static/main.js"></script>
    <script src="https://cdn.example.net/lib.js"></script>
    <script type="application/json" id="data">{"a":1}</script>
  </head>
  <body><div id="root"></div></body>
</html>`;

  test("replaces the site's own scripts and styles with one entry", () => {
    const { html: out, removed } = buildIndexHtml({
      html,
      pageUrl: "https://site.test/",
      replaced: new Set([
        "https://site.test/assets/index-abc.css",
        "https://site.test/assets/vendor-abc.js",
        "https://site.test/static/runtime.js",
        "https://site.test/static/main.js",
      ]),
      dropInlineScripts: false,
      entry: "/src/main.ts",
    });
    expect(removed).toHaveLength(4);
    expect(out).not.toContain("/static/");
    expect(out).not.toContain("index-abc.css");
    expect(out).toContain('<link rel="icon" href="/favicon.ico">');
    expect(out).toContain("https://cdn.example.net/lib.js");
    expect(out).toContain('type="application/json"');
    expect(out.match(/src="\/src\/main\.ts"/g)).toHaveLength(1);
    // The entry goes where the first removed script was.
    expect(out.indexOf("/src/main.ts")).toBeLessThan(out.indexOf("cdn.example.net"));
  });

  test("an SSR fallback drops inline bootstrap scripts but keeps data", () => {
    const { html: out } = buildIndexHtml({
      html: '<html><body><script>self.__next_f.push([1])</script><script type="application/json">{}</script></body></html>',
      pageUrl: "https://site.test/",
      replaced: new Set(),
      dropInlineScripts: true,
      entry: "/src/main.ts",
    });
    expect(out).not.toContain("__next_f");
    expect(out).toContain("application/json");
    expect(out).toContain("/src/main.ts");
  });
});

describe("relocation", () => {
  test("re-points imports and url() at moved files", () => {
    const moves = new Map([
      ["recovered/unbundled/app/part-1.js", "project/src/_recovered/app/part-1.jsx"],
      ["assets/img/logo.png", "project/src/assets/img/logo.png"],
    ]);
    const js = relocateReferences(
      'import a from "./part-1.js";\nimport logo from "../../../assets/img/logo.png";\nimport("./part-1.js");\nimport x from "react";\n',
      "recovered/unbundled/app/part-2.js",
      "project/src/_recovered/app/part-2.js",
      moves,
    );
    expect(js).toContain('from "./part-1.jsx"');
    expect(js).toContain('from "../../assets/img/logo.png"');
    expect(js).toContain('import("./part-1.jsx")');
    expect(js).toContain('from "react"');
    const css = relocateReferences(
      ".a { background: url(../../../assets/img/logo.png?v=1); }",
      "recovered/unbundled/styles/a.css",
      "project/src/_recovered/styles/a.css",
      moves,
    );
    expect(css).toContain("url(../../assets/img/logo.png?v=1)");
  });

  test("detects JSX", () => {
    expect(hasJsx("const a = <div className='x'>hi</div>;")).toBe(true);
    expect(hasJsx("const a = 1 < 2 && b > 3;")).toBe(false);
  });
});

describe("Stage 4 fixes", () => {
  test("the JSX pass needs evidence of a JSX runtime", () => {
    expect(usesJsxRuntime('import * as a from "react"; a.createElement("div")')).toBe(true);
    expect(usesJsxRuntime("n.jsx('div', {})")).toBe(true);
    expect(usesJsxRuntime("document.createElement(tag, { is: n })")).toBe(false);
  });

  test("a react-dom vendor namespace also carries react-dom/client", () => {
    const lines = vendorNamespaceLines("__vendor_react_dom", "react-dom");
    expect(lines.join("\n")).toContain('from "react-dom/client"');
    expect(lines.at(-1)).toMatch(/^const __vendor_react_dom = \{/);
    expect(vendorNamespaceLines("__vendor_react_dom", "react-dom", "17.0.2")).toEqual([
      'import * as __vendor_react_dom from "react-dom";',
    ]);
    expect(vendorNamespaceLines("__vendor_vue", "vue")).toEqual([
      'import * as __vendor_vue from "vue";',
    ]);
  });
});

describe("acceptance-run fixes", () => {
  test("npm installs past peer conflicts between inferred versions", () => {
    expect(installCommand("npm", "11.0.0").args).toContain("--legacy-peer-deps");
  });

  test("a constructor meant to be called without new is not a class", () => {
    expect(
      callableClass(
        "class c {\n  constructor(e, t) {\n    if (!(this instanceof c)) {\n      return new c(e, t);\n    }\n  }\n}",
      ),
    ).toBe(true);
    expect(callableClass("class c {\n  constructor(e) {\n    this.e = e;\n  }\n}")).toBe(false);
  });

  test("packages the code imports but package.json lacks are added", () => {
    const pkg = {
      name: "s",
      version: "0.0.0",
      private: true as const,
      dependencies: { react: "19.2.5", "react-router": "8.5.1" } as Record<string, string>,
      devDependencies: {},
    };
    const graph = {
      modules: [{ packageImports: ["react", "react-router-dom", "left-pad"] }],
      groups: [],
    } as unknown as ModulesFile;
    const warnings: string[] = [];
    addMissingImports(pkg, graph, { packages: [] }, (m) => warnings.push(m));
    expect(pkg.dependencies["react-router-dom"]).toBe("npm:react-router@8.5.1");
    expect(pkg.dependencies["left-pad"]).toBe("latest");
    expect(warnings).toHaveLength(2);
    const v6 = { ...pkg, dependencies: { "react-router": "6.30.1" } as Record<string, string> };
    addMissingImports(v6, graph, { packages: [] }, () => {});
    expect(v6.dependencies["react-router-dom"]).toBe("6.30.1");
  });
});

describe("scaffold choices", () => {
  const pkg = (name: string, status = "dependency") => ({
    name,
    version: "1.0.0",
    confidence: "high",
    status,
  });

  test("the target follows the accepted UI library", () => {
    expect(chooseTarget([pkg("react"), pkg("react-dom")]).target).toBe("react");
    expect(chooseTarget([pkg("vue")]).target).toBe("vue");
    expect(chooseTarget([pkg("preact")]).target).toBe("preact");
    expect(chooseTarget([pkg("react", "review")]).target).toBe("vanilla");
    expect(chooseTarget([pkg("react"), pkg("next")]).fallbackFrom).toBe("Next.js");
  });

  test("package.json swaps the original bundler for Vite", () => {
    const out = scaffoldPackageJson(
      {
        name: "site",
        version: "0.0.0",
        private: true,
        dependencies: { react: "18.3.1" },
        devDependencies: { webpack: "^5.0.0", sass: "1.0.0" },
      },
      "react",
    ) as unknown as { devDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(out.devDependencies.webpack).toBeUndefined();
    expect(out.devDependencies.sass).toBe("1.0.0");
    expect(out.devDependencies.vite).toBeDefined();
    expect(out.devDependencies["@vitejs/plugin-react"]).toBeDefined();
    expect(out.scripts.build).toBe("vite build");
    expect(out.devDependencies["@types/react"]).toBe("^18.0.0");
    expect(out.devDependencies["@types/react-dom"]).toBe("^18.0.0");
  });

  test("main.ts loads the runtime, styles, then modules", () => {
    const text = mainTs({ runtime: true, styles: ["./a.css"], modules: ["./b.js"] });
    const order = ["_s2s/runtime.ts", "./a.css", "./b.js"].map((s) => text.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

const solid = (width: number, height: number, rgb: [number, number, number]): Image => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { width, height, data };
};
const paint = (image: Image, x0: number, y0: number, w: number, h: number, rgb: number[]) => {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) image.data.set([...rgb, 255], (y * image.width + x) * 4);
};

describe("pixel comparison", () => {
  test("regions group differing pixels into padded rectangles", () => {
    const rects = diffRegions((x, y) => x >= 20 && x < 40 && y >= 20 && y < 30, 100, 100);
    expect(rects).toHaveLength(1);
    const [r] = rects;
    expect(r?.x).toBeLessThanOrEqual(20);
    expect((r?.x ?? 0) + (r?.width ?? 0)).toBeGreaterThanOrEqual(40);
  });

  test("the dynamic mask covers what changed between two shots", () => {
    const a = solid(200, 200, [255, 255, 255]);
    const b = solid(200, 200, [255, 255, 255]);
    paint(b, 50, 50, 100, 40, [200, 0, 0]);
    const mask = dynamicMask(a, b);
    expect(mask.length).toBeGreaterThan(0);
    expect(comparePixels(a, b, mask).ratio).toBe(0);
    expect(comparePixels(a, b, []).ratio).toBeGreaterThan(0.09);
  });

  test("a size change counts the extra area as different", () => {
    const a = solid(100, 100, [255, 255, 255]);
    const b = solid(100, 120, [255, 255, 255]);
    const result = comparePixels(a, b, []);
    expect(result.ratio).toBeGreaterThan(0.1);
    expect(result.regions[0]?.y).toBeGreaterThanOrEqual(80);
  });
});

const record = (url: string, extra: Partial<RequestRecord> = {}): RequestRecord => ({
  id: "r1",
  page: "index",
  viewport: "desktop",
  phase: "load",
  method: "GET",
  url,
  resourceType: "fetch",
  status: 200,
  requestHeaders: {},
  responseHeaders: { "content-type": "application/json", "content-length": "2" },
  mimeType: "application/json",
  size: 2,
  bodyHash: "h1",
  initiator: { type: "page", url: null },
  timing: { startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1 },
  origin: "first-party",
  ...extra,
});

describe("replay", () => {
  const index = new ReplayIndex(
    [
      record("https://site.test/api/items?page=1"),
      record("https://site.test/assets/main-abc.js", {
        resourceType: "script",
        mimeType: "text/javascript",
        bodyHash: "h2",
      }),
      record("https://www.google-analytics.com/collect", {
        origin: "analytics-ads",
        bodyHash: "h3",
      }),
      record("https://fonts.gstatic.com/a.woff2", { origin: "fonts", bodyHash: "h4" }),
      record("https://site.test/missing.png", { status: 404, bodyHash: null }),
    ],
    "https://site.test/",
  );
  const local = "http://127.0.0.1:5000";

  test("serves the site's own API by path and third-party assets by URL", () => {
    expect(index.lookup(`${local}/api/items?page=1`, local)?.bodyHash).toBe("h1");
    expect(index.lookup(`${local}/api/items?page=1`, local)?.headers["content-length"]).toBe(
      undefined,
    );
    expect(index.lookup("https://site.test/api/items?page=1", local)?.bodyHash).toBe("h1");
    expect(index.lookup("https://fonts.gstatic.com/a.woff2", local)?.bodyHash).toBe("h4");
  });

  test("never serves the original scripts or trackers", () => {
    expect(index.lookup(`${local}/assets/main-abc.js`, local)).toBeUndefined();
    expect(index.lookup("https://www.google-analytics.com/collect", local)).toBeUndefined();
  });

  test("knows what failed in the capture too", () => {
    expect(index.failedInCapture(`${local}/missing.png`, local)).toBe(true);
    expect(index.failedInCapture(`${local}/other.png`, local)).toBe(false);
  });
});

describe("config", () => {
  test("reads thresholds from TypeScript and fills in defaults", async () => {
    const file = path.join(tmp, "s2s.config.ts");
    await writeFile(
      file,
      "const limit: number = 0.05;\nexport default { verify: { maxPixelDiff: limit } };\n",
    );
    expect(await loadThresholds(file)).toEqual({ ...DEFAULT_THRESHOLDS, maxPixelDiff: 0.05 });
    expect(await loadThresholds(path.join(tmp, "none.ts"))).toEqual(DEFAULT_THRESHOLDS);
  });

  test("rejects values out of range", async () => {
    const file = path.join(tmp, "bad.config.ts");
    await writeFile(file, "export default { verify: { minDomSimilarity: 3 } };\n");
    await expect(loadThresholds(file)).rejects.toThrow(/invalid/);
  });
});
