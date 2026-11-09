import { describe, expect, test } from "vitest";
import { requestTags } from "../src/capture/request-log.js";
import { revisionIn } from "../src/recoverers/three/detect.js";
import { pinFiber, summaryText, threeOptions } from "../src/recoverers/three/scaffold.js";
import {
  bestExport,
  bundleDeclarations,
  nameVendorBindings,
  PackageReader,
  shapeOf,
} from "../src/scaffold/vendor-names.js";
import { classesReadBeforeDeclared } from "../src/unbundle/adapter.js";
import { parseCode } from "../src/unbundle/ast.js";
import { healSpans } from "../src/unbundle/inputs.js";
import { absorbSelfNamed, adoptRecords } from "../src/unbundle/split.js";
import {
  decodeHdr,
  encodeExr,
  encodeHdr,
  gradientPixels,
  imageSize,
  isKtx2,
  ktx2Rgba,
  pcm8Wav,
  placeholderPng,
  silentWav,
} from "../src/webgl/formats.js";
import { KeyframeSpecError, parseKeyframes, planKeyframes } from "../src/webgl/keyframes.js";
import { fittedShape, padVertices, shapeFor } from "../src/webgl/proxy.js";
import {
  foldChunks,
  isBuiltinProgram,
  literalStrings,
  looksLikeShader,
  matchPrograms,
  resolveIncludes,
  shaderBaseName,
} from "../src/webgl/shaders.js";
import {
  alignNodes,
  decodeSnapshot,
  diffSnapshots,
  encodeSnapshot,
  pairScenes,
  type SceneSnapshot,
  type SnapshotNode,
  sameScene,
} from "../src/webgl/snapshot.js";

describe("keyframes", () => {
  test("auto plans time steps at the top, then one scroll step per viewport height", () => {
    expect(planKeyframes("auto", 2).map((k) => k.id)).toEqual(["t0", "t1000", "t3000", "s1", "s2"]);
    expect(planKeyframes("auto", 40, 5)).toHaveLength(5);
  });

  test("a list runs time steps first and drops scroll steps past the page", () => {
    const spec = parseKeyframes("s2,t500,s9,t0");
    expect(planKeyframes(spec, 3).map((k) => k.id)).toEqual(["t0", "t500", "s2"]);
    expect(() => parseKeyframes("t0,x1")).toThrow(KeyframeSpecError);
  });
});

const node = (
  path: string,
  position: number[],
  extra: Partial<SnapshotNode> = {},
): SnapshotNode => ({
  path,
  name: path.split("/").pop() ?? null,
  type: "Object3D",
  parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
  visible: true,
  position,
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  ...extra,
});

const snap = (nodes: SnapshotNode[]): SceneSnapshot => ({
  revision: "187",
  renderer: null,
  canvas: [0, 0, 100, 100],
  camera: "Cam",
  scenes: [
    {
      name: "World",
      background: null,
      environment: null,
      fog: null,
      r3f: false,
      camera: null,
      nodes,
    },
  ],
  textures: [],
});

describe("snapshots", () => {
  const base = snap([
    node("World", [0, 0, 0]),
    node("World/A", [0, 0, 0]),
    node("World/B", [10, 0, 0]),
  ]);

  test("later keyframes store only what changed, and decode back", () => {
    const next = snap([
      node("World", [0, 0, 0]),
      node("World/A", [1, 2, 3]),
      node("World/C", [0, 1, 0]),
    ]);
    const stored = encodeSnapshot("s1", next, { keyframe: "t0", snapshot: base });
    expect(stored.full).toBe(false);
    if (stored.full) return;
    expect(stored.scenes[0]?.changed.map((n) => n.path)).toEqual(["World/A", "World/C"]);
    expect(stored.scenes[0]?.removed).toEqual(["World/B"]);
    expect(decodeSnapshot(stored, base)).toEqual(next);
  });

  test("the diff names the node and the limit", () => {
    const moved = snap([
      node("World", [0, 0, 0]),
      node("World/A", [3, 0, 0]),
      node("World/B", [10, 0, 0]),
    ]);
    const diff = diffSnapshots(base, moved);
    expect(diff.equal).toBe(false);
    expect(diff.differences).toEqual(["World/A: position off by 3 (limit 0.1)"]);
    expect(diffSnapshots(base, base).equal).toBe(true);
    // Transforms of ignored nodes (physics bodies) don't count.
    expect(diffSnapshots(base, moved, { ignoreTransforms: ["World/A"] }).equal).toBe(true);
  });

  test("a missing node, an extra node and a camera FOV change are reported", () => {
    const cam = (fov: number) => node("World/Cam", [0, 0, 5], { camera: { fov } });
    const a = snap([node("World", [0, 0, 0]), cam(45), node("World/B", [10, 0, 0])]);
    const b = snap([node("World", [0, 0, 0]), cam(50), node("World/D", [10, 0, 0])]);
    expect(diffSnapshots(a, b).differences).toEqual([
      "World/Cam: camera fov 50, expected 45",
      "World/B: missing",
      "World/D: not in the capture",
    ]);
  });
});

