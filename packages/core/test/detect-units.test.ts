import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { workspacePaths } from "../src/capture/workspace.js";
import { findBanners, parseBanner } from "../src/detect/banners.js";
import { checkPackages } from "../src/detect/check.js";
import { collectRuntime } from "../src/detect/collectors.js";
import type { DetectContext } from "../src/detect/context.js";
import { loadContext } from "../src/detect/context.js";
import { ByteIndex, type Evidence } from "../src/detect/evidence.js";
import { mergeEvidence } from "../src/detect/merge.js";
import { chooseManager, installCommand, projectName, versionSpec } from "../src/detect/project.js";
import { findModules, moduleAt, vendorRanges } from "../src/detect/ranges.js";
import {
  type FetchLike,
  Registry,
  RegistryError,
  resolveVersion,
  trimPackument,
} from "../src/detect/registry.js";
import { compileSignatures, matchSignatures, SIGNATURE_FILES } from "../src/detect/signatures.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-detect-units-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("parseBanner", () => {
  test.each([
    ["/*! lodash v4.17.21 | MIT */", "lodash", "4.17.21", "name-version"],
    [
      "/*! jQuery v3.7.1 | (c) OpenJS Foundation and other contributors */",
      "jquery",
      "3.7.1",
      "name-version",
    ],
    [
      "/**\n * Swiper 11.2.6\n * Most modern mobile touch slider\n */",
      "swiper",
      "11.2.6",
      "name-version",
    ],
    [
      "/*!\n* GSAP 3.15.0\n* https://gsap.com\n*\n* @license Copyright 2008-2026, GreenSock.\n*/",
      "gsap",
      "3.15.0",
      "name-version",
    ],
    ["/*!\n* CSSPlugin 3.15.0\n* https://gsap.com\n*/", "gsap", "3.15.0", "name-version"],
    ["/*! axios@1.8.1 */", "axios", "1.8.1", "name-at-version"],
    ["/*! @scope/pkg@2.0.0-beta.1 */", "@scope/pkg", "2.0.0-beta.1", "name-at-version"],
    ["/*! @license some-lib 3.1.4 */", "some-lib", "3.1.4", "license-name-version"],
    [
      "/*! tailwindcss v3.4.17 | MIT License | https://tailwindcss.com */",
      "tailwindcss",
      "3.4.17",
      "name-version",
    ],
  ])("%s", (banner, name, version, shape) => {
    expect(parseBanner(banner)).toContainEqual({ name, version, shape });
  });

  test("React banners name the build file's package, without a version since React 18", () => {
    const hits = parseBanner(
      "/**\n * @license React\n * react-dom-client.production.js\n *\n * Copyright (c) Meta Platforms, Inc. and affiliates.\n */",
    );
    expect(hits).toEqual([{ name: "react-dom", version: null, shape: "file-name" }]);
    expect(parseBanner("/** @license React\n * react.production.js */")).toEqual([
      { name: "react", version: null, shape: "file-name" },
    ]);
    expect(parseBanner("/** @license React\n * scheduler.production.min.js */")[0]?.name).toBe(
      "scheduler",
    );
  });

  test("comment markers come off in linear time, whatever the run of stars", () => {
    expect(parseBanner("/*! lodash v4.17.21 */")).toContainEqual({
      name: "lodash",
      version: "4.17.21",
      shape: "name-version",
    });
    const started = Date.now();
    parseBanner(`/*${"*".repeat(100_000)}x`);
    parseBanner(`/*${"*".repeat(100_000)}*/`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a React build file inside a folder belongs to the folder's package", () => {
    for (const file of [
      "use-sync-external-store-shim/with-selector.production.js",
      "use-sync-external-store-shim.production.js",
      "use-sync-external-store-with-selector.production.js",
    ])
      expect(parseBanner(`/**\n * @license React\n * ${file}\n */`)).toEqual([
        { name: "use-sync-external-store", version: null, shape: "file-name" },
      ]);
  });

  test("React 17 banners give the version to the file's package", () => {
    expect(parseBanner("/** @license React v17.0.2\n * react-dom.production.min.js */")).toEqual([
      { name: "react-dom", version: "17.0.2", shape: "file-name" },
    ]);
  });

  test("copyright years, license names and prose never become packages", () => {
    expect(parseBanner("/*! Copyright 2008-2026 Someone. Licensed MIT 2.0 */")).toEqual([]);
    expect(parseBanner("/*! @license Copyright 2010-2024 Three.js Authors */")).toEqual([]);
    expect(parseBanner("/*! Version 1.2.3 */")).toEqual([]);
  });

  test("findBanners keeps legal comments only, with their positions", () => {
    const code =
      "var a=1;/* plain */\n/*! keep v1.0.0 */var b;/** @license other 2.0.0 */\n//! line\n";
    expect(findBanners(code).map((b) => [b.index, b.text])).toEqual([
      [20, "/*! keep v1.0.0 */"],
      [44, "/** @license other 2.0.0 */"],
      [72, "//! line"],
    ]);
  });
});

