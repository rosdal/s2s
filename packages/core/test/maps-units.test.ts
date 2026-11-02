import { describe, expect, test } from "vitest";
import { coverageOf, share } from "../src/maps/coverage.js";
import { projectHints } from "../src/maps/hints.js";
import { inlineMap, loadMap, MapError, parseMapText } from "../src/maps/load.js";
import { detectPackageManager, parseVendorPath } from "../src/maps/packages.js";
import {
  findProjectRoot,
  joinSourceRoot,
  normalizeSource,
  relativeTo,
  vendorPath,
} from "../src/maps/paths.js";
import { lineStartsOf, renameFromMap, shiftPosition } from "../src/maps/rename.js";
import { summaryLine } from "../src/maps/run.js";

const norm = (raw: string) => {
  const result = normalizeSource(raw);
  return result.ok ? [result.kind, result.path, result.absolute] : ["rejected", result.reason];
};

describe("normalizeSource", () => {
  test.each([
    ["webpack://my-app/./src/index.js", "first-party", "src/index.js", false],
    ["webpack:///./src/index.js", "first-party", "src/index.js", false],
    [
      "webpack://my-app/webpack/runtime/load script",
      "virtual",
      "webpack/runtime/load script",
      false,
    ],
    ["webpack://my-app/webpack/bootstrap", "virtual", "webpack/bootstrap", false],
    ['webpack://my-app/external "react"', "virtual", "external _react_", false],
    ["webpack://my-app/./src/a.css?1234", "first-party", "src/a.css", false],
    ["../../src/main.js", "first-party", "src/main.js", false],
    ["./src/main.js", "first-party", "src/main.js", false],
    ["/@fs/home/ci/app/src/x.ts", "first-party", "home/ci/app/src/x.ts", true],
    ["vite:src/x.ts", "first-party", "src/x.ts", false],
    ["vite/modulepreload-polyfill.js", "virtual", "vite/modulepreload-polyfill.js", false],
    ["\0vite/preload-helper.js", "virtual", "vite/preload-helper.js", false],
    ["\0rolldown/runtime.js", "virtual", "rolldown/runtime.js", false],
    ["\0commonjsHelpers.js", "virtual", "commonjsHelpers.js", false],
    ["C:\\build\\app\\src\\x.js", "first-party", "build/app/src/x.js", true],
    ["file:///home/me/app/src/x.js", "first-party", "home/me/app/src/x.js", true],
    ["file:///C:/work/site/src/a.scss", "first-party", "work/site/src/a.scss", true],
    ["https://example.com/src/x.js", "first-party", "src/x.js", false],
    ["../../node_modules/react/index.js", "vendor", "node_modules/react/index.js", false],
    ["src/a/../b.js", "first-party", "src/b.js", false],
    ["src/con.js", "first-party", "src/_con.js", false],
    ["src/what?.js", "first-party", "src/what", false],
  ])("%s", (raw, kind, path, absolute) => {
    expect(norm(raw)).toEqual([kind, path, absolute]);
  });

  test("rejects paths that climb past a real segment, and empty paths", () => {
    expect(norm("src/../../../etc/passwd")[0]).toBe("rejected");
    expect(norm("a/../../b.js")[0]).toBe("rejected");
    expect(norm("")[0]).toBe("rejected");
    expect(norm("../..")[0]).toBe("rejected");
    expect(norm("webpack:///src/..%5C..%5C..%5Cevil.js")[0]).toBe("rejected");
    expect(norm("src/..%5Cx.js")).toEqual(["first-party", "x.js", false]);
    expect(norm("src/\u0001x.js")[0]).toBe("rejected");
  });

  test("joins sourceRoot without resolving dots", () => {
    expect(joinSourceRoot("webpack://ns/", "./a.js")).toBe("webpack://ns/./a.js");
    expect(joinSourceRoot("../src", "a.js")).toBe("../src/a.js");
    expect(joinSourceRoot(undefined, "a.js")).toBe("a.js");
    expect(joinSourceRoot("root", "/abs.js")).toBe("/abs.js");
  });
});

