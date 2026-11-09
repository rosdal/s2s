import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fingerprintCode, NORMALIZER_VERSION } from "@rosdal/s2s-core/fingerprint";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BUILDER_VERSION,
  buildVersion,
  checkIntegrity,
  entrySpecifiers,
  externalsOf,
  isDenied,
  loadResult,
  minifyVariants,
  type Packument,
  satisfies,
  saveResult,
  selectVersions,
  shard,
  shipsBrowserCode,
  unpackTarball,
  VARIANTS,
} from "../src/index.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-fpb-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A gzipped ustar archive, entries as given (names include the `package/` prefix). */
function tgz(entries: { name: string; body?: string; type?: string }[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    const header = Buffer.alloc(512);
    header.write(e.name.slice(0, 100), 0);
    header.write("0000644\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(e.type ?? "0", 156);
    header.write("ustar\0", 257);
    header.fill(" ", 148, 156);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe("tarballs", () => {
  test("integrity is checked against the SRI string", () => {
    const bytes = new TextEncoder().encode("hello");
    const sri = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    expect(checkIntegrity(bytes, sri)).toBe(true);
    expect(checkIntegrity(new TextEncoder().encode("hellO"), sri)).toBe(false);
    expect(checkIntegrity(bytes, "md5-abc")).toBe(false);
  });

  test("unpacking writes regular files only and never escapes the folder", async () => {
    const dir = path.join(tmp, "unpack");
    const written = await unpackTarball(
      tgz([
        { name: "package/package.json", body: '{"name":"x"}' },
        { name: "package/lib/a.js", body: "export const a=1" },
        { name: "package/../../evil.js", body: "bad" },
        { name: "package/link", type: "2" },
      ]),
      dir,
    );
    expect(written).toBe(2);
    expect(
      (await readdir(dir, { recursive: true })).map((f) => f.replaceAll("\\", "/")).sort(),
    ).toEqual(["lib", "lib/a.js", "package.json"]);
    await expect(readFile(path.join(tmp, "evil.js"))).rejects.toThrow();
  });
});

describe("entries", () => {
  test("the package, its subpath exports, and expanded wildcards", () => {
    const pkg = {
      exports: {
        ".": { import: "./esm/index.mjs", default: "./index.js" },
        "./package.json": "./package.json",
        "./styles.css": "./styles.css",
        "./types": { types: "./types.d.ts" },
        "./middleware": { import: "./esm/middleware.mjs" },
        "./*": { import: { types: "./esm/*.d.mts", default: "./esm/*.mjs" } },
      },
    };
    const files = [
      "esm/index.mjs",
      "esm/middleware.mjs",
      "esm/vanilla.mjs",
      "esm/_internal.mjs",
      "esm/vanilla.d.mts",
    ];
    expect(entrySpecifiers("z", pkg, files)).toEqual(["z", "z/middleware", "z/index", "z/vanilla"]);
  });

  test("dependencies and peers stay external, subpaths included", () => {
    expect(
      externalsOf({ name: "x", dependencies: { a: "1" }, peerDependencies: { react: "*" } }),
    ).toEqual(["a", "a/*", "react", "react/*"]);
  });
});

describe("corpus rules", () => {
  const doc: Packument = {
    name: "p",
    versions: Object.fromEntries(
      ["1.0.0", "1.2.0", "2.0.0", "2.1.0", "3.0.0-beta.1", "3.0.0", "3.1.0"].map((v) => [
        v,
        { version: v },
      ]),
    ),
    time: {
      "1.0.0": "2019-01-01T00:00:00Z",
      "1.2.0": "2020-01-01T00:00:00Z",
      "2.0.0": "2021-01-01T00:00:00Z",
      "2.1.0": "2022-01-01T00:00:00Z",
      "3.0.0-beta.1": "2025-01-01T00:00:00Z",
      "3.0.0": "2025-02-01T00:00:00Z",
      "3.1.0": "2026-06-01T00:00:00Z",
    },
  };

  test("recent stable versions plus the newest release of each older major", () => {
    expect(selectVersions(doc, new Date("2026-11-01T00:00:00Z"))).toEqual([
      "1.2.0",
      "2.1.0",
      "3.0.0",
      "3.1.0",
    ]);
  });

  test("browser code is recognised; CLIs and types-only packages are not", () => {
    expect(shipsBrowserCode({ version: "1", module: "esm/index.js" })).toBe(true);
    expect(
      shipsBrowserCode({ version: "1", exports: { ".": { browser: "./b.js", node: "./n.js" } } }),
    ).toBe(true);
    expect(
      shipsBrowserCode({ version: "1", exports: { ".": { node: "./n.js", import: "./i.mjs" } } }),
    ).toBe(false);
    expect(shipsBrowserCode({ version: "1", main: "cli.js", bin: { x: "cli.js" } })).toBe(false);
    expect(shipsBrowserCode({ version: "1", types: "index.d.ts" })).toBe(false);
  });

  test("the denylist matches names and patterns", () => {
    const deny = { packages: ["express"], patterns: ["^@types/", "-cli$"] };
    expect(
      ["express", "@types/react", "foo-cli", "react"].filter((n) => isDenied(n, deny)),
    ).toEqual(["express", "@types/react", "foo-cli"]);
  });

  test("ranges for s2s db build", () => {
    expect(satisfies("4.17.21", "4.x")).toBe(true);
    expect(satisfies("4.17.21", "4.16.x")).toBe(false);
    expect(satisfies("4.17.21", "^4.1.0")).toBe(true);
    expect(satisfies("5.0.0", "^4.1.0")).toBe(false);
    expect(satisfies("0.3.5", "^0.3.1")).toBe(true);
    expect(satisfies("0.4.0", "^0.3.1")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("1.0.0-rc.1", "*")).toBe(false);
  });

  test("shards keep packages whole and balance version counts", () => {
    const versions = [
      ...Array.from({ length: 6 }, (_, i) => ({
        name: "big",
        version: `1.0.${i}`,
        tarball: "",
        integrity: "",
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        name: "mid",
        version: `1.0.${i}`,
        tarball: "",
        integrity: "",
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        name: "small",
        version: `1.0.${i}`,
        tarball: "",
        integrity: "",
      })),
    ];
    const a = shard(versions, 0, 2);
    const b = shard(versions, 1, 2);
    expect(a.length + b.length).toBe(12);
    expect(new Set(a.map((v) => v.name))).toEqual(new Set(["big"]));
    expect(new Set(b.map((v) => v.name))).toEqual(new Set(["mid", "small"]));
  });
});

/**
 * Golden test: library code minified by each indexed variant, and by the held-out benchmark
 * setting. The agreement matrix is the record of where the minifiers disagree (documented in
 * docs/fingerprints.md): each variant is indexed separately because no single normalization
 * erases every difference, and the union must cover the held-out setting.
 */
describe("variants", () => {
  const source = `
export function debounce(fn, wait, options) {
  let timer, lastArgs, lastThis, result;
  const leading = !!(options && options.leading);
  function invoke() {
    result = fn.apply(lastThis, lastArgs);
    lastArgs = lastThis = undefined;
    return result;
  }
  function debounced(...args) {
    lastArgs = args;
    lastThis = this;
    if (timer === undefined && leading) return invoke();
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; if (!leading) invoke(); }, wait);
    return result;
  }
  debounced.cancel = function () { clearTimeout(timer); timer = lastArgs = lastThis = undefined; };
  return debounced;
}
export function chunk(list, size) {
  if (!Array.isArray(list)) throw new TypeError("chunk expects an array as its first argument");
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
export class Emitter {
  constructor() { this.handlers = new Map(); }
  on(type, handler) {
    const list = this.handlers.get(type);
    if (list) list.push(handler); else this.handlers.set(type, [handler]);
    return () => this.off(type, handler);
  }
  off(type, handler) {
    const list = this.handlers.get(type);
    if (!list) return;
    const at = list.indexOf(handler);
    if (at !== -1) list.splice(at, 1);
  }
  emit(type, payload) {
    for (const handler of this.handlers.get(type) || []) handler(payload);
    for (const handler of this.handlers.get("*") || []) handler(type, payload);
  }
}
export function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals < 0 ? 0 : decimals)) + " " + sizes[i];
}
`;

  test("every variant builds, and the union covers the held-out setting", async () => {
    const out = await minifyVariants(source);
    expect(Object.keys(out.codes).sort()).toEqual([...VARIANTS].sort());
    const sets = new Map<string, Set<bigint>>();
    for (const [variant, code] of Object.entries(out.codes))
      sets.set(variant, new Set((await fingerprintCode(code)).functions.map((f) => f.hash)));
    const { minify } = await import("terser");
    const heldOut = (
      await minify(source, {
        module: true,
        toplevel: true,
        compress: { passes: 3 },
        mangle: { toplevel: true },
      })
    ).code as string;
    const held = new Set((await fingerprintCode(heldOut)).functions.map((f) => f.hash));
    const union = new Set([...sets.values()].flatMap((s) => [...s]));
    const covered = [...held].filter((h) => union.has(h)).length / held.size;
    expect(covered).toBeGreaterThanOrEqual(0.8);

    const share = (a: Set<bigint>, b: Set<bigint>) =>
      Math.round((100 * [...a].filter((h) => b.has(h)).length) / a.size) / 100;
    const matrix = Object.fromEntries(
      [...sets].map(([a, sa]) => [
        a,
        Object.fromEntries([...sets].map(([b, sb]) => [b, share(sa, sb)])),
      ]),
    );
    // Where the minifiers agree, the hashes agree; the snapshot records where they do not.
    expect(matrix).toMatchSnapshot();
  });
});

describe("results", () => {
  test("a version that failed outright is not treated as cached", async () => {
    const cacheDir = path.join(tmp, "retry");
    const base = {
      name: "x",
      version: "1.0.0",
      builder: BUILDER_VERSION,
      normalizer: NORMALIZER_VERSION,
    };
    const result = { ...base, entries: [], functions: [], strings: [], dependencies: [], ms: 0 };
    await saveResult(cacheDir, { ...result, error: "GET … returned 503" });
    expect(await loadResult(cacheDir, "x", "1.0.0")).toBeUndefined();
    await saveResult(cacheDir, { ...result, error: null });
    expect(await loadResult(cacheDir, "x", "1.0.0")).toBeDefined();
  });
});

describe("buildVersion", () => {
  test("fingerprints a local tarball and skips entries that need Node", async () => {
    const lib = `export function slugify(input){if(typeof input!=="string")throw new TypeError("slugify expects a string input");return input.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")}
export function titleCase(s){return s.split(" ").map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(" ")}`;
    const bytes = tgz([
      {
        name: "package/package.json",
        body: JSON.stringify({
          name: "tiny-lib",
          version: "1.0.0",
          type: "module",
          exports: { ".": "./index.js", "./server": "./server.js" },
        }),
      },
      { name: "package/index.js", body: lib },
      {
        name: "package/server.js",
        body: 'import fs from "fs";export const read=p=>fs.readFileSync(p,"utf8").split("\\n").map(l=>l.trim())',
      },
    ]);
    const result = await buildVersion(
      { name: "tiny-lib", version: "1.0.0", tarball: "", integrity: "" },
      { cacheDir: path.join(tmp, "cache"), tarballBytes: bytes },
    );
    expect(result.error).toBeNull();
    expect(result.entries.map((e) => [e.specifier, e.status, e.reason])).toEqual([
      ["tiny-lib", "ok", null],
      ["tiny-lib/server", "skipped", "node-only"],
    ]);
    expect(result.functions.length).toBeGreaterThanOrEqual(2);
    expect(result.strings.length).toBe(1);
  });

  test("fingerprints the JS glue of a package that imports its .wasm (wasm-bindgen bundler)", async () => {
    // @dimforge/rapier3d's shape: the entry imports the binary as an ES module.
    const glue = `import * as wasm from "./lib_bg.wasm";
export function stepWorld(world,dt){if(typeof dt!=="number")throw new TypeError("stepWorld expects a number");return wasm.world_step(world.ptr,dt)}
export function dropObject(idx){if(idx<132)return;heap[idx]=heapNext;heapNext=idx}
const heap=new Array(128).fill(undefined);let heapNext=heap.length;`;
    const bytes = tgz([
      {
        name: "package/package.json",
        body: JSON.stringify({
          name: "wasm-lib",
          version: "1.0.0",
          type: "module",
          module: "./lib.js",
        }),
      },
      { name: "package/lib.js", body: glue },
      { name: "package/lib_bg.wasm", body: "\0asm\x01\0\0\0" },
    ]);
    const result = await buildVersion(
      { name: "wasm-lib", version: "1.0.0", tarball: "", integrity: "" },
      { cacheDir: path.join(tmp, "cache"), tarballBytes: bytes },
    );
    expect(result.entries.map((e) => [e.specifier, e.status, e.error])).toEqual([
      ["wasm-lib", "ok", null],
    ]);
    expect(result.functions.length).toBeGreaterThanOrEqual(2);
  });
});
