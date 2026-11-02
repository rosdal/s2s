import { describe, expect, test } from "vitest";
import { collectCdnPackages, parseCdnUrl } from "../src/capture/cdn.js";
import { classifyOrigin, isFirstParty } from "../src/capture/origin.js";
import { cleanUrl, pageKey } from "../src/capture/url.js";

describe("URL normalization", () => {
  test("drops fragments and tracking parameters, sorts the rest", () => {
    expect(cleanUrl("https://x.com/a?utm_source=t&b=2&a=1&fbclid=z#top")?.href).toBe(
      "https://x.com/a?a=1&b=2",
    );
  });
  test("rejects non-http URLs", () => {
    expect(cleanUrl("mailto:a@b.c")).toBeUndefined();
    expect(cleanUrl("javascript:void(0)")).toBeUndefined();
  });
  test("page keys ignore trailing slashes except at the root", () => {
    expect(pageKey("https://x.com/about/")).toBe(pageKey("https://x.com/about"));
    expect(pageKey("https://x.com/")).toBe("https://x.com/");
    expect(pageKey("https://x.com/a/?gclid=1#x")).toBe("https://x.com/a");
  });
});

describe("origin classification", () => {
  const target = new URL("https://www.shopify.com/editions");
  const tag = (url: string, resourceType = "script", mimeType: string | null = null) =>
    classifyOrigin({ url, resourceType, mimeType }, target);

  test("registrable domain decides first-party", () => {
    expect(isFirstParty(new URL("https://cdn.shopify.com/x.js"), target)).toBe(true);
    expect(isFirstParty(new URL("https://shopify.dev/x.js"), target)).toBe(false);
    expect(tag("https://cdn.shopify.com/s/app.js")).toBe("first-party");
  });
  test("known hosts and types", () => {
    expect(tag("https://www.googletagmanager.com/gtag/js?id=G-1")).toBe("analytics-ads");
    expect(tag("https://fonts.googleapis.com/css2?family=Inter", "stylesheet")).toBe("fonts");
    expect(tag("https://cdn.shopify.com/font.woff2", "font")).toBe("fonts");
    expect(tag("https://cdn.shopify.com/hero.webp", "image", "image/webp")).toBe("media");
    expect(tag("https://cdn.jsdelivr.net/npm/lodash@4/lodash.js")).toBe("cdn-library");
    expect(tag("https://widgets.example.net/w.js")).toBe("cdn-library");
    expect(tag("https://collector.example.net/hit", "fetch")).toBe("analytics-ads");
  });
  test("localhost and IP targets compare by host", () => {
    const local = new URL("http://127.0.0.1:4000/");
    const input = { url: "http://127.0.0.1:4000/a.js", resourceType: "script", mimeType: null };
    expect(classifyOrigin(input, local)).toBe("first-party");
  });
});

describe("CDN URL parser", () => {
  test.each([
    [
      "https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js",
      "lodash",
      "4.17.21",
      "/lodash.min.js",
    ],
    [
      "https://cdn.jsdelivr.net/npm/@picocss/pico@2.0.6/css/pico.min.css",
      "@picocss/pico",
      "2.0.6",
      "/css/pico.min.css",
    ],
    ["https://unpkg.com/dayjs@1.11.13/dayjs.min.js", "dayjs", "1.11.13", "/dayjs.min.js"],
    ["https://unpkg.com/react", "react", null, null],
    [
      "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js",
      "jquery",
      "3.7.1",
      "/jquery.min.js",
    ],
    ["https://esm.sh/canvas-confetti@1.9.3", "canvas-confetti", "1.9.3", null],
    [
      "https://esm.sh/v135/@preact/signals@1.2.3/es2022/signals.mjs",
      "@preact/signals",
      "1.2.3",
      "/es2022/signals.mjs",
    ],
    ["https://cdn.skypack.dev/nanoid@5.0.7", "nanoid", "5.0.7", null],
    [
      "https://cdn.skypack.dev/-/canvas-confetti@v1.9.3-4tF2rFv5ZoDsRUdjS0Rz/dist=es2019,mode=imports/optimized/canvas-confetti.js",
      "canvas-confetti",
      "v1.9.3",
      "/dist=es2019,mode=imports/optimized/canvas-confetti.js",
    ],
  ])("%s", (url, name, version, file) => {
    expect(parseCdnUrl(url)).toEqual([expect.objectContaining({ name, version, file })]);
  });
  test("jsdelivr combine URLs name every package", () => {
    const hits = parseCdnUrl(
      "https://cdn.jsdelivr.net/combine/npm/a@1.0.0,npm/@b/c@2.0.0/x.js,gh/u/r@1/x.js",
    );
    expect(hits.map((h) => `${h.name}@${h.version}`)).toEqual(["a@1.0.0", "@b/c@2.0.0"]);
  });
  test("malformed percent-escapes don't throw", () => {
    expect(parseCdnUrl("https://unpkg.com/foo%zz@1.0.0/index.js")).toEqual([]);
    expect(parseCdnUrl("https://unpkg.com/foo@1.0%zz/index.js")).toEqual([
      expect.objectContaining({ name: "foo", version: "1.0%zz" }),
    ]);
  });
  test("non-CDN URLs and GitHub paths yield nothing", () => {
    expect(parseCdnUrl("https://example.com/npm/a@1/x.js")).toEqual([]);
    expect(parseCdnUrl("https://cdn.jsdelivr.net/gh/user/repo@1/x.js")).toEqual([]);
  });
  test("collectCdnPackages groups by name and version", () => {
    const entries = collectCdnPackages([
      "https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js",
      "https://unpkg.com/lodash@4.17.21/fp.js",
      "https://example.com/app.js",
    ]);
    expect(entries).toEqual([
      expect.objectContaining({ name: "lodash", version: "4.17.21", cdns: ["jsdelivr", "unpkg"] }),
    ]);
  });
});