describe("findProjectRoot", () => {
  const rel = (...paths: string[]) => paths.map((path) => ({ path, absolute: false }));
  const abs = (...paths: string[]) => paths.map((path) => ({ path, absolute: true }));
  const root = (paths: { path: string; absolute: boolean }[]) => findProjectRoot(paths);
  test("cuts before src, or else the first source folder", () => {
    expect(root(abs("home/ci/app/src/a.js", "home/ci/app/src/b/c.js")).absolute).toBe(
      "home/ci/app",
    );
    expect(root(abs("home/ci/shop/app/page.tsx", "home/ci/shop/app/x/page.tsx")).absolute).toBe(
      "home/ci/shop",
    );
    expect(root(rel("src/a.js", "src/b.js")).relative).toBe("");
    expect(root(rel("src/components/a.js", "src/components/b.js")).relative).toBe("");
  });
  test("keeps the full common folder for absolute paths without a source folder", () => {
    expect(root(abs("Users/me/proj/index.js", "Users/me/proj/util.js")).absolute).toBe(
      "Users/me/proj",
    );
  });
  test("treats relative paths as project-relative, and roots each group on its own", () => {
    expect(root(rel("components/a.js", "components/b.js")).relative).toBe("");
    expect(root([])).toEqual({ absolute: "", relative: "" });
    expect(
      root([...abs("C/work/site/src/styles/a.scss"), ...rel("src/components/b.module.css")]),
    ).toEqual({ absolute: "C/work/site", relative: "" });
  });
  test("relativeTo and vendorPath", () => {
    expect(relativeTo("home/ci/app", "home/ci/app/src/a.js")).toBe("src/a.js");
    expect(relativeTo("", "src/a.js")).toBe("src/a.js");
    expect(vendorPath("x/node_modules/react/index.js")).toBe("node_modules/react/index.js");
    expect(vendorPath(".yarn/cache/a.zip/node_modules/a/i.js")).toBe(
      ".yarn/cache/a.zip/node_modules/a/i.js",
    );
  });
});

describe("parseVendorPath", () => {
  test.each([
    ["node_modules/react/index.js", "react", null, null, "node_modules"],
    [
      "node_modules/@tanstack/query-core/build/a.js",
      "@tanstack/query-core",
      null,
      null,
      "node_modules",
    ],
    [
      "node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs",
      "clsx",
      "2.1.1",
      null,
      "pnpm",
    ],
    [
      "node_modules/.pnpm/@babel+runtime@7.24.0/node_modules/@babel/runtime/helpers/a.js",
      "@babel/runtime",
      "7.24.0",
      null,
      "pnpm",
    ],
    [
      "node_modules/.pnpm/react-dom@18.2.0_react@18.2.0/node_modules/react-dom/index.js",
      "react-dom",
      "18.2.0",
      null,
      "pnpm",
    ],
    [
      "node_modules/.pnpm/next@15.0.0(react@19.0.0)/node_modules/next/dist/a.js",
      "next",
      "15.0.0",
      null,
      "pnpm",
    ],
    [
      ".yarn/cache/lodash-npm-4.17.21-6382451519-eb835a2e51.zip/node_modules/lodash/lodash.js",
      "lodash",
      "4.17.21",
      null,
      "yarn-pnp",
    ],
    [
      ".yarn/cache/@emotion-react-npm-11.11.1-beta.2-abcdef1234-0123456789.zip/node_modules/@emotion/react/a.js",
      "@emotion/react",
      "11.11.1-beta.2",
      null,
      "yarn-pnp",
    ],
    ["node_modules/a/node_modules/b/index.js", "b", null, "a", "node_modules"],
    ["node_modules/.pnpm/a@1.0.0/node_modules/a/node_modules/b/index.js", "b", null, "a", "pnpm"],
  ])("%s", (path, name, version, parent, layout) => {
    expect(parseVendorPath(path)).toEqual({ name, version, parent, layout });
  });

  test("ignores tool caches and paths without a file", () => {
    expect(parseVendorPath("node_modules/.vite/deps/react.js")).toBeUndefined();
    expect(parseVendorPath("node_modules/react")).toBeUndefined();
  });

  test("detects the package manager", () => {
    expect(detectPackageManager([])).toBeUndefined();
    expect(detectPackageManager([{ layout: "pnpm", path: "x" }])?.value).toBe("pnpm");
    expect(detectPackageManager([{ layout: "yarn-pnp", path: "x" }])?.value).toBe("yarn");
    expect(detectPackageManager([{ layout: "node_modules", path: "x" }])).toMatchObject({
      value: "npm",
      confidence: 0.4,
    });
  });
});