const CHUNKS = {
  common:
    "#define PI 3.141592653589793\n#define saturate( a ) clamp( a, 0.0, 1.0 )\nfloat pow2( const in float x ) { return x*x; }",
  begin_vertex: "vec3 transformed = vec3( position );",
  project_vertex:
    "vec4 mvPosition = vec4( transformed, 1.0 );\nmvPosition = modelViewMatrix * mvPosition;\ngl_Position = projectionMatrix * mvPosition;",
  nested:
    "#include <common>\nfloat twice( float x ) { return x * 2.0; } // a chunk that includes another",
};

describe("shaders", () => {
  test("includes resolve recursively and fold back, longest first", () => {
    const src = "#include <nested>\nvoid main() { gl_FragColor = vec4(twice(1.0)); }";
    const full = resolveIncludes(src, CHUNKS);
    expect(full).toContain("#define PI");
    expect(full).toContain("float twice");
    expect(foldChunks(full, CHUNKS)).toEqual({ text: src, folded: ["nested"] });
  });

  test("a program is matched to the literal it was built from; built-ins are recognised", () => {
    const code = "const v = `#include <common>\\nvoid main() { gl_Position = vec4(pow2(1.0)); }`;";
    const literals = literalStrings(code, looksLikeShader).map((l) => ({ ...l, file: "m.js" }));
    expect(literals).toHaveLength(1);
    const program = {
      id: "p1",
      name: "GlowMaterial",
      pages: ["index"],
      vertex: `#define SHADER_TYPE ShaderMaterial\n#define SHADER_NAME GlowMaterial\n${resolveIncludes(literals[0]?.value ?? "", CHUNKS)}`,
      fragment: "void main() { gl_FragColor = vec4(1.0); }",
    };
    const [match] = matchPrograms([program], literals, CHUNKS);
    expect(match?.vertex?.source).toBe(literals[0]?.value);
    expect(match?.builtin).toBe(false);
    expect(
      isBuiltinProgram(
        { ...program, vertex: "#define SHADER_TYPE MeshStandardMaterial\n" },
        CHUNKS,
      ),
    ).toBe(true);
    expect(shaderBaseName("GlowMaterial", "x")).toBe("glow");
    expect(shaderBaseName("Water Shader", "x")).toBe("water-shader");
    expect(shaderBaseName(null, "main-1")).toBe("main-1");
  });
});

