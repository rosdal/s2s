import { describe, expect, test } from "vitest";
import { requestTags } from "../src/capture/request-log.js";
import { revisionIn } from "../src/recoverers/three/detect.js";
import { summaryText, threeOptions } from "../src/recoverers/three/scaffold.js";
import { bestExport, shapeOf } from "../src/scaffold/vendor-names.js";
import { parseCode } from "../src/unbundle/ast.js";
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
import { fittedShape, shapeFor } from "../src/webgl/proxy.js";
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
  decodeSnapshot,
  diffSnapshots,
  encodeSnapshot,
  type SceneSnapshot,
  type SnapshotNode,
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