describe("loadMap", () => {
  test("accepts a plain map and strips the XSSI prefix", () => {
    const map = loadMap(
      parseMapText(
        `)]}'\n{"version":3,"sources":["a.js"],"sourcesContent":["x"],"names":[],"mappings":"AAAA"}`,
      ),
    );
    expect(map.sources).toEqual(["a.js"]);
    expect(map.mappings[0]).toEqual([[0, 0, 0, 0]]);
  });

  test("flattens index maps with offsets", () => {
    const map = loadMap({
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: { version: 3, sources: ["a.js"], names: [], mappings: "AAAA" },
        },
        {
          offset: { line: 1, column: 4 },
          map: {
            version: 3,
            sources: ["b.js"],
            sourcesContent: ["b"],
            names: ["n"],
            mappings: "AAAAA",
          },
        },
      ],
    });
    expect(map.sources).toEqual(["a.js", "b.js"]);
    expect(map.sourcesContent).toEqual([null, "b"]);
    expect(map.mappings[1]).toEqual([[4, 1, 0, 0, 0]]);
  });

  test.each([
    ["{", /not valid JSON/],
    ["[]", /not a JSON object/],
    ['{"version":2,"sources":[],"mappings":""}', /unsupported version/],
    ['{"version":3,"sources":["a"],"mappings":"!!"}', /outside base64/],
    ['{"version":3,"sources":["a"],"mappings":"AOAA"}', /reference source 7/],
    ['{"version":3,"sources":["a"],"names":[],"mappings":"AAAAC"}', /reference name 1/],
    ['{"version":3,"mappings":""}', /sources/],
  ])("rejects %s", (text, reason) => {
    expect(() => loadMap(parseMapText(text))).toThrow(MapError);
    expect(() => loadMap(parseMapText(text))).toThrow(reason);
  });

  test("decodes inline data: maps", () => {
    const json = '{"version":3}';
    const b64 = Buffer.from(json).toString("base64");
    expect(inlineMap(`x()\n//# sourceMappingURL=data:application/json;base64,${b64}`)).toBe(json);
    expect(
      inlineMap(`a{}\n/*# sourceMappingURL=data:application/json,${encodeURIComponent(json)} */`),
    ).toBe(json);
    expect(inlineMap("x()\n//# sourceMappingURL=x.js.map")).toBeUndefined();
  });
});

