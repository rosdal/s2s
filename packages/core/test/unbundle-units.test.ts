import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  childSandbox,
  defaultAdapter,
  keepModuleNames,
  plainTemplates,
  trimJsxDev,
  unIndirectCalls,
} from "../src/unbundle/adapter.js";
import { readableName } from "../src/unbundle/assets.js";
import { applyEdits } from "../src/unbundle/ast.js";
import { bundlerPackage, detectChunkBundler, summarizeBundlers } from "../src/unbundle/bundler.js";
import { detectStyling, findClassMaps } from "../src/unbundle/css.js";
import { buildGraph, type GraphInput, specifiersOf } from "../src/unbundle/graph.js";
import { chunkName } from "../src/unbundle/inputs.js";
import { fixDefaultImports } from "../src/unbundle/interop.js";
import { restoreBabel } from "../src/unbundle/legacy.js";
import { changedLines, looksObfuscated, transform } from "../src/unbundle/passes.js";
import { similarity, statementsOf } from "../src/unbundle/similarity.js";
import { FIXTURES_DIR } from "./helpers/fixtures.js";

// Snapshots of each library behind the adapter: an upgrade that changes output shows up here.
describe("library adapter", () => {
  test("deobfuscate resolves javascript-obfuscator's string array through the sandbox", async () => {
    const code = await readFile(
      path.join(FIXTURES_DIR, "obfuscated", "dist", "assets", "app.js"),
      "utf8",
    );
    const out = await defaultAdapter.deobfuscate(code);
    expect(out).toContain('const greetings = ["Hello", "Bonjour", "Hallo", "Ciao"];');
    expect(out).toContain('render(["Ada", "Grace", "Linus"]);');
    expect(out).not.toMatch(/_0x[0-9a-f]+\(0x/);
  });

  test("unminify", async () => {
    const out = await defaultAdapter.unminify(
      "var a=1,b=2;!0&&f(a);function g(){return x?y():void 0}",
    );
    expect(await defaultAdapter.format(out, "babel")).toMatchInlineSnapshot(`
      "var a = 1;
      var b = 2;

      if (true) {
        f(a);
      }

      function g() {
        return x ? y() : void 0;
      }
      "
    `);
  });

  test("detranspile", async () => {
    const out = await defaultAdapter.detranspile(
      'var o; var x = null === (o = a) || void 0 === o ? void 0 : o.b; var s = "".concat(n, " items");',
    );
    expect(await defaultAdapter.format(out, "babel")).toMatchInlineSnapshot(`
      "const x = a?.b;
      const s = \`\${n} items\`;
      "
    `);
  });

  test("jsx", async () => {
    const out = await defaultAdapter.jsx(
      'import * as r from "react"; function A(){ return r.createElement("ul", { className: "x" }, r.createElement("li", null, "One")); }',
    );
    expect(await defaultAdapter.format(out, "babel")).toMatchInlineSnapshot(`
      "import * as r from "react";
      function A() {
        return (
          <ul className="x">
            <li>One</li>
          </ul>
        );
      }
      "
    `);
  });

  test("esm", async () => {
    const out = await defaultAdapter.esm(
      'var c = require("./c.js"); exports.total = function () { return c.n; };',
    );
    expect(await defaultAdapter.format(out, "babel")).toMatchInlineSnapshot(`
      "import c from "./c.js";
      export const total = function () {
        return c.n;
      };
      "
    `);
  });

  test("the sandbox runs code without Node's powers", async () => {
    expect(await childSandbox("[1, 2].map((n) => n * 2)")).toEqual([2, 4]);
    await expect(childSandbox("require('fs')")).rejects.toThrow(/require is not defined/);
    await expect(childSandbox("process.exit(1)")).rejects.toThrow(/process is not defined/);
    await expect(
      childSandbox("this.constructor.constructor('return process')()"),
    ).rejects.toThrow();
  });
});

describe("s2s's own normalizations", () => {
  test("indirect calls lose their `(0, …)` and `Object(…)` wrappers without gluing tokens", () => {
    expect(unIndirectCalls("function s(){return(0,a.b)(1)}")).toBe("function s(){return a.b(1)}");
    expect(unIndirectCalls("x = Object(o.a)(Object(o.b)(f));")).toBe("x = o.a(o.b(f));");
    expect(unIndirectCalls("function Object(){} Object(o.a)(1);")).toContain("Object(o.a)(1)");
  });

  test("template literals without expressions become strings, tagged ones stay", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the strings are code under test.
    expect(plainTemplates("a(`div`, css`x`, `${y}`)")).toBe('a("div", css`x`, `${y}`)');
  });

  test("jsxDEV loses its debug arguments", () => {
    expect(trimJsxDev("n.jsxDEV(`div`,{a:1},void 0,!1,{fileName:b},this)")).toBe(
      "n.jsxDEV(`div`,{a:1})",
    );
    expect(trimJsxDev('jsxDEV(A,{},"k",!1,{},this)')).toBe('jsxDEV(A,{},"k")');
  });

  test("imported and exported names survive a rename", () => {
    const before = 'import { te } from "./a.js"; export { i };';
    const after = 'import { Te } from "./a.js"; export { I };';
    expect(keepModuleNames(before, after)).toBe(
      'import { te as Te } from "./a.js"; export { I as i };',
    );
  });

  test("a rule that orphans a name is rejected", async () => {
    // wakaru's un-parameters can turn a closure's `arguments` into an undeclared `args`.
    const code =
      "function g(t){return r.apply(this,arguments)} var r=function(){var r=this,n=arguments;return n};";
    const out = await defaultAdapter.detranspile(code);
    expect(/\bargs\b/.test(out) ? /\.\.\.args/.test(out) : true).toBe(true);
  });
});

