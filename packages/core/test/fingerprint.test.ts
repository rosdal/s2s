import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  bitIndices,
  decodePostings,
  describeVersions,
  encodePostings,
  FingerprintIndex,
  fingerprintCode,
  IndexError,
  IndexWriter,
  indexStatus,
  MAX_SHARING,
  matchBundles,
  openIndexes,
  PullError,
  pullIndex,
  setBit,
} from "../src/fingerprint/index.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-fp-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Hashes of every function in `code` big enough to be indexed. */
async function hashes(code: string): Promise<bigint[]> {
  const prints = await fingerprintCode(code);
  expect(prints.error).toBeNull();
  return prints.functions.map((f) => f.hash);
}

/** The hash of the one outermost function in `code`. */
async function outer(code: string): Promise<bigint> {
  const prints = await fingerprintCode(code);
  const top = [...prints.functions].sort((a, b) => a.start - b.start || b.end - a.end)[0];
  if (!top) throw new Error(`no function in ${code}`);
  return top.hash;
}

describe("normalizer", () => {
  test("local names do not matter; globals and property names do", async () => {
    const a = await outer("function f(a,b){return a.items.map(x=>x*b).filter(Boolean)}");
    const b = await outer("function g(n,r){return n.items.map(t=>t*r).filter(Boolean)}");
    const prop = await outer("function g(n,r){return n.values.map(t=>t*r).filter(Boolean)}");
    const global = await outer("function g(n,r){return n.items.map(t=>t*r).filter(Number)}");
    expect(a).toBe(b);
    expect(prop).not.toBe(a);
    expect(global).not.toBe(a);
  });

  test("minifier spellings of the same code normalize the same", async () => {
    const pairs: [string, string][] = [
      // booleans and undefined
      ["function f(a){a.x=true;a.y=false;return void 0}", "function f(a){a.x=!0;a.y=!1;return}"],
      // && for if, sequences for statements
      ["function f(a,b){if(a){b.c();b.d()}}", "function f(a,b){a&&(b.c(),b.d())}"],
      // a ternary return for if/return
      ["function f(a,b){if(a)return b.x;return b.y}", "function f(a,b){return a?b.x:b.y}"],
      // negated tests swap branches
      ["function f(a,b){if(!a){b.x()}else{b.y()}}", "function f(a,b){a?b.y():b.x()}"],
      // equality and flipped comparisons
      ['function f(a){return a.k==="x"&&a.n>1}', 'function f(a){return"x"==a.k&&1<a.n}'],
      // typeof undefined, esbuild style
      [
        'function f(a){return typeof a.w==="undefined"&&a.q()}',
        'function f(a){return typeof a.w>"u"&&a.q()}',
      ],
      // computed member access with a string, quoted keys
      [
        'function f(a){return{"key":a["prop"],other:a.b,more:a.c.d}}',
        "function f(a){return{key:a.prop,other:a.b,more:a.c.d}}",
      ],
      // while as for(;;), var as let, postfix as prefix
      [
        "function f(a){var i=0;while(i<a.n){a.g(i);i++}}",
        "function f(a){let i=0;for(;i<a.n;){a.g(i);++i}}",
      ],
      // compound assignment
      ["function f(a,b){a=a+b.x;return a*b.y}", "function f(a,b){a+=b.x;return a*b.y}"],
      // numbers
      ["function f(a){return a.t*1000+a.u*0.5+a.v}", "function f(a){return a.t*1e3+a.u*.5+a.v}"],
    ];
    for (const [plain, minified] of pairs)
      expect(await outer(minified), `${plain} vs ${minified}`).toBe(await outer(plain));
  });

  test("functions under the size floor are not indexed; strings of 12+ characters are", async () => {
    const prints = await fingerprintCode(
      'const tiny=()=>1;function big(a){if(!a)throw new Error("Invariant failed: missing a");return a.x+a.y}',
    );
    expect(prints.functions).toHaveLength(1);
    expect(prints.strings.map((s) => s.value)).toEqual(["Invariant failed: missing a"]);
  });

  test("a nested function contributes its hash, so the parent changes when it does", async () => {
    const a = await hashes(
      "function f(a){return a.list.map(function(x){return x.id+x.name.length})}",
    );
    const b = await hashes(
      "function f(a){return a.list.map(function(x){return x.id-x.name.length})}",
    );
    expect(a).toHaveLength(2);
    expect(new Set([...a, ...b]).size).toBe(4);
  });

  test("offsets are UTF-16 indices into the code", async () => {
    const code = 'const é="üü";function f(a){return a.x+a.y+a.z}';
    const [fn] = (await fingerprintCode(code)).functions;
    expect(code.slice(fn?.start, fn?.end)).toBe("function f(a){return a.x+a.y+a.z}");
  });

  test("deeply nested code is cut off, not a stack overflow", async () => {
    // Deep enough to overflow the printer without its guard, shallow enough for oxc's parser,
    // which itself aborts the process somewhere past 10,000 levels.
    const depth = 5_000;
    const ternary = `function f(a){return ${Array.from({ length: depth }, (_, i) => `a===${i}?${i}:`).join("")}-1}`;
    const elseIf = `function g(a){${Array.from({ length: depth }, (_, i) => `if(a.k===${i}){a.v=${i}}else `).join("")}{a.v=-1}}`;
    for (const code of [ternary, elseIf]) {
      const prints = await fingerprintCode(code);
      expect(prints.error).toBeNull();
      expect(prints.functions).toHaveLength(1);
    }
  });

  test("unparseable code reports an error instead of throwing", async () => {
    const prints = await fingerprintCode("function (((");
    expect(prints.functions).toEqual([]);
    expect(prints.error).not.toBeNull();
  });
});