describe("coverageOf", () => {
  test("labels bytes by the source each segment points at", () => {
    // Line 1: "ab" unmapped, "cd" from source 0; line 2: "ef" from source 1.
    const map = loadMap({
      version: 3,
      sources: ["a", "b"],
      names: [],
      mappings: "EAAA;ACAA",
    });
    const totals = coverageOf("abcd\nef", map, (i) => (i === 0 ? "exact" : "renamed"));
    expect(totals).toEqual({ total: 7, none: 2, exact: 3, renamed: 2 });
    expect(share(totals)).toBeCloseTo(3 / 7, 4);
  });
  test("leaves the trailing sourceMappingURL comment out", () => {
    const js = "ab\n//# sourceMappingURL=data:application/json;base64,AAAA\n";
    expect(coverageOf(js, undefined, () => "exact")).toEqual({
      total: 2,
      exact: 0,
      renamed: 0,
      none: 2,
    });
    expect(
      coverageOf("a{}\n/*# sourceMappingURL=a.css.map */", undefined, () => "exact").total,
    ).toBe(3);
  });
  test("a file without a map is all none, and counts UTF-8 bytes", () => {
    expect(coverageOf("é\n", undefined, () => "exact")).toEqual({
      total: 3,
      exact: 0,
      renamed: 0,
      none: 3,
    });
    expect(share({ total: 0, exact: 0, renamed: 0, none: 0 })).toBe(0);
  });
});

/** A map naming the identifier at each listed generated position. */
function namesMap(code: string, names: Record<string, string>) {
  const lines = code.split("\n");
  const list = Object.values(names);
  const byLine: [number, number, number, number, number][][] = lines.map(() => []);
  for (const [i, [pos]] of Object.entries(names).entries()) {
    const [line, column] = pos.split(":").map(Number) as [number, number];
    byLine[line - 1]?.push([column, 0, 0, 0, i]);
  }
  return { sources: ["src/a.js"], sourcesContent: [null], names: list, mappings: byLine };
}

describe("renameFromMap", () => {
  test("renames a binding with all its references, including shorthands", () => {
    const code = "(()=>{const a=1;let b={a};function c(d){return d+a}b.x=c(a);})();";
    const map = namesMap(code, { "1:12": "total", "1:35": "add", "1:37": "value" });
    const result = renameFromMap(code, map);
    expect(result.code).toBe(
      "(()=>{const total=1;let b={a: total};function add(value){return value+total}b.x=add(total);})();",
    );
    expect(result.renamed.map((r) => r.to)).toEqual(["total", "add", "value"]);
    expect(result.skipped).toEqual([]);
  });

  test("names come from references when the declaration has none", () => {
    const code = "(()=>{var a=1;console.log(a)})();";
    const result = renameFromMap(code, namesMap(code, { "1:26": "count" }));
    expect(result.code).toBe("(()=>{var count=1;console.log(count)})();");
  });

  test("skips renames that collide, shadow or hit globals", () => {
    const code = "(()=>{var a=1,b=2;function f(){var c=3;return a+c}console.log(f,b)})();";
    const map = namesMap(code, {
      "1:10": "dup", // a -> dup
      "1:14": "dup", // b -> dup: collides with a's new name
      "1:35": "a", // c -> a: inner binding would capture the reference to a? a is renamed to dup first
      "1:27": "console", // f -> console: shadows a global
    });
    const result = renameFromMap(code, map);
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.from, s.reason]));
    expect(reasons.b).toMatch(/collides/);
    expect(reasons.f).toMatch(/global console/);
    expect(result.code).toContain("var dup=1,b=2");
    // c -> a is safe once a has become dup.
    expect(result.code).toContain("var a=3;return dup+a");
  });

  test("refuses to capture a reference with an inner binding", () => {
    const code = "(()=>{var a=1;function f(){var c=2;return a+c}f()})();";
    // Rename c -> a while the outer a keeps its name: the inner `a` would capture the reference.
    const result = renameFromMap(code, namesMap(code, { "1:31": "a" }));
    expect(result.skipped[0]?.reason).toMatch(/shadow|captured/);
    expect(result.code).toBe(code);
  });

  test("leaves exports, script globals, eval and with alone", () => {
    const esm = "export const a=1;const b=2;export{b};";
    const esmResult = renameFromMap(esm, namesMap(esm, { "1:13": "one", "1:23": "two" }));
    expect(esmResult.code).toBe("export const a=1;const two=2;export{two as b};");
    expect(esmResult.skipped[0]?.reason).toMatch(/exported/);

    const script = "var a=1;";
    expect(renameFromMap(script, namesMap(script, { "1:4": "x" })).code).toBe(script);

    const evil = "(()=>{var a=1;eval('a')})();";
    const evilResult = renameFromMap(evil, namesMap(evil, { "1:10": "x" }));
    expect(evilResult.code).toBe(evil);
    expect(evilResult.skipped[0]?.reason).toMatch(/eval/);
  });

  test("renames import specifiers and keeps imported names", () => {
    const code = 'import{x}from"./y.js";import z from"./z.js";console.log(x,z);';
    const result = renameFromMap(code, namesMap(code, { "1:7": "helper", "1:29": "dflt" }));
    expect(result.code).toBe(
      'import{x as helper}from"./y.js";import dflt from"./z.js";console.log(helper,dflt);',
    );
  });

  test("shiftPosition follows edits on the same line only", () => {
    const code = "ab\ncd";
    const starts = lineStartsOf(code);
    const edits = [{ start: 0, end: 1, text: "xyz" }];
    expect(shiftPosition(starts, edits, 1, 1)).toEqual({ line: 1, column: 3 });
    expect(shiftPosition(starts, edits, 2, 1)).toEqual({ line: 2, column: 1 });
  });
});