describe("Babel restores", () => {
  const helpers = `
function _typeof(o){return(_typeof="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(o){return typeof o}:function(o){return o&&"function"==typeof Symbol&&o.constructor===Symbol&&o!==Symbol.prototype?"symbol":typeof o})(o)}
function _toConsumableArray(r){if(!Array.isArray(r))throw new TypeError("Invalid attempt to spread non-iterable instance.");return r}
`;
  test("typeof and array spread", () => {
    const out = restoreBabel(
      `${helpers}var a = _typeof(x) === "object"; var b = [].concat(_toConsumableArray(p), [1], _toConsumableArray(q));`,
    );
    expect(out).toContain('(typeof x) === "object"');
    expect(out).toContain("[...p, 1, ...q]");
  });

  test("a class from inlined helpers, with an async method", () => {
    const code = `var y = (function () {
  return (function (t, r) { if (r) f(t.prototype, r); Object.defineProperty(t, "prototype", { writable: false }); return t; })(
    function t() { (function (t, r) { if (!(t instanceof r)) throw new TypeError("Cannot call a class as a function"); })(this, t); this.items = []; },
    [
      { key: "load", value: ((t = o().m(function t(r) { return o().w(function (c) { while (true) switch (c.n) { case 0: c.n = 1; return Promise.resolve(r); case 1: this.items = c.v; return c.a(2, this.items.length); } }, t, this); })), (r = function () {}), function (t) { return r.apply(this, arguments); }) },
      { key: "size", get: function () { return this.items.length; } },
    ],
  );
  var t;
  var r;
})();`;
    expect(restoreBabel(code)).toMatchInlineSnapshot(`
      "var y = class t {
      constructor() {
      this.items = [];
      }

      async load(r) {
      const __awaited1 = await Promise.resolve(r);
      this.items = __awaited1;
      return this.items.length;
      }

      get size() {
      return this.items.length;
      }
      };"
    `);
  });

  test("a state machine with a loop or try region is left alone", () => {
    const code = `var y = (function () { return (function (t, r) { Object.defineProperty(t, "prototype", { writable: false }); return t; })(function t() {}, [{ key: "m", value: ((t = o().m(function t() { return o().w(function (c) { while (true) switch (c.p = c.n) { case 0: c.p = 0; c.n = 1; return f(); case 1: return c.a(2); } }, t, this); })), function () {}) }]); var t; })();`;
    expect(restoreBabel(code)).toBe(code);
  });
});