describe("posting lists", () => {
  test("round-trip packages and version bitsets", () => {
    let bits: Uint8Array = new Uint8Array(0);
    for (const i of [0, 3, 9, 200]) bits = setBit(bits, i);
    const encoded = encodePostings([
      { packageId: 300, versions: bits },
      { packageId: 2, versions: setBit(new Uint8Array(0), 1) },
    ]);
    const decoded = decodePostings(encoded);
    expect(decoded.map((p) => p.packageId)).toEqual([2, 300]);
    expect(bitIndices(decoded[1]?.versions ?? new Uint8Array())).toEqual([0, 3, 9, 200]);
  });
});

/** Library code for a test index: `version` changes one function, so versions can be told apart. */
function lib(name: string, version: number): string {
  const fns = Array.from(
    { length: 8 },
    (_, i) =>
      `function ${name}_${i}(a,b){if(!a)throw new TypeError("${name} expects a value in slot ${i}");return a.${name}${i}.map(x=>x.v${i}*b+${i}).filter(y=>y.ok${i})}`,
  );
  fns.push(
    `function ${name}_changing(a){return a.list.reduce((s,x)=>s+x.w*${version},0)+a.k${version}}`,
  );
  return fns.join("\n");
}

async function buildIndex(file: string, packages: Record<string, Record<string, string>>) {
  const writer = new IndexWriter(file);
  for (const [name, versions] of Object.entries(packages)) {
    const prints = [];
    for (const [version, code] of Object.entries(versions)) {
      const p = await fingerprintCode(code);
      prints.push({
        name,
        version,
        functions: p.functions.map((f) => f.hash),
        strings: p.strings.map((s) => s.hash),
      });
    }
    writer.addPackage(name, prints);
  }
  writer.setMeta({ corpus_date: "2026-11-01" });
  writer.close();
}