describe("signatures", () => {
  test("every file in signatures/ is loaded, and each one compiles", () => {
    const dir = fileURLToPath(new URL("../src/detect/signatures/", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(SIGNATURE_FILES).toHaveLength(files.length);
    const names = new Set(compileSignatures().map((p) => p.package));
    for (const file of files) expect(names).toContain(file.replace(/\.json$/, ""));
  });

  const patterns = compileSignatures();

  test("a version string needs its anchors nearby", () => {
    const lodash = 'H.VERSION="4.17.21",un(["bind","bindKey","curry","curryRight"])';
    expect(matchSignatures(lodash, "js", patterns)).toMatchObject([
      { package: "lodash", version: "4.17.21", patternId: "lodash-version" },
    ]);
    // The same assignment with no lodash around it, and a bare version string, count for nothing.
    expect(matchSignatures('config.VERSION="4.17.21"', "js", patterns)).toEqual([]);
    expect(matchSignatures('var release="4.17.21";', "js", patterns)).toEqual([]);
  });

  test("anchors far outside the window do not count", () => {
    const far = `x.VERSION="4.17.21";${" ".repeat(5000)}bindKey`;
    expect(matchSignatures(far, "js", patterns)).toEqual([]);
  });

  test("minifier backticks count as quotes", () => {
    const react =
      "e.useDeferredValue=function(){},e.useTransition=function(){return T.H.useTransition()},e.version=`19.3.1`";
    expect(matchSignatures(react, "js", patterns)).toMatchObject([
      { package: "react", version: "19.3.1" },
    ]);
  });

  test("templates turn a partial capture into a range", () => {
    const three = "window.__THREE__=`187`";
    expect(matchSignatures(three, "js", patterns)).toMatchObject([
      { package: "three", version: "0.187.x" },
    ]);
  });

  test("CSS-only signatures only run on CSS, and mark build tools as dev", () => {
    const css =
      "/*! tailwindcss v3.4.17 | MIT License | https://tailwindcss.com */*,:before{--tw-ring-offset-shadow:0 0 #0000;--tw-shadow:0 0 #0000}";
    expect(matchSignatures(css, "js", patterns)).toEqual([]);
    const hits = matchSignatures(css, "css", patterns);
    expect(hits.map((h) => [h.package, h.version, h.dev])).toEqual([
      ["tailwindcss", "3.4.17", true],
      ["tailwindcss", null, true],
    ]);
  });

  test("real-world shapes from published builds", () => {
    const samples: [string, string, string | null][] = [
      [
        'var t="3.7.1",l=/HTML$/i,ce=function(e,t){};ce.fn=ce.prototype={jquery:t,constructor:ce}',
        "jquery",
        "3.7.1",
      ],
      [
        'ut.CancelToken=at,ut.isCancel=Re,ut.VERSION="1.8.1",ut.toFormData=X,ut.AxiosError=z',
        "axios",
        "1.8.1",
      ],
      [
        'v("x",function(e,t,n){}),_.version="2.30.1",H=R,_.fn=u;function isMoment(e){}',
        "moment",
        "2.30.1",
      ],
      [
        'static overrides=re;static registry=en;static version="4.4.8";static getChart=Dn',
        "chart.js",
        "4.4.8",
      ],
      ['t.utcYear=ev,t.utcYears=rv,t.version="7.9.0",t.scaleLinear=x', "d3", "7.9.0"],
      [
        'class Tt{constructor(t,e={}){this.version="12.4.7",this.canTrackVelocity=null}}',
        "framer-motion",
        "12.4.7",
      ],
      [
        '(u.versions||(u.versions=[])).push({version:"3.41.0",mode:n?"pure":"global",copyright:"© 2014-2025 Denis Pushkarev (zloirock.ru)"})',
        "core-js",
        "3.41.0",
      ],
      ["(window.__svelte||={v:new Set}).v.add(`5`)", "svelte", "5.x"],
      ["sa(e){return`__vccOpts`in e}var ca=(e,t)=>qt(e,t),la=`3.5.44`,ua=void 0", "vue", "3.5.44"],
      [
        "var qh={bundleType:0,version:`19.3.1`,rendererPackageName:`react-dom`,currentDispatcherRef:l}",
        "react-dom",
        "19.3.1",
      ],
      ["Nn.version=yn.version=sr.version=`3.15.0`,fe=1,V.Power0,V.Power1", "gsap", "3.15.0"],
      [
        "var x=`$isDayjsObject`,S=function(e){return e instanceof O||!(!e||!e[x])};var s=`Invalid Date`",
        "dayjs",
        null,
      ],
    ];
    for (const [code, name, version] of samples) {
      const hits = matchSignatures(code, "js", patterns).filter((h) => h.package === name);
      expect(hits[0]?.version, name).toBe(version);
    }
  });
});

const ev = (overrides: Partial<Evidence> & Pick<Evidence, "id" | "package">): Evidence => ({
  version: null,
  signal: "banner",
  strength: "strong",
  trusted: false,
  location: { file: "https://site.test/app.js", bodyHash: "h", offset: null, length: null },
  bytes: 0,
  pages: [],
  excerpt: null,
  dev: false,
  parents: [],
  ...overrides,
});

describe("mergeEvidence", () => {
  test("any exact signal is high; two independent strong signals are high; one is medium", () => {
    const merged = mergeEvidence([
      ev({ id: "a", package: "exact", strength: "exact", signal: "cdn-url", version: "1.0.0" }),
      ev({ id: "b", package: "two", signal: "banner", version: "2.0.0" }),
      ev({ id: "c", package: "two", signal: "version-string", version: "2.0.0" }),
      ev({ id: "d", package: "one", signal: "banner", version: "3.0.0" }),
      ev({ id: "e", package: "one", signal: "banner", version: "3.0.0" }),
      ev({ id: "f", package: "weak", strength: "weak" }),
      ev({ id: "g", package: "marker", strength: "name-only", signal: "framework-marker" }),
    ]);
    const confidence = Object.fromEntries(merged.map((p) => [p.name, p.confidence]));
    expect(confidence).toEqual({
      exact: "high",
      two: "high",
      one: "medium",
      weak: "low",
      marker: "low",
    });
  });

  test("the strongest signal's version wins, and disagreements are recorded", () => {
    const [pkg] = mergeEvidence([
      ev({ id: "a", package: "lib", signal: "banner", version: "1.0.0" }),
      ev({
        id: "b",
        package: "lib",
        signal: "sourcemap-path",
        strength: "exact",
        version: "1.2.0",
      }),
    ]);
    expect(pkg?.version).toBe("1.2.0");
    expect(pkg?.disagreements).toEqual(["1.0.0"]);
  });

  test("between equally strong versions, the one covering the most bytes wins", () => {
    const [pkg] = mergeEvidence([
      ev({
        id: "a",
        package: "lib",
        strength: "exact",
        signal: "cdn-url",
        version: "1.0.0",
        bytes: 100,
        pages: ["index"],
      }),
      ev({
        id: "b",
        package: "lib",
        strength: "exact",
        signal: "cdn-url",
        version: "2.0.0",
        bytes: 900,
        pages: ["about"],
      }),
    ]);
    expect(pkg?.version).toBe("2.0.0");
    expect(pkg?.versions.map((v) => [v.version, v.bytes, v.pages])).toEqual([
      ["2.0.0", 900, ["about"]],
      ["1.0.0", 100, ["index"]],
    ]);
  });

  test("an x-range agrees with an exact version inside it", () => {
    const [pkg] = mergeEvidence([
      ev({
        id: "a",
        package: "three",
        signal: "version-string",
        trusted: true,
        version: "0.187.x",
      }),
      ev({ id: "b", package: "three", signal: "banner", version: "0.187.0" }),
    ]);
    expect(pkg?.version).toBe("0.187.0");
    expect(pkg?.disagreements).toEqual([]);
  });

  test("react-dom implies react at the same version; next implies both", () => {
    const merged = mergeEvidence([
      ev({
        id: "a",
        package: "react-dom",
        strength: "exact",
        signal: "runtime",
        version: "18.3.1",
        trusted: true,
      }),
      ev({
        id: "b",
        package: "next",
        strength: "exact",
        signal: "runtime",
        version: "15.0.0",
        trusted: true,
      }),
    ]);
    const react = merged.find((p) => p.name === "react");
    expect(react).toMatchObject({
      version: "18.3.1",
      versionSource: "implied",
      confidence: "high",
    });
    expect(react?.impliedBy.sort()).toEqual(["next", "react-dom"]);
    expect(merged.find((p) => p.name === "react-dom")?.impliedBy).toEqual(["next"]);
  });
});

describe("registry", () => {
  const info = trimPackument({
    name: "lib",
    "dist-tags": { latest: "2.0.0" },
    versions: {
      "1.0.0": { dependencies: { dep: "^1" } },
      "1.1.0": {},
      "2.0.0-beta.1": {},
      "2.0.0": {},
    },
    time: {
      created: "2020-01-01T00:00:00.000Z",
      "1.0.0": "2020-01-01T00:00:00.000Z",
      "1.1.0": "2021-01-01T00:00:00.000Z",
      "2.0.0-beta.1": "2021-06-01T00:00:00.000Z",
      "2.0.0": "2022-01-01T00:00:00.000Z",
    },
  });

  test("trimPackument keeps versions, dependency names and publish times", () => {
    expect(info.versions["1.0.0"]).toEqual({ dependencies: ["dep"] });
    expect(info.time).not.toHaveProperty("created");
    expect(info.latest).toBe("2.0.0");
  });

  test("name-only packages resolve to the newest stable version before Last-Modified", () => {
    expect(resolveVersion(info, new Date("2021-12-31T00:00:00Z"))).toBe("1.1.0");
    expect(resolveVersion(info, new Date("2023-01-01T00:00:00Z"))).toBe("2.0.0");
    // Older than every release: the oldest one is the best guess.
    expect(resolveVersion(info, new Date("2019-01-01T00:00:00Z"))).toBe("1.0.0");
    expect(resolveVersion(info, null)).toBe("2.0.0");
    expect(resolveVersion(info, new Date("2023-01-01T00:00:00Z"), "1.x")).toBe("1.1.0");
  });

  test("responses are cached on disk, and 404s are cached too", async () => {
    const calls: string[] = [];
    const fake: FetchLike = async (url) => {
      calls.push(url);
      if (url.includes("missing")) return new Response("{}", { status: 404 });
      if (url.includes("downloads")) return Response.json({ downloads: 42 });
      return Response.json({ name: "lib", versions: { "1.0.0": {} }, time: {} });
    };
    const cacheDir = path.join(tmp, "cache");
    const first = new Registry({ cacheDir, fetch: fake });
    expect(await first.packageInfo("lib")).toMatchObject({ name: "lib" });
    expect(await first.packageInfo("missing")).toBeNull();
    expect(await first.weeklyDownloads("lib")).toBe(42);
    expect(await first.packageInfo("@scope/pkg")).toMatchObject({ name: "lib" });
    expect(calls).toContain("https://registry.npmjs.org/@scope%2Fpkg");

    const second = new Registry({ cacheDir, fetch: fake });
    expect(await second.packageInfo("lib")).toMatchObject({ name: "lib" });
    expect(await second.packageInfo("missing")).toBeNull();
    expect(second.requests).toBe(0);
    expect(calls).toHaveLength(4);
    const cached = JSON.parse(await readFile(path.join(cacheDir, "lib.json"), "utf8"));
    expect(cached.value.name).toBe("lib");
  });
});

describe("checkPackages", () => {
  const packuments: Record<string, unknown> = {
    real: {
      name: "real",
      versions: { "1.0.0": { dependencies: { inner: "^1" } }, "1.1.0": {} },
      time: { "1.0.0": "2020-01-01T00:00:00Z", "1.1.0": "2024-01-01T00:00:00Z" },
    },
    inner: { name: "inner", versions: { "1.0.0": {} }, time: { "1.0.0": "2019-01-01T00:00:00Z" } },
    obscure: { name: "obscure", versions: { "2.0.0": {} }, time: {} },
  };
  const fake: FetchLike = async (url) => {
    if (url.includes("downloads"))
      return Response.json({ downloads: url.endsWith("/obscure") ? 3 : 50_000 });
    const name = decodeURIComponent(url.split("/").at(-1) ?? "");
    const doc = packuments[name];
    return doc ? Response.json(doc) : new Response("{}", { status: 404 });
  };

  test("untrusted names must exist and pass the popularity floor; trusted ones need not", async () => {
    const merged = mergeEvidence([
      ev({ id: "a", package: "real", version: "1.0.0" }),
      ev({ id: "b", package: "obscure", version: "2.0.0" }),
      ev({ id: "c", package: "ghost", version: "1.0.0" }),
      ev({
        id: "d",
        package: "inner",
        signal: "sourcemap-path",
        strength: "strong",
        trusted: true,
      }),
      ev({ id: "e", package: "real", signal: "version-string", version: "9.9.9", trusted: false }),
    ]);
    const registry = new Registry({ cacheDir: path.join(tmp, "check"), fetch: fake });
    await checkPackages(merged, {
      registry,
      popularityFloor: 1000,
      cutoffOf: () => new Date("2022-01-01T00:00:00Z"),
      warn: () => {},
    });
    const by = Object.fromEntries(merged.map((p) => [p.name, p]));
    expect(by.real?.registry?.status).toBe("passed");
    // 9.9.9 is not published; the next candidate the evidence offered is.
    expect(by.real?.version).toBe("1.0.0");
    expect(by.obscure?.registry).toMatchObject({ status: "failed", weeklyDownloads: 3 });
    expect(by.obscure?.confidence).toBe("low");
    expect(by.ghost?.registry).toMatchObject({ status: "failed", exists: false });
    expect(by.inner).toMatchObject({ version: "1.0.0", versionSource: "inferred" });
    expect(by.inner?.transitiveOf).toEqual(["real"]);
  });

  test("an inferred parent steps back to the release that still depended on a detected orphan", async () => {
    // Sentry 11 renamed @sentry-internal/browser-utils; a bundle holding it is on Sentry 10.
    const docs: Record<string, unknown> = {
      "@s/browser": {
        name: "@s/browser",
        versions: {
          "10.0.0": { dependencies: { "@s-internal/utils": "10.0.0", "@s/core": "10.0.0" } },
          "11.0.0": { dependencies: { "@s/utils": "11.0.0", "@s/core": "11.0.0" } },
        },
        time: { "10.0.0": "2025-01-01T00:00:00Z", "11.0.0": "2025-06-01T00:00:00Z" },
      },
      "@s-internal/utils": {
        name: "@s-internal/utils",
        versions: { "10.0.0": { dependencies: { "@s/core": "10.0.0" } } },
        time: { "10.0.0": "2025-01-01T01:00:00Z" },
      },
      "@s/core": {
        name: "@s/core",
        versions: { "10.0.0": {}, "11.0.0": {} },
        time: { "10.0.0": "2025-01-01T00:00:00Z", "11.0.0": "2025-06-01T00:00:00Z" },
      },
      clsx: {
        name: "clsx",
        versions: { "2.0.0": {} },
        time: { "2.0.0": "2025-03-01T00:00:00Z" },
      },
    };
    const fetchDocs: FetchLike = async (url) => {
      if (url.includes("downloads")) return Response.json({ downloads: 50_000 });
      const name = decodeURIComponent(url.split("/").at(-1) ?? "");
      const doc = docs[name];
      return doc ? Response.json(doc) : new Response("{}", { status: 404 });
    };
    const path_ = (id: string, name: string) =>
      ev({ id, package: name, signal: "sourcemap-path", strength: "strong", trusted: true });
    const merged = mergeEvidence([
      path_("a", "@s/browser"),
      path_("b", "@s-internal/utils"),
      path_("c", "@s/core"),
      path_("d", "clsx"),
    ]);
    await checkPackages(merged, {
      registry: new Registry({ cacheDir: path.join(tmp, "lockstep"), fetch: fetchDocs }),
      popularityFloor: 1000,
      cutoffOf: () => new Date("2025-12-01T00:00:00Z"),
      warn: () => {},
    });
    const by = Object.fromEntries(merged.map((p) => [p.name, p]));
    expect(by["@s/browser"]?.version).toBe("10.0.0");
    expect(by["@s/core"]?.version).toBe("10.0.0");
    expect(by["@s-internal/utils"]?.transitiveOf).toEqual(["@s/browser"]);
    // An unrelated orphan released months apart from any parent moves nothing.
    expect(by.clsx?.version).toBe("2.0.0");
  });

  test("offline, nothing is fetched; untrusted names fail and trusted ones are skipped", async () => {
    const merged = mergeEvidence([
      ev({ id: "a", package: "text-only", version: "1.0.0" }),
      ev({
        id: "b",
        package: "structural",
        signal: "cdn-url",
        strength: "exact",
        trusted: true,
        version: "1.0.0",
      }),
    ]);
    await checkPackages(merged, {
      registry: null,
      popularityFloor: 1000,
      cutoffOf: () => null,
      warn: () => {},
    });
    expect(merged.find((p) => p.name === "text-only")?.registry?.status).toBe("failed");
    expect(merged.find((p) => p.name === "structural")?.registry?.status).toBe("skipped");
    expect(merged.find((p) => p.name === "structural")?.version).toBe("1.0.0");
  });
});

describe("findModules", () => {
  test("webpack module maps, in both property and method form", () => {
    const code =
      '(self.c=self.c||[]).push([[1],{12:(e,t,n)=>{n.x=1},34(e,t){t.y=2},"./a.js"(e){}}]);';
    const layout = findModules(code);
    expect(layout.factories.map((f) => [f.kind, f.id])).toEqual([
      ["webpack-module", "12"],
      ["webpack-module", "34"],
      ["webpack-module", "./a.js"],
    ]);
  });

  test("plain objects with methods are not module maps", () => {
    const code = "var d={tick:function(){m()},wake:function(){n()}};var o={get(){},set(){}};";
    expect(findModules(code).factories).toEqual([]);
  });

  test("CommonJS wrappers need a helper used more than once, at the top level", () => {
    const code =
      "var h=e=>e;var a=h((e,t)=>{var inner=g(function(){})}),b=h((e,t)=>{});var c=once(function(){});";
    const layout = findModules(code);
    expect(layout.factories.map((f) => [f.kind, f.id, f.leaf])).toEqual([
      ["cjs-wrapper", "a", true],
      ["cjs-wrapper", "b", true],
    ]);
  });

  test("a module that holds other modules is a scope, not a leaf", () => {
    const code =
      "push({1(e,t,n){var r=n.cw((e,t)=>{dep()}),s=n.cw((e,t)=>{dep2()});app()},2(e){}})";
    const layout = findModules(code);
    const outer = layout.factories.find((f) => f.id === "1");
    expect(outer?.leaf).toBe(false);
    expect(moduleAt(layout, code.indexOf("dep()"))?.id).toBe("r");
    expect(moduleAt(layout, code.indexOf("app()"))?.id).toBe("1");
  });

  test("esbuild's __commonJS object form", () => {
    const code = 'var r=__commonJS({"node_modules/x/index.js"(e,t){t.exports=1}});';
    expect(findModules(code).factories.map((f) => [f.kind, f.id])).toEqual([
      ["esbuild-cjs", "node_modules/x/index.js"],
    ]);
  });
});

describe("project", () => {
  test("projectName turns the host into a package name", () => {
    expect(projectName("https://www.Example.co.uk/shop")).toBe("example-co-uk");
    expect(projectName("http://127.0.0.1:8080/")).toBe("127-0-0-1");
  });

  test("versionSpec pins exactly by default", () => {
    expect(versionSpec("18.3.1", "exact")).toBe("18.3.1");
    expect(versionSpec("18.3.1", "caret")).toBe("^18.3.1");
    expect(versionSpec("0.187.x", "caret")).toBe("0.187.x");
    expect(versionSpec(null, "exact")).toBe("latest");
  });

  test("every install command disables scripts", () => {
    expect(installCommand("pnpm", "10.0.0").args).toContain("--ignore-scripts");
    expect(installCommand("npm", "10.0.0").args).toContain("--ignore-scripts");
    expect(installCommand("bun", "1.1.0").args).toContain("--ignore-scripts");
    expect(installCommand("yarn", "1.22.22").args).toContain("--ignore-scripts");
    const berry = installCommand("yarn", "4.5.0");
    expect(berry.args).not.toContain("--ignore-scripts");
    expect(berry.env.YARN_ENABLE_SCRIPTS).toBe("false");
    for (const pm of ["pnpm", "npm", "yarn", "bun"] as const)
      expect(installCommand(pm, "1.0.0").env.npm_config_ignore_scripts).toBe("true");
  });

  test("chooseManager: flag, then source-map hint, then the first installed", () => {
    const only = (installed: string[]) => (pm: string) =>
      installed.includes(pm) ? "1.0.0" : undefined;
    expect(chooseManager("yarn", "pnpm", only([]))).toMatchObject({ name: "yarn", source: "flag" });
    expect(chooseManager(undefined, "pnpm", only([]))).toMatchObject({
      name: "pnpm",
      source: "sourcemap-hint",
    });
    expect(chooseManager(undefined, undefined, only(["npm", "yarn"]))).toMatchObject({
      name: "yarn",
      source: "installed",
    });
    expect(chooseManager(undefined, undefined, only(["bun", "npm"]))).toMatchObject({
      name: "bun",
    });
    expect(chooseManager(undefined, undefined, only([]))).toMatchObject({
      name: "npm",
      source: "default",
      version: undefined,
    });
  });
});

test("ByteIndex maps string indices to UTF-8 offsets", () => {
  const text = "a€b😀c";
  const index = new ByteIndex(text);
  expect(index.bytes(1)).toBe(1);
  expect(index.bytes(2)).toBe(4);
  expect(index.bytes(5)).toBe(9);
  expect(index.bytes(3)).toBe(5);
});

describe("review regressions", () => {
  test("a renderer package named by the page's devtools hook is untrusted", async () => {
    const dir = path.join(tmp, "runtime-ws");
    const paths = workspacePaths(dir);
    await mkdir(path.dirname(paths.runtime), { recursive: true });
    await writeFile(
      paths.runtime,
      JSON.stringify([
        {
          page: "index",
          url: "https://site.test/",
          frameworks: {
            react: { version: "18.3.1" },
            reactDevtoolsRenderers: [{ version: "1.0.0", rendererPackageName: "evil-pkg" }],
            angular: { version: "1.8.2", legacy: true },
          },
        },
      ]),
    );
    const evidence = await collectRuntime(await loadContext(paths));
    expect(evidence.map((e) => [e.package, e.trusted])).toEqual([
      ["react", true],
      ["angular", true],
      ["evil-pkg", false],
    ]);
  });

  test("an HTML answer or an unwritable cache never fails the registry client badly", async () => {
    const html: FetchLike = async () => new Response("<html>portal</html>", { status: 200 });
    const registry = new Registry({ cacheDir: path.join(tmp, "html-cache"), fetch: html });
    await expect(registry.packageInfo("lib")).rejects.toBeInstanceOf(RegistryError);

    // A file where the cache folder should be: writes fail, answers still come back.
    const blocked = path.join(tmp, "blocked");
    await writeFile(blocked, "not a folder");
    const ok: FetchLike = async () => Response.json({ name: "lib", versions: {}, time: {} });
    const cached = new Registry({ cacheDir: path.join(blocked, "registry"), fetch: ok });
    expect(await cached.packageInfo("lib")).toMatchObject({ name: "lib" });
  });

  test("an interrupt is rethrown, not reported as an unreachable registry", async () => {
    const controller = new AbortController();
    // Like fetch: rejects at once on a signal that already fired, or when it fires later.
    const hang: FetchLike = (_url, init) =>
      new Promise((_, reject) => {
        if (init?.signal?.aborted) reject(new Error("aborted"));
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const registry = new Registry({
      cacheDir: path.join(tmp, "abort-cache"),
      fetch: hang,
      signal: controller.signal,
    });
    const merged = mergeEvidence([ev({ id: "a", package: "lib", version: "1.0.0" })]);
    const pending = checkPackages(merged, {
      registry,
      popularityFloor: 1000,
      cutoffOf: () => null,
      warn: () => {},
    });
    controller.abort();
    await expect(pending).rejects.not.toBeInstanceOf(RegistryError);
  });
});

describe("fingerprint vendor ranges", () => {
  test("cover accepted packages only, in UTF-8 bytes", async () => {
    const text = `${"a".repeat(100)}é${"b".repeat(100)}`;
    const ctx = {
      paths: workspacePaths(path.join(tmpdir(), "no-such-workspace")),
      records: [],
      licenseFiles: [],
      assets: [
        {
          hash: "h",
          kind: "js",
          urls: ["https://x/app.js"],
          origin: "first-party",
          size: 202,
          pages: [],
          lastModified: null,
        },
      ],
      text: async () => text,
      readJson: async () => undefined,
    } as unknown as DetectContext;
    const bundles = await vendorRanges({
      ctx,
      evidence: [],
      accepted: new Map([["p", "1.2.3"]]),
      fingerprints: new Map([
        [
          "h",
          [
            { package: "p", start: 10, end: 150, evidence: "fingerprints:0" },
            { package: "q", start: 160, end: 190, evidence: "fingerprints:1" },
          ],
        ],
      ]),
    });
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.ranges).toEqual([
      {
        package: "p",
        version: "1.2.3",
        start: 10,
        end: 151,
        method: "fingerprint",
        module: null,
        evidence: ["fingerprints:0"],
      },
    ]);
  });
});