describe("bundler detection", () => {
  test("signatures", () => {
    expect(
      detectChunkBundler("(self.webpackChunk_app=self.webpackChunk_app||[]).push([[1],{2(e){}}])"),
    ).toMatchObject({ bundler: "webpack", version: "5" });
    expect(
      detectChunkBundler("(window.webpackJsonp=window.webpackJsonp||[]).push([[0],[]])"),
    ).toMatchObject({ bundler: "webpack", version: "4" });
    expect(detectChunkBundler("const __vite__mapDeps=(i)=>i;")).toMatchObject({ bundler: "vite" });
    expect(detectChunkBundler('import{t as e}from"./shared-Dd2UdLhE.js";')).toMatchObject({
      bundler: "rollup",
    });
    expect(detectChunkBundler("var o=(e,t)=>()=>(e&&(t=e(e=0)),t);")).toMatchObject({
      bundler: "esbuild",
    });
    expect(
      detectChunkBundler(
        'var c="function"==typeof require&&require;var a=new Error("Cannot find module");a.code="MODULE_NOT_FOUND"',
      ),
    ).toMatchObject({ bundler: "browserify" });
    expect(detectChunkBundler("parcelRequire=function(){}")).toMatchObject({ bundler: "parcel" });
    expect(detectChunkBundler("globalThis.TURBOPACK=[]")).toMatchObject({ bundler: "turbopack" });
    expect(detectChunkBundler("console.log(1)")).toMatchObject({ bundler: "unknown" });
  });

  test("the site's bundler is the one behind the most bytes; Vite claims its Rollup-shaped chunks", () => {
    const report = summarizeBundlers([
      { url: "a", size: 100, result: detectChunkBundler("const __vite__mapDeps=1;") },
      { url: "b", size: 10, result: detectChunkBundler('import{t}from"./x-abcdefgh.js";') },
    ]);
    expect(report.bundler).toBe("vite");
    expect(report.others).toEqual([]);
    expect(bundlerPackage({ bundler: "webpack", version: "4" })).toEqual({
      name: "webpack",
      range: "^4.0.0",
    });
    expect(bundlerPackage({ bundler: "turbopack", version: null })).toBeUndefined();
  });
});

describe("naming", () => {
  test("chunk folders drop the build hash and stay unique", () => {
    const taken = new Set<string>();
    expect(chunkName("https://x.test/static/main.378ea535.js", taken)).toBe("main");
    expect(chunkName("https://x.test/static/menu-panel.22b5c690.chunk.js", taken)).toBe(
      "menu-panel",
    );
    expect(chunkName("https://x.test/assets/index-z38Ersl5.js", taken)).toBe("index");
    expect(chunkName("https://x.test/assets/index-ObEbdNY5.js", taken)).toBe("index-2");
    expect(chunkName("https://x.test/styles.js", taken)).toBe("styles-js");
  });

  test("assets get readable names", () => {
    const taken = new Set<string>();
    expect(readableName("https://x.test/assets/logo-DkYr1V8R.png", "image/png", taken)).toBe(
      "logo.png",
    );
    expect(readableName("https://x.test/media/font.3b1f0a9c.woff2", "font/woff2", taken)).toBe(
      "font.woff2",
    );
    expect(readableName("https://x.test/a/logo-AbCdEfGh.png", "image/png", taken)).toBe(
      "logo-2.png",
    );
    expect(readableName("https://x.test/img?id=4", "image/jpeg", taken)).toBe("img.jpg");
  });
});

describe("helpers", () => {
  test("applyEdits drops nested edits and trims overlapping deletions", () => {
    expect(
      applyEdits("abcdef", [
        { start: 1, end: 4, text: "X" },
        { start: 2, end: 3, text: "Y" },
      ]),
    ).toBe("aXef");
    expect(
      applyEdits("a(),b();", [
        { start: 0, end: 4, text: "" },
        { start: 3, end: 7, text: "" },
      ]),
    ).toBe(";");
  });

  test("changed lines and obfuscation", () => {
    expect(changedLines("a\nb\nc", "a\nB\nc\nd")).toBe(2);
    expect(changedLines("x", "x")).toBe(0);
    expect(
      looksObfuscated(
        Array.from({ length: 12 }, (_, i) => `_0x${(4096 + i).toString(16)}`).join(";"),
      ),
    ).toBe(true);
    expect(looksObfuscated("const a = 1;")).toBe(false);
  });

  test("a pass that throws leaves the previous output and is reported", async () => {
    const adapter = {
      ...defaultAdapter,
      jsx: async () => {
        throw new Error("boom");
      },
    };
    const result = await transform("var a = !0;", adapter, new Set(["prettier"]));
    expect(result.passes.find((p) => p.pass === "jsx")).toMatchObject({
      status: "error",
      error: "boom",
    });
    expect(result.code).toContain("true");
    expect(result.passes.find((p) => p.pass === "prettier")?.status).toBe("skipped");
  });

  test("default imports of a module with only named exports become namespace imports", () => {
    const modules = [
      {
        file: "a/main.js",
        code: 'import cart, { x } from "./cart.js";\nimport fmt from "./fmt.js";',
      },
      { file: "a/cart.js", code: "export const add = 1; export const x = 2;" },
      { file: "a/fmt.js", code: "export default {};" },
    ];
    expect(fixDefaultImports(modules)).toBe(1);
    expect(modules[0]?.code).toBe(
      'import * as cart from "./cart.js";\nimport { x } from "./cart.js";\nimport fmt from "./fmt.js";',
    );
  });

  test("styling detection", () => {
    const tw = detectStyling({
      css: [".x{--tw-ring-color:red}"],
      dom: [`<div class="${"flex mt-4 text-sm ".repeat(10)}">`],
      classMaps: 0,
    });
    expect(tw.tailwind.detected).toBe(true);
    const sc = detectStyling({
      css: [],
      dom: ['<div class="sc-bdVaJa css-1x2y3z4">'],
      classMaps: 0,
    });
    expect(sc.styledComponents.detected).toBe(true);
    expect(sc.emotion.detected).toBe(true);
    expect(sc.tailwind.detected).toBe(false);
  });
});