describe("proxy shapes", () => {
  test("cubic bounds give a sphere, two equal sides a cylinder, the rest a box", () => {
    expect(shapeFor([1, 1.1, 0.95]).shape).toBe("sphere");
    expect(shapeFor([0.5, 2, 0.5])).toEqual({ shape: "cylinder", axis: 1 });
    expect(shapeFor([3, 0.2, 1]).shape).toBe("box");
  });

  test("a fitted shape fills exactly the bounds it replaces", () => {
    const { geo } = fittedShape([-1, 0, -2], [1, 4, 2]);
    const xs = geo.pos.filter((_, i) => i % 3 === 0);
    const ys = geo.pos.filter((_, i) => i % 3 === 1);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([-1, 1]);
    expect([Math.min(...ys), Math.max(...ys)].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([
      0, 4,
    ]);
  });

  test("a proxy keeps the original's vertex count, so per-vertex randomness stays in step", () => {
    const { geo } = fittedShape([-1, 0, -2], [1, 4, 2]);
    const triangles = geo.idx.length;
    padVertices(geo, 1_000);
    expect(geo.pos.length / 3).toBe(1_000);
    expect(geo.nor.length / 3).toBe(1_000);
    expect(geo.uv.length / 2).toBe(1_000);
    expect(geo.idx.length).toBe(triangles);
    const xs = geo.pos.filter((_, i) => i % 3 === 0);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([-1, 1]);
  });
});

describe("formats", () => {
  test("WAV placeholders keep the duration; clone audio is 96 kbps", () => {
    const silent = silentWav(1500, 8000);
    expect(silent.readUInt32LE(40)).toBe(12_000);
    const clone = pcm8Wav(new Float32Array(12_000), 12_000);
    expect(clone.readUInt32LE(28) * 8).toBe(96_000);
  });

  test("HDR round-trips; EXR and KTX2 headers are what three's loaders read", () => {
    const px = gradientPixels(8, 4);
    const back = decodeHdr(encodeHdr(8, 4, px));
    expect(back?.width).toBe(8);
    expect(Math.abs((back?.rgb[0] ?? 0) - (px[0] ?? 0))).toBeLessThan(0.01);
    const exr = encodeExr(4, 2, gradientPixels(4, 2));
    expect(exr.readUInt32LE(0)).toBe(20000630);
    const ktx = ktx2Rgba(4, 4, new Uint8Array(64));
    expect(isKtx2(ktx)).toBe(true);
    expect(imageSize(ktx)).toEqual({ width: 4, height: 4, format: "ktx2" });
    expect(imageSize(placeholderPng(5, 3))).toEqual({ width: 5, height: 3, format: "png" });
  });
});

describe("detection and naming", () => {
  test("decoders and 3D assets are tagged by path", () => {
    expect(requestTags("https://x.test/draco/draco_wasm_wrapper.js")).toEqual(["decoder:draco"]);
    expect(requestTags("https://x.test/basis/basis_transcoder.wasm")).toEqual(["decoder:basis"]);
    expect(requestTags("https://x.test/models/car.glb?v=2")).toEqual(["asset:model"]);
    expect(requestTags("https://x.test/a.js")).toEqual([]);
  });

  test("three's revision is read from minified code with any quote", () => {
    expect(revisionIn("window.__THREE__=`187`")).toBe("187");
    expect(revisionIn('new CustomEvent("register",{detail:{revision:"160"}})')).toBe("160");
    expect(revisionIn("var a=1")).toBeNull();
  });

  test("a bundle declaration is named after the export with the same shape", () => {
    const shape = (code: string) => {
      const stmt = parseCode(`(${code});`).program.body[0];
      return shapeOf(stmt?.type === "ExpressionStatement" ? stmt.expression : (stmt as never));
    };
    const exports = [
      {
        name: "Scene",
        shape: shape(
          "class extends B { constructor(){ super(); this.isScene = true; this.type = 'Scene'; this.fog = null } }",
        ),
      },
      {
        name: "Fog",
        shape: shape(
          "class { constructor(c){ this.isFog = true; this.name = ''; this.color = c } clone(){} }",
        ),
      },
    ];
    const minified = shape(
      "class extends q{constructor(){super(),this.isScene=!0,this.type=`Scene`,this.fog=null}}",
    );
    expect(bestExport(minified, exports)).toEqual({ name: "Scene", score: 1 });
    // One value under two names is not a tie.
    expect(
      bestExport(minified, [
        ...exports,
        { name: "default", shape: exports[0]?.shape as Set<string> },
      ])?.name,
    ).toBe("Scene");
  });

  test("scaffold options fall back to proxy and the defaults; the summary line reads well", () => {
    expect(threeOptions({ assets: "bogus", cloneRatio: 5 })).toEqual({
      assets: "proxy",
      cloneRatio: 0.25,
      cloneTexture: 512,
    });
    expect(summaryText("0.187", 12, "proxy", 9, 24)).toBe(
      "three r187 · 12 models → proxies · 9 custom shaders · 24 keyframes",
    );
    expect(summaryText("0.160", 1, "clone", 1, 1)).toBe(
      "three r160 · 1 model → clones · 1 custom shader · 1 keyframe",
    );
  });
});

describe("pinFiber", () => {
  test("pins the fiber major the project's React supports, with its reconciler", () => {
    const react18 = { dependencies: { react: "18.3.1" } };
    expect(pinFiber(react18, "8.18.0")).toBe("@react-three/fiber@8.18.0, react-reconciler@0.27.0");
    expect(react18.dependencies).toMatchObject({
      "@react-three/fiber": "8.18.0",
      "react-reconciler": "0.27.0",
    });
    // A fingerprint of the other major falls back to the range.
    expect(pinFiber({ dependencies: { react: "^19.1.0" } }, "8.18.0")).toBe(
      "@react-three/fiber@^9, react-reconciler@0.31.0",
    );
  });
  test("adds only the reconciler next to an existing fiber, and leaves no-React projects alone", () => {
    const pkg = { dependencies: { react: "18.3.1", "@react-three/fiber": "8.15.0" } };
    expect(pinFiber(pkg, "8.18.0")).toBe("react-reconciler@0.27.0");
    expect(pkg.dependencies["@react-three/fiber"]).toBe("8.15.0");
    expect(pinFiber(pkg, "8.18.0")).toBeNull();
    expect(pinFiber({ dependencies: {} }, "8.18.0")).toBeNull();
  });
});

describe("nameVendorBindings", () => {
  test("names aliases of a merged namespace, from another library when Stage 4 misfiled them", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "s2s-names-"));
    const lib = async (name: string, code: string) => {
      await mkdir(join(dir, "node_modules", name), { recursive: true });
      await writeFile(
        join(dir, "node_modules", name, "package.json"),
        JSON.stringify({ name, type: "module", main: "index.js" }),
      );
      await writeFile(join(dir, "node_modules", name, "index.js"), code);
    };
    const manager =
      "{ constructor() { this.onStart = 1; this.onLoad = 2; this.itemStart = 3; } resolveURL() {} }";
    await lib("liba", `export class LoadingManager ${manager}\nexport class Other { go() {} }`);
    await lib("libb", "export function render() {}");
    const code = [
      'import * as __b$0 from "libb";',
      'import * as __b$1 from "libb";',
      "const __b = { ...__b$0, ...__b$1 };",
      'import * as __a from "liba";',
      "const X = __b;",
      "export const m = new X();",
    ].join("\n");
    const bundle = bundleDeclarations(`class X ${manager}`);
    const out = await nameVendorBindings(code, bundle, (pkg) => new PackageReader(dir, pkg));
    expect(out.named).toMatchObject([{ local: "X", specifier: "liba", export: "LoadingManager" }]);
    expect(out.code).toContain('import { LoadingManager as X } from "liba";');
    expect(out.code).not.toContain("const X = __b");
  });
});