describe("index and matcher", () => {
  let file: string;
  beforeAll(async () => {
    file = path.join(tmp, "index.sqlite");
    await buildIndex(file, {
      alpha: { "1.0.0": lib("alpha", 1), "1.1.0": lib("alpha", 2), "1.1.1": lib("alpha", 2) },
      beta: { "2.0.0": lib("beta", 1) },
    });
  });

  test("the index stores packages, versions and postings", async () => {
    const index = FingerprintIndex.open(file);
    try {
      expect([...index.packages.values()].map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
      expect(index.meta.corpusDate).toBe("2026-11-01");
      const counts = index.counts();
      expect(counts.versions).toBe(4);
      // Each package's distinct hashes, each stored once.
      const alpha = new Set([
        ...(await hashes(lib("alpha", 1))),
        ...(await hashes(lib("alpha", 2))),
      ]);
      const beta = new Set(await hashes(lib("beta", 1)));
      expect(counts.hashes).toBe(new Set([...alpha, ...beta]).size);
      expect(counts.strings).toBe(16);
    } finally {
      index.close();
    }
  });

  test("finds packages, narrows versions and marks ranges around first-party code", async () => {
    const firstParty =
      "function app(a){const el=document.createElement('div');el.textContent=a.title+a.subtitle;return el}";
    const text = [lib("alpha", 2), firstParty, lib("beta", 1)].join("\n");
    const index = FingerprintIndex.open(file);
    try {
      const result = await matchBundles([{ id: "b1", url: "https://x/app.js", text }], [index]);
      const byName = new Map(result.packages.map((p) => [p.name, p]));
      expect([...byName.keys()]).toEqual(["alpha", "beta"]);
      const alpha = byName.get("alpha");
      expect(alpha?.candidates).toEqual(["1.1.0", "1.1.1"]);
      expect(alpha?.version).toBe("1.1.x");
      expect(alpha?.confident).toBe(true);
      // beta has one version: no hash tells versions apart, so that version is the answer.
      expect(byName.get("beta")?.version).toBe("2.0.0");
      const range = alpha?.bundles[0]?.ranges[0];
      expect(range && text.slice(range.start, range.end)).toBe(lib("alpha", 2));
      expect(text.slice(alpha?.bundles[0]?.ranges.at(-1)?.end ?? 0)).toContain("app(a)");
    } finally {
      index.close();
    }
  });

  test("code a package shares with its dependency is credited to the dependency", async () => {
    // `wrapper` ships a prebuilt bundle that inlines all of `core`, like vue's dist bundles.
    const file2 = path.join(tmp, "deps.sqlite");
    const core = lib("core", 1);
    const writer = new IndexWriter(file2);
    const prints = async (name: string, code: string, dependencies: string[]) => {
      const p = await fingerprintCode(code);
      return [
        {
          name,
          version: "1.0.0",
          functions: p.functions.map((f) => f.hash),
          strings: p.strings.map((s) => s.hash),
          dependencies,
        },
      ];
    };
    writer.addPackage("core", await prints("core", core, []));
    writer.addPackage(
      "wrapper",
      await prints(
        "wrapper",
        `${core}
${lib("wrapper", 1)}`,
        ["core"],
      ),
    );
    writer.close();
    const index = FingerprintIndex.open(file2);
    try {
      const onlyCore = await matchBundles([{ id: "b", url: "u", text: core }], [index]);
      expect(onlyCore.packages.map((p) => p.name)).toEqual(["core"]);
      expect(index.packages.get(2)?.dependencies).toEqual(["core"]);
    } finally {
      index.close();
    }
  });

  test("a bundle that vendors other packages is not reported for their code", async () => {
    // `fatbundle` carries copies of `small1` and `small2` plus its own code, without declaring
    // them, like plotly.js-dist-min carries d3.
    const file3 = path.join(tmp, "vendor.sqlite");
    const writer = new IndexWriter(file3);
    const add = async (name: string, code: string) => {
      const p = await fingerprintCode(code);
      writer.addPackage(name, [
        { name, version: "1.0.0", functions: p.functions.map((f) => f.hash), strings: [] },
      ]);
    };
    await add("small1", lib("small1", 1));
    await add("small2", lib("small2", 1));
    const join = (...parts: string[]) => parts.join("\n");
    await add("fatbundle", join(lib("small1", 1), lib("small2", 1), lib("fat", 1), lib("fat2", 1)));
    writer.close();
    const index = FingerprintIndex.open(file3);
    try {
      const text = join(lib("small1", 1), lib("small2", 1));
      const result = await matchBundles([{ id: "b", url: "u", text }], [index]);
      expect(result.packages.map((p) => p.name)).toEqual(["small1", "small2"]);
      const whole = await matchBundles(
        [{ id: "b", url: "u", text: join(text, lib("fat", 1), lib("fat2", 1)) }],
        [index],
      );
      expect(whole.packages.map((p) => p.name)).toContain("fatbundle");
    } finally {
      index.close();
    }
  });

  test("a handful of shared functions is not presence", async () => {
    const index = FingerprintIndex.open(file);
    try {
      const partial = lib("alpha", 1).split("\n").slice(0, 3).join("\n");
      const result = await matchBundles([{ id: "b", url: "u", text: partial }], [index]);
      expect(result.packages).toEqual([]);
    } finally {
      index.close();
    }
  });

  test("an overlay adds packages at query time", async () => {
    const overlay = path.join(tmp, "overlay.sqlite");
    await buildIndex(overlay, { gamma: { "0.1.0": lib("gamma", 1) } });
    const indexes = [FingerprintIndex.open(file), FingerprintIndex.open(overlay)];
    try {
      const result = await matchBundles([{ id: "b", url: "u", text: lib("gamma", 1) }], indexes);
      expect(result.packages.map((p) => p.name)).toEqual(["gamma"]);
    } finally {
      for (const i of indexes) i.close();
    }
  });

  test(`hashes shared by more than ${MAX_SHARING} packages are dropped`, async () => {
    const shared = path.join(tmp, "shared.sqlite");
    const helper = "function helper(a,b){return Object.keys(a).filter(k=>b.has(k)).length}";
    const packages: Record<string, Record<string, string>> = {};
    for (let i = 0; i <= MAX_SHARING; i++) packages[`p${i}`] = { "1.0.0": helper };
    await buildIndex(shared, packages);
    const index = FingerprintIndex.open(shared);
    try {
      expect(index.counts().hashes).toBe(0);
    } finally {
      index.close();
    }
  });

  test("adding versions again is a no-op, and new versions extend the bitsets", async () => {
    const inc = path.join(tmp, "inc.sqlite");
    await buildIndex(inc, { alpha: { "1.0.0": lib("alpha", 1) } });
    await buildIndex(inc, { alpha: { "1.0.0": lib("alpha", 1), "1.1.0": lib("alpha", 2) } });
    const once = path.join(tmp, "once.sqlite");
    await buildIndex(once, { alpha: { "1.0.0": lib("alpha", 1), "1.1.0": lib("alpha", 2) } });
    const index = FingerprintIndex.open(inc);
    const reference = FingerprintIndex.open(once);
    try {
      expect(index.packages.get(1)?.versions).toEqual(["1.0.0", "1.1.0"]);
      expect(index.counts()).toEqual(reference.counts());
      expect(index.packages.get(1)?.functions).toBe(reference.packages.get(1)?.functions);
      reference.close();
    } finally {
      index.close();
    }
  });

  test("a version listed twice is added once", async () => {
    const dup = path.join(tmp, "dup.sqlite");
    const p = await fingerprintCode(lib("alpha", 1));
    const v = {
      name: "alpha",
      version: "1.0.0",
      functions: p.functions.map((f) => f.hash),
      strings: [],
    };
    const writer = new IndexWriter(dup);
    expect(writer.addPackage("alpha", [v, v])).toBe(1);
    writer.close();
  });

  test("dropping a shared hash takes it off every owner's count", async () => {
    const counted = path.join(tmp, "counted.sqlite");
    const helper = "function helper(a,b){return Object.keys(a).filter(k=>b.has(k)).length}";
    const packages: Record<string, Record<string, string>> = {};
    for (let i = 0; i <= MAX_SHARING; i++) packages[`p${i}`] = { "1.0.0": helper };
    await buildIndex(counted, packages);
    const index = FingerprintIndex.open(counted);
    try {
      expect([...index.packages.values()].every((p) => p.functions === 0)).toBe(true);
    } finally {
      index.close();
    }
  });

  test("an index from another normalizer or schema is refused", async () => {
    const bad = path.join(tmp, "bad.sqlite");
    await buildIndex(bad, { alpha: { "1.0.0": lib("alpha", 1) } });
    const writer = new IndexWriter(bad);
    writer.setMeta({ schema_version: "999" });
    writer.close();
    expect(() => FingerprintIndex.open(bad)).toThrow(IndexError);
  });
});

describe("version descriptions", () => {
  test("one version, a minor range, a major range, or nothing", () => {
    expect(describeVersions(["4.17.21"])).toEqual({ version: "4.17.21", confident: true });
    expect(describeVersions(["4.17.20", "4.17.21"])).toEqual({
      version: "4.17.x",
      confident: true,
    });
    expect(describeVersions(["4.16.0", "4.17.21"])).toEqual({ version: "4.x", confident: false });
    expect(describeVersions(["3.0.0", "4.0.0"])).toEqual({ version: null, confident: false });
  });
});

describe("store", () => {
  test("pull downloads, verifies, decompresses and replaces older indexes", async () => {
    const source = path.join(tmp, "release.sqlite");
    await buildIndex(source, { alpha: { "1.0.0": lib("alpha", 1) } });
    const zst = zstdCompressSync(await readFile(source));
    const sha = createHash("sha256").update(zst).digest("hex");
    const dir = path.join(tmp, "pull");
    const release = (tag: string) => ({
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: [
        {
          name: `${tag}.sqlite.zst`,
          size: zst.length,
          browser_download_url: `https://dl/${tag}.zst`,
        },
        {
          name: `${tag}.sqlite.zst.sha256`,
          size: 80,
          browser_download_url: `https://dl/${tag}.sha`,
        },
      ],
    });
    let checksum = sha;
    const fakeFetch = async (url: string) => {
      if (url.includes("/releases"))
        return Response.json([
          release("fingerprints-2026-10-01"),
          release("fingerprints-2026-11-01"),
          release("v0.1.0"),
        ]);
      if (url.endsWith(".sha")) return new Response(`${checksum}  file\n`);
      if (url.endsWith(".zst")) return new Response(zst);
      return new Response("", { status: 404 });
    };
    const first = await pullIndex({ dir, fetch: fakeFetch });
    expect(first.tag).toBe("fingerprints-2026-11-01");
    expect(first.downloaded).toBe(true);
    expect(path.basename(first.path)).toBe("fingerprints-2026-11-01.sqlite");
    const again = await pullIndex({ dir, fetch: fakeFetch });
    expect(again.downloaded).toBe(false);

    const status = await indexStatus(dir, new Date("2026-12-15T00:00:00Z"));
    expect(status.shared?.packages).toBe(1);
    expect(status.shared?.ageDays).toBe(44);
    const opened = await openIndexes(dir, new Date("2026-12-15T00:00:00Z"));
    expect(opened.indexes).toHaveLength(1);
    expect(opened.warnings.join(" ")).toMatch(/44 days old.*s2s db pull/);
    for (const i of opened.indexes) i.close();

    checksum = "0".repeat(64);
    await expect(pullIndex({ dir: path.join(tmp, "pull-bad"), fetch: fakeFetch })).rejects.toThrow(
      PullError,
    );
  });

  test("a missing index is a warning, not an error", async () => {
    const opened = await openIndexes(path.join(tmp, "nowhere"));
    expect(opened.indexes).toEqual([]);
    expect(opened.warnings[0]).toMatch(/s2s db pull/);
  });

  test("the metadata corpus date wins over the file name", async () => {
    const dir = path.join(tmp, "named");
    await buildIndex(path.join(tmp, "named-src.sqlite"), { a: { "1.0.0": lib("a", 1) } });
    const { copyFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, "fingerprints-2026-01-01.sqlite");
    await copyFile(path.join(tmp, "named-src.sqlite"), target);
    await utimes(target, new Date(), new Date());
    const status = await indexStatus(dir, new Date("2026-11-04T00:00:00Z"));
    // The metadata's corpus date wins over the name.
    expect(status.shared?.date).toBe("2026-11-01");
  });
});