describe("projectHints", () => {
  test("reads language, framework, styling and aliases", () => {
    const hints = projectHints(
      [
        { path: "src/app/page.tsx", content: 'import { Button } from "@/components/Button";' },
        { path: "src/app/layout.tsx", content: 'import "@/styles/site.scss";' },
        { path: "src/components/Button.tsx", content: "export const Button = 1;" },
        { path: "src/styles/site.scss", content: "@tailwind base;" },
        { path: "src/styles/card.module.css", content: ".a{}" },
        { path: "src/legacy.js", content: "" },
      ],
      ["next", "react"],
      { value: "pnpm", confidence: 0.95, evidence: [] },
    );
    expect(hints.language).toMatchObject({ value: "typescript", confidence: 0.75 });
    expect(hints.framework.map((f) => f.value)).toContain("next-app-router");
    expect(hints.styling.map((s) => s.value)).toEqual(["scss", "css-modules", "tailwind"]);
    expect(hints.aliases).toEqual([expect.objectContaining({ alias: "@/*", target: "src/*" })]);
    expect(hints.packageManager?.value).toBe("pnpm");
  });
  test("a pages/ folder alone is not Next.js", () => {
    const spa = projectHints([{ path: "src/pages/Home.tsx", content: "" }], ["react"], undefined);
    expect(spa.framework.map((f) => f.value)).toEqual(["react"]);
    const next = projectHints(
      [
        { path: "pages/_app.jsx", content: "" },
        { path: "pages/index.jsx", content: "" },
      ],
      [],
      undefined,
    );
    expect(next.framework.map((f) => f.value)).toEqual(["next-pages-router"]);
  });
  test("is empty without sources", () => {
    expect(projectHints([], [], undefined)).toEqual({
      language: null,
      framework: [],
      styling: [],
      aliases: [],
      packageManager: null,
    });
  });
});

describe("summaryLine", () => {
  test("counts, pluralizes and adds the renamed share", () => {
    expect(summaryLine({ maps: 38, sourcesRecovered: 214, coverageJs: 0.7149 })).toBe(
      "38 maps, 214 sources recovered, 71% of first-party JS covered",
    );
    expect(
      summaryLine({ maps: 1, sourcesRecovered: 1, coverageJs: 0.5, coverageJsRenamed: 0.25 }),
    ).toBe("1 map, 1 source recovered, 50% of first-party JS covered (25% more renamed)");
    expect(summaryLine({})).toBe("0 maps, 0 sources recovered, 0% of first-party JS covered");
  });
});