describe("adoptRecords", () => {
  const unit = (index: number, code: string, extra: Record<string, unknown> = {}) =>
    ({
      index,
      node: parseCode(code).program.body[0],
      exported: [],
      writes: new Set<number>(),
      mutates: new Set<number>(),
      dropped: null,
      declares: [],
      ...extra,
    }) as never;
  const react = { package: "react", version: null };
  test("CommonJS records only a dropped library fills point at that library", () => {
    const units = [
      unit(0, "var H = { exports: {} };"),
      unit(1, "var xt = {};"),
      unit(2, "xt.version = '18';", { mutates: new Set([1]), dropped: react }),
      unit(3, "H.exports = xt;", { mutates: new Set([0]), dropped: react }),
      // Kept code fills this one: it stays the site's own.
      unit(4, "var own = {};"),
      unit(5, "own.a = 1;", { mutates: new Set([4]) }),
    ];
    expect([...adoptRecords(units)]).toEqual([[0, "react"]]);
    expect((units as { dropped: unknown }[]).map((u) => u.dropped)).toEqual([
      null,
      react,
      react,
      react,
      null,
      null,
    ]);
  });
});

describe("nameVendorBindings copies", () => {
  test("a small library helper no package exports, when its free names are globals or the module's", async () => {
    const reader = () => new PackageReader("/nonexistent", "x");
    const code = [
      'import * as __s from "supa";',
      "var Dv = 1;",
      "const RO = __s;",
      "const Bad = __s;",
      "export const f = RO();",
    ].join("\n");
    const bundleCode =
      "var hidden = { n: 2 }; var RO = (n) => n ? n : typeof fetch == 'undefined' ? Dv : fetch; var Bad = () => hidden; var Dv = 1;";
    const out = await nameVendorBindings(
      code,
      bundleDeclarations(bundleCode),
      reader,
      [],
      bundleCode,
    );
    expect(out.copied).toEqual(["RO"]);
    expect(out.code).toContain(
      "const RO = (n) => n ? n : typeof fetch == 'undefined' ? Dv : fetch;",
    );
    // `hidden` is a bundle binding this module lacks: copying would break, so it stays.
    expect(out.code).toContain("const Bad = __s;");
  });
});

describe("absorbSelfNamed", () => {
  test("a statement naming the one library it touches is that library's code", () => {
    const fiber = { package: "@react-three/fiber", version: null };
    const gsap = { package: "gsap", version: null };
    const units = [
      { index: 0, node: parseCode("var wC = make();").program.body[0], dropped: fiber },
      {
        index: 1,
        node: parseCode('wC.inject({ rendererPackageName: "@react-three/fiber" });').program
          .body[0],
        uses: new Map([["wC", 0]]),
      },
      { index: 2, node: parseCode("var g = 1;").program.body[0], dropped: gsap },
      // Site code calls its library without naming the package: it stays.
      {
        index: 3,
        node: parseCode("g.registerPlugin(x);").program.body[0],
        uses: new Map([["g", 2]]),
      },
    ].map((u) => ({ exported: [], dropped: null, uses: new Map(), ...u })) as never[];
    absorbSelfNamed(units);
    expect((units as { dropped: unknown }[]).map((u) => u.dropped)).toEqual([
      fiber,
      fiber,
      gsap,
      null,
    ]);
  });
});

