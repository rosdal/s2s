import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  candidatesFor,
  readCssRefs,
  readGenericRefs,
  readHtmlRefs,
  readNextRefs,
  readViteRefs,
  readWebpackRefs,
} from "../src/capture/discovery/readers.js";

const sample = (name: string) =>
  readFileSync(new URL(`./samples/${name}`, import.meta.url), "utf8");
const urls = (refs: { candidates: string[] }[]) => refs.map((r) => r.candidates[0]).sort();

describe("candidatesFor", () => {
  const file = "https://example.com/assets/index-abc.js";
  test("explicit paths resolve one way", () => {
    expect(candidatesFor("./Footer.js", file)).toEqual(["https://example.com/assets/Footer.js"]);
    expect(candidatesFor("/x.js", file)).toEqual(["https://example.com/x.js"]);
    expect(candidatesFor("https://cdn.example.com/a.js", file)).toEqual([
      "https://cdn.example.com/a.js",
    ]);
  });
  test("bare paths try the base folder first when the file sits in the named folder", () => {
    expect(candidatesFor("assets/Admin.js", file)).toEqual([
      "https://example.com/assets/Admin.js",
      "https://example.com/assets/assets/Admin.js",
    ]);
    expect(candidatesFor("chunks/a.js", file)).toEqual([
      "https://example.com/assets/chunks/a.js",
      "https://example.com/chunks/a.js",
    ]);
  });
});

describe("readWebpackRefs", () => {
  test("webpack 5 runtime: chunk-filename map and public path", () => {
    const refs = readWebpackRefs(sample("webpack5-runtime.js"), "http://h/static/runtime.js");
    expect(urls(refs)).toEqual([
      "http://h/static/menu-panel.22b5c690.chunk.js",
      "http://h/static/settings.24504f64.chunk.js",
    ]);
  });
  test("webpack 4 jsonpScriptSrc with name fallback", () => {
    const refs = readWebpackRefs(sample("webpack4-runtime.js"), "http://h/app/runtime.js");
    expect(urls(refs)).toEqual([
      "http://h/app/static/js/2.c91b.chunk.js",
      "http://h/app/static/js/vendors~main.8f2a.chunk.js",
    ]);
  });
  test("an unparsable public path yields nothing instead of throwing", () => {
    const text = 'r.p="http://localhost:__PORT__/",r.u=e=>({1:"a"}[e]+".js")';
    expect(readWebpackRefs(text, "http://h/runtime.js")).toEqual([]);
  });
  test("files without a webpack runtime yield nothing", () => {
    expect(readWebpackRefs("console.log('x.p=1')", "http://h/a.js")).toEqual([]);
  });
});

describe("readNextRefs", () => {
  test("Turbopack build manifest, plus the sibling SSG manifest", () => {
    const file = "http://h/_next/static/BUILD/_buildManifest.js";
    const found = urls(readNextRefs(sample("next-turbopack-buildManifest.js"), file));
    expect(found).toContain("http://h/_next/static/chunks/12xt5hydkmdxu.js");
    expect(found).toContain("http://h/_next/static/chunks/0m2vcy7cc_qb7.js");
    expect(found).toContain("http://h/_next/static/BUILD/_ssgManifest.js");
  });
  test("webpack-era build manifest including CSS and shared chunks", () => {
    const file = "https://h/_next/static/X/_buildManifest.js";
    const found = urls(readNextRefs(sample("next-webpack-buildManifest.js"), file));
    expect(found).toEqual(
      expect.arrayContaining([
        "https://h/_next/static/chunks/framework-0011.js",
        "https://h/_next/static/chunks/pages/blog/[slug]-77aa.js",
        "https://h/_next/static/css/a1b2c3.css",
      ]),
    );
  });
});

describe("readViteRefs", () => {
  test("__vite__mapDeps entries resolve against the base, not the chunk folder", () => {
    const refs = readViteRefs(sample("vite-mapdeps.js"), "http://h/assets/index-CVILNGLE.js");
    expect(urls(refs)).toEqual([
      "http://h/assets/Admin-BCqpQCI4.css",
      "http://h/assets/Admin-DAiA4omi.js",
      "http://h/assets/Footer-B5HJQDv_.js",
      "http://h/assets/Footer-Cuc8wPic.css",
      "http://h/assets/shared-Dd2UdLhE.js",
    ]);
  });
});

describe("readGenericRefs", () => {
  test("finds quoted paths and skips bare names and templates", () => {
    // A template literal with a placeholder, as it appears in bundled code.
    const template = ["`", "$", "{a}/b.js`"].join("");
    const text = `import("./lazy.js");x="react.js";y=${template};z='/static/app.css?v=3'`;
    expect(urls(readGenericRefs(text, "http://h/js/main.js"))).toEqual([
      "http://h/js/lazy.js",
      "http://h/static/app.css?v=3",
    ]);
  });
});

describe("readCssRefs", () => {
  test("@import in its common forms", () => {
    const css = `@import "a.css"; @import url(b.css); @import url('/c.css') screen;`;
    expect(urls(readCssRefs(css, "http://h/css/main.css"))).toEqual([
      "http://h/c.css",
      "http://h/css/a.css",
      "http://h/css/b.css",
    ]);
  });
});

describe("readHtmlRefs", () => {
  test("scripts, preload links, import maps and the Next.js manifest, honoring <base>", () => {
    const refs = readHtmlRefs(sample("page.html"), "http://h/shop/index.html");
    const bySource = (s: string) => urls(refs.filter((r) => r.source === s));
    expect(bySource("importmap")).toEqual(["http://h/shop/js/app.mjs", "http://h/vendor/x.js"]);
    expect(bySource("preload")).toEqual([
      "http://h/shop/css/late.css",
      "http://h/shop/js/chunk-a.js",
      "http://h/shop/js/later.js?v=2",
    ]);
    expect(bySource("html")).toEqual(["http://h/js/main.js?v=1&x=2", "http://h/shop/css/main.css"]);
    expect(bySource("next")).toEqual([
      "https://cdn.example.com/_next/static/abc123/_buildManifest.js",
      "https://cdn.example.com/_next/static/abc123/_ssgManifest.js",
    ]);
  });

  test("icons and the web manifest, which the browser fetches on its own", () => {
    const html = [
      '<link rel="icon" type="image/png" href="./favicons/favicon-96x96.png" sizes="96x96">',
      '<link rel="shortcut icon" href="./favicons/favicon.ico">',
      '<link rel="apple-touch-icon" href="/apple.png">',
      '<link rel="manifest" href="./favicons/site.webmanifest">',
      '<link rel="preconnect" href="https://fonts.googleapis.com">',
    ].join("\n");
    const refs = readHtmlRefs(html, "https://bruno-simon.com/");
    expect(urls(refs.filter((r) => r.source === "icon"))).toEqual([
      "https://bruno-simon.com/apple.png",
      "https://bruno-simon.com/favicons/favicon-96x96.png",
      "https://bruno-simon.com/favicons/favicon.ico",
      "https://bruno-simon.com/favicons/site.webmanifest",
    ]);
    expect(refs).toHaveLength(4);
  });
});