describe("module graph", () => {
  const input = (id: string, code: string, extra: Partial<GraphInput> = {}): GraphInput => ({
    id,
    file: `recovered/unbundled/${id}.js`,
    origin: "unbundled",
    boundary: "real",
    chunk: id.split("/")[0] ?? "",
    code,
    pages: ["index"],
    entry: false,
    obfuscated: false,
    source: null,
    range: null,
    ...extra,
  });

  test("specifiers", () => {
    expect(
      specifiersOf(
        'import a from "./a.js";\nimport "./b.css";\nconst c = require("c");\nimport("./d.js");',
      ),
    ).toEqual({
      static: ["./a.js", "./b.css", "c"],
      dynamic: ["./d.js"],
    });
  });

  test("kinds, leaves-first order with cycles together, groups", () => {
    const graph = buildGraph(
      [
        input("m/entry", 'import { a } from "./a.js";\nimport("./page.js");', { entry: true }),
        input(
          "m/a",
          'import { b } from "./b.js";\nimport { useState } from "react";\nexport function a(){ return useState(1); }',
        ),
        input("m/b", 'import { a } from "./a.js";\nexport const b = 1;'),
        input("m/page", "export default function P(){ return (<div/>); }"),
      ],
      40 * 1024,
    );
    const by = new Map(graph.modules.map((m) => [m.id, m]));
    expect(by.get("m/entry")?.kind).toBe("entry");
    expect(by.get("m/page")?.kind).toBe("route");
    expect(by.get("m/a")?.kind).toBe("hook");
    expect(by.get("m/a")?.packageImports).toEqual(["react"]);
    const order = (id: string) => by.get(id)?.order ?? 0;
    expect(Math.abs(order("m/a") - order("m/b"))).toBe(1);
    expect(order("m/entry")).toBeGreaterThan(order("m/a"));
    expect(order("m/entry")).toBeGreaterThan(order("m/page"));
    expect(graph.groups).toHaveLength(1);
  });
});

describe("similarity", () => {
  test("names and formatting do not count; statements must land in one module", () => {
    expect(statementsOf("export function f(a){return a+1}")).toEqual(
      statementsOf("function g(x) {\n  return x + 1;\n}"),
    );
    const sources = [
      { file: "a.js", code: "const a = 1;\nexport function f(x) { return x * a; }" },
    ];
    const together = similarity(sources, [
      { file: "o.js", code: "var q = 1; function z(y) { return y * q }" },
    ]);
    expect(together.score).toBe(1);
    const apart = similarity(sources, [
      { file: "o1.js", code: "var q = 1;" },
      { file: "o2.js", code: "function z(y) { return y * q }" },
    ]);
    expect(apart.score).toBe(0.5);
  });
});

describe("CSS Modules", () => {
  const draft = (code: string) => ({ code }) as unknown as Parameters<typeof findClassMaps>[0];
  test("hashed class maps are found; utility lookups are not", () => {
    const css = new Set(["Card-module__card--O3qo5", "_title_x1y2z_1", "text-sm", "btn-primary"]);
    expect(
      findClassMaps(draft('const a = { card: "Card-module__card--O3qo5" };'), css),
    ).toHaveLength(1);
    expect(findClassMaps(draft('const a = { title: "_title_x1y2z_1" };'), css)).toHaveLength(1);
    expect(
      findClassMaps(draft('const a = { sm: "text-sm", primary: "btn-primary" };'), css),
    ).toHaveLength(0);
  });
});