describe("nameVendorBindings copies helpers transitively", () => {
  test("a helper's own helper comes along, declared before it", async () => {
    const reader = () => new PackageReader("/nonexistent", "x");
    const code = [
      'import * as __s from "lib";',
      "const pe = __s;",
      "export const v = pe({}, {});",
    ].join("\n");
    const bundleCode =
      "var Tw = (n, e, t) => (n[e] = t); var pe = (n, e) => { for (var t in e) Tw(n, t, e[t]); return n; };";
    const out = await nameVendorBindings(
      code,
      bundleDeclarations(bundleCode),
      reader,
      [],
      bundleCode,
    );
    expect(out.copied.sort()).toEqual(["Tw", "pe"]);
    const at = (s: string) => out.code.indexOf(s);
    expect(at("const Tw = (n, e, t) => (n[e] = t);")).toBeGreaterThan(-1);
    expect(at("const Tw")).toBeLessThan(at("const pe"));
  });
});

describe("scene pairing", () => {
  const scene = (name: string, ...paths: string[]) => ({
    name,
    nodes: paths.map((path) => ({ path })),
  });
  test("two scenes of one name pair by the nodes they share, in any order", () => {
    const main = scene("Scene", "Scene", "Scene/Mesh#0", "Scene/Group#0");
    const minimap = scene("Scene", "Scene", "Scene/Sprite#0", "Scene/Sprite#1");
    const pairs = pairScenes([main, minimap], [minimap, main]);
    expect(pairs.get(0)).toBe(main);
    expect(pairs.get(1)).toBe(minimap);
  });
  test("keyframes of one walk pair by occurrence", () => {
    const a = [scene("Scene", "x"), scene("Scene", "y")];
    const b = [scene("Scene", "x2"), scene("Scene", "y2")];
    expect(sameScene(a, b, 1)).toBe(a[1]);
  });
});

describe("healSpans", () => {
  const span = (pkg: string, start: number, end: number) =>
    ({ package: pkg, version: null, start, end, method: "fingerprint", moduleKind: null }) as never;
  test("a tiny foreign match between two close ranges of one package closes the gap", () => {
    const out = healSpans([
      span("three", 0, 1000),
      span("gsap", 1100, 1191),
      span("three", 1300, 5000),
    ]) as {
      package: string;
      start: number;
      end: number;
    }[];
    expect(out.map((s) => [s.package, s.start, s.end])).toEqual([
      ["three", 0, 1000],
      ["three", 1000, 1300],
      ["three", 1300, 5000],
    ]);
  });
  test("a real range of another package stays", () => {
    const spans = [span("three", 0, 1000), span("gsap", 1100, 3000), span("three", 3100, 5000)];
    expect(healSpans(spans)).toEqual(spans);
  });
});

describe("classesReadBeforeDeclared", () => {
  test("a class read above its declaration in the same body is caught; a lazy read is not", () => {
    expect([...classesReadBeforeDeclared("((e) => { e.Buffer = u; class u {} })(x);")]).toEqual([
      "u",
    ]);
    expect([...classesReadBeforeDeclared("function f() { return new u(); } class u {}")]).toEqual(
      [],
    );
  });
});

describe("alignNodes", () => {
  const node = (path: string, parent: string | null, position: number[], source?: string) =>
    ({
      path,
      name: null,
      type: path === "Scene" ? "Scene" : "Mesh",
      parent,
      visible: true,
      position,
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      ...(source ? { source } : {}),
    }) as never;
  test("unnamed siblings added in another order pair by likeness, not by index", () => {
    const want = [
      node("Scene", null, [0, 0, 0]),
      node("Scene/Mesh#0", "Scene", [0, 0, 0], "/a.glb"),
      node("Scene/Mesh#1", "Scene", [5, 0, 0], "/b.glb"),
    ];
    const got = [
      node("Scene", null, [0, 0, 0]),
      node("Scene/Mesh#0", "Scene", [5, 0, 0], "/b.glb"),
      node("Scene/Mesh#1", "Scene", [0, 0, 0], "/a.glb"),
    ];
    const out = alignNodes(want, got) as { path: string; source?: string }[];
    expect(out.map((n) => [n.path, n.source ?? null])).toEqual([
      ["Scene", null],
      ["Scene/Mesh#1", "/b.glb"],
      ["Scene/Mesh#0", "/a.glb"],
    ]);
  });
});
