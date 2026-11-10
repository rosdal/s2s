import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildLocal } from "../../fingerprints/src/local.js";
import { type CaptureOptions, capture } from "../src/capture/capture.js";
import { workspacePaths } from "../src/capture/workspace.js";
import { detect } from "../src/detect/run.js";
import { OVERLAY_FILE } from "../src/fingerprint/store.js";
import { maps } from "../src/maps/run.js";
import { scaffold } from "../src/scaffold/run.js";
import { unbundle } from "../src/unbundle/run.js";
import { verify } from "../src/verify/run.js";
import { readKeyframes } from "../src/webgl/assets.js";
import { diffSnapshots } from "../src/webgl/snapshot.js";
import { FIXTURES_DIR, type FixtureName, serveFixture } from "./helpers/fixtures.js";

/** Capture, unbundle, install, build and two keyframe walks: minutes, not seconds. */
const SLOW = 600_000;

let tmp: string;
let pnpmVersion: string | undefined;
/**
 * A fingerprint overlay with the fixtures' three and gsap, as `s2s db pull` gives a user, so
 * Stage 4 drops them as vendor code instead of keeping 700 KB of library in the recovered modules.
 */
let fingerprints: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-webgl-"));
  pnpmVersion = execSync("pnpm --version", { cwd: tmp, encoding: "utf8" }).trim();
  fingerprints = path.join(tmp, "fingerprints");
  await buildLocal({
    specs: ["three@0.187.0", "gsap@3.13.0", "@dimforge/rapier3d-compat@0.21.0"],
    out: path.join(fingerprints, OVERLAY_FILE),
  });
}, SLOW);
afterAll(async () => {
  if (process.env.S2S_KEEP_TMP) console.log(`kept ${tmp}`);
  else await rm(tmp, { recursive: true, force: true });
});

export const FAST = {
  version: "0.0.0-test",
  quietMs: 300,
  phaseTimeoutMs: 15_000,
  maskDelayMs: 0,
  delayMs: 0,
  viewports: ["desktop"],
} satisfies Partial<CaptureOptions>;

async function offline(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (route) => route.abort("internetdisconnected"),
  );
}

let runs = 0;
async function captured(
  name: FixtureName,
  extra: Partial<CaptureOptions> = {},
  serve: Parameters<typeof serveFixture>[1] = {},
): Promise<string> {
  const server = await serveFixture(name, serve);
  const outDir = path.join(tmp, `${name}-${runs++}`);
  try {
    const result = await capture({
      ...FAST,
      onContext: offline,
      ...extra,
      url: server.url,
      outDir,
    });
    expect(result.status).toBe("complete");
  } finally {
    await server.close();
  }
  return outDir;
}

const prepared = new Map<string, Promise<string>>();
/** Stages 1 to 4 once per fixture; callers copy the result before changing it. */
export function unbundled(name: FixtureName): Promise<string> {
  let known = prepared.get(name);
  if (!known) {
    known = (async () => {
      const dir = await captured(name);
      expect((await maps({ workspace: dir })).status).toBe("complete");
      const detected = await detect({
        workspace: dir,
        offline: true,
        fingerprints: { dir: fingerprints },
        managerVersion: (pm) => (pm === "pnpm" ? pnpmVersion : undefined),
      });
      expect(detected.status).toBe("complete");
      expect((await unbundle({ workspace: dir })).status).toBe("complete");
      return dir;
    })();
    prepared.set(name, known);
  }
  return known;
}

let copies = 0;
export async function copyOf(dir: string): Promise<string> {
  const out = path.join(tmp, "copies", `${path.basename(dir)}-${copies++}`);
  await cp(dir, out, { recursive: true });
  return out;
}

async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replaceAll("\\", "/"))
    .sort();
}

describe("WebGL capture", () => {
  test(
    "three-basic: two captures give byte-identical snapshots, screenshots and shaders",
    async () => {
      const a = await captured("three-basic");
      const b = await captured("three-basic");
      const files = await filesUnder(path.join(a, "raw", "webgl"));
      expect(files).toContain("index/desktop/t0.json");
      expect(files).toContain("index/desktop/t0.png");
      expect(files).toContain("index/desktop/s3.png");
      expect(files).toContain("shaders/index.json");
      expect(await filesUnder(path.join(b, "raw", "webgl"))).toEqual(files);
      const strip = (text: string) => text.replace(/http:\/\/127\.0\.0\.1:\d+/g, "<origin>");
      for (const file of files) {
        if (file.endsWith(".json")) {
          const left = await readFile(path.join(a, "raw", "webgl", file), "utf8");
          const right = await readFile(path.join(b, "raw", "webgl", file), "utf8");
          expect(strip(left), file).toBe(strip(right));
          continue;
        }
        const left = await readFile(path.join(a, "raw", "webgl", file));
        const right = await readFile(path.join(b, "raw", "webgl", file));
        expect(left.equals(right), file).toBe(true);
      }
      const shaders = JSON.parse(
        await readFile(path.join(a, "raw", "webgl", "shaders", "index.json"), "utf8"),
      ) as { name: string | null }[];
      expect(shaders.map((s) => s.name)).toContain("GlowMaterial");
      const later = JSON.parse(
        await readFile(path.join(a, "raw", "webgl", "index", "desktop", "s1.json"), "utf8"),
      );
      expect(later.full).toBe(false);
      expect(later.base).toBe("t0");
    },
    SLOW,
  );
});

describe("WebGL capture replays what it recorded", () => {
  test(
    "the snapshots come from the recorded responses, as verify replays them, not a later live load",
    async () => {
      // Each page load gets the next number, and the page moves its scene by it. Verify replays
      // the first recorded page, so the captured snapshots must show that one too.
      let served = 0;
      const dir = await captured(
        "three-basic",
        {},
        {
          html: (body) =>
            body.replace(
              "<head>",
              `<head><script>window.__THREE_DEVTOOLS__?.addEventListener("observe", (e) => { if (e.detail?.isScene) e.detail.position.x = ${++served}; });</script>`,
            ),
        },
      );
      expect(served).toBeGreaterThan(1);
      const t0 = JSON.parse(
        await readFile(path.join(dir, "raw", "webgl", "index", "desktop", "t0.json"), "utf8"),
      ) as { scenes: { nodes: { path: string; position: number[] }[] }[] };
      const world = t0.scenes[0]?.nodes.find((n) => n.path === "World");
      expect(world?.position[0]).toBe(1);
    },
    SLOW,
  );
});

describe("three recoverer through unbundle", () => {
  test(
    "three-basic: framework.json, signals and recovered shaders",
    async () => {
      const dir = await unbundled("three-basic");
      const framework = JSON.parse(
        await readFile(path.join(dir, "analysis", "framework.json"), "utf8"),
      );
      expect(framework.recoverer).toBe("three");
      expect(framework.flavour).toBe("vanilla");
      expect(framework.version).toBe("0.187");
      expect(framework.details.addons).toContain("GLTFLoader");
      expect(framework.details.companions).toContain("gsap/ScrollTrigger");
      expect(framework.unsupported).toEqual([]);

      const vert = await readFile(
        path.join(dir, "recovered", "unbundled", "shaders", "glow.vert.glsl"),
        "utf8",
      );
      const frag = await readFile(
        path.join(dir, "recovered", "unbundled", "shaders", "glow.frag.glsl"),
        "utf8",
      );
      expect(vert.startsWith("#include <common>")).toBe(true);
      expect(vert).toContain("uniform float uTime;");
      expect(frag).toContain("gl_FragColor");
      const record = JSON.parse(await readFile(path.join(dir, "analysis", "shaders.json"), "utf8"));
      const module = record.files.find(
        (f: { stage: string; name: string }) => f.stage === "vert" && f.name === "glow",
      ).module as string;
      const code = await readFile(path.join(dir, module), "utf8");
      expect(code).toMatch(
        /import glowVertexShader from "[./]*\/?shaders\/glow\.vert\.glsl\?raw";/,
      );
      expect(code).not.toContain("uniform float uTime;");
      // Built-in materials (the ground's MeshStandardMaterial) are not written out.
      expect(record.programs.some((p: { builtin: boolean }) => p.builtin)).toBe(true);
    },
    SLOW,
  );
});

async function glbNodeNames(file: string): Promise<string[]> {
  const { NodeIO } = await import("@gltf-transform/core");
  const doc = await new NodeIO().readBinary(new Uint8Array(await readFile(file)));
  return doc
    .getRoot()
    .listNodes()
    .map((n) => n.getName())
    .sort();
}

describe("three scaffold", () => {
  test(
    "three-basic proxy: builds, no original bytes in project/, same node names",
    async () => {
      const dir = await copyOf(await unbundled("three-basic"));
      const result = await scaffold({ workspace: dir, git: false, recoverer: { assets: "proxy" } });
      expect(result.error).toBeUndefined();
      expect(result.build, result.buildOutput).toBe("passed");
      const assets = JSON.parse(await readFile(path.join(dir, "analysis", "assets.json"), "utf8"));
      expect(assets.mode).toBe("proxy");
      expect(assets.checks.leak).toEqual({ passed: true, files: [] });
      const types = assets.assets.map(
        (a: { type: string; url: string }) => `${a.type} ${new URL(a.url).pathname}`,
      );
      expect(types).toContain("model /models/hero.glb");
      expect(types).toContain("texture /textures/ground.png");
      const hero = assets.assets.find((a: { type: string }) => a.type === "model");
      expect(hero.usedBy.nodes).toEqual(["World/Hero/Rig/Base", "World/Hero/Rig/Body"]);
      expect(hero.usedBy.modules.length).toBeGreaterThan(0);
      const original = path.join(FIXTURES_DIR, "three-basic", "dist", "models", "hero.glb");
      expect(await glbNodeNames(path.join(dir, "project", "public", "models", "hero.glb"))).toEqual(
        await glbNodeNames(original),
      );
      const md = await readFile(path.join(dir, "ASSETS.md"), "utf8");
      expect(md).toContain("### hero.glb");
      expect(md).toContain("- [ ] Replaced with my own");
      expect(md).not.toContain("Local study only");
      const agents = await readFile(path.join(dir, "AGENTS.md"), "utf8");
      expect(agents).toContain("## three.js scene");
      expect(agents).toContain("Never copy the site's original models");
      expect(existsSync(path.join(dir, "project", "src", "shaders", "glow.vert.glsl"))).toBe(true);
      expect(existsSync(path.join(dir, "project", "src", "scene", "graph.json"))).toBe(true);
      const framework = JSON.parse(
        await readFile(path.join(dir, "analysis", "framework.json"), "utf8"),
      );
      expect(framework.details.summary).toBe(
        "three r187 · 1 model → proxies · 1 custom shader · 6 keyframes",
      );

      // The untouched proxy scaffold matches the capture's scene graph at every keyframe.
      const verified = await verify({ workspace: dir, build: false, quietMs: 300 });
      expect(verified.error).toBeUndefined();
      const webgl = verified.report?.webgl ?? [];
      expect(webgl).toHaveLength(1);
      expect(webgl[0]?.keyframes.map((k) => k.keyframe)).toEqual([
        "t0",
        "t1000",
        "t3000",
        "s1",
        "s2",
        "s3",
      ]);
      expect(
        webgl[0]?.keyframes.filter((k) => !k.pass),
        JSON.stringify([verified.report?.checks, webgl[0]?.reasons], null, 1),
      ).toEqual([]);
      expect(
        verified.report?.checks.filter((c) => !c.pass),
        JSON.stringify(verified.report?.checks, null, 1),
      ).toEqual([]);
      expect(verified.exitCode).toBe(0);
    },
    SLOW,
  );
});

const readJson = async <T>(dir: string, file: string) =>
  JSON.parse(await readFile(path.join(dir, file), "utf8")) as T;

interface AssetsJson {
  mode: string;
  localOnly: boolean;
  checks: {
    leak: { passed: boolean; files: string[] } | null;
    unchangedCopies: { passed: boolean; files: string[] } | null;
    budgets: { passed: boolean; failures: string[] } | null;
  };
  assets: {
    type: string;
    url: string;
    output: {
      kind: string;
      derived: boolean;
      clone?: {
        staticTriangles: [number, number];
        animatedTriangles: [number, number];
        textures: { to: [number, number] }[];
      };
    };
  }[];
}

type Nodes = { path: string; quaternion: number[] }[];

describe("three fixtures", () => {
  test(
    "three-skinned clone: props simplified within budget, the rig still animates, notices written",
    async () => {
      const dir = await copyOf(await unbundled("three-skinned"));
      const result = await scaffold({
        workspace: dir,
        git: false,
        recoverer: { assets: "clone", cloneRatio: 0.25, cloneTexture: 128 },
      });
      expect(result.build, result.buildOutput).toBe("passed");
      const assets = await readJson<AssetsJson>(dir, "analysis/assets.json");
      expect(assets.localOnly).toBe(true);
      expect(assets.checks.budgets).toEqual({ passed: true, failures: [] });
      expect(assets.checks.unchangedCopies).toEqual({ passed: true, files: [] });
      const stage = assets.assets.find((a) => a.type === "model");
      const clone = stage?.output.clone;
      expect(stage?.output.derived).toBe(true);
      expect(clone?.staticTriangles[1]).toBeLessThan((clone?.staticTriangles[0] ?? 0) * 0.3);
      // The skinned body keeps every triangle.
      expect(clone?.animatedTriangles[1]).toBe(clone?.animatedTriangles[0]);
      expect(clone?.textures.every((t) => Math.max(...t.to) <= 128)).toBe(true);
      for (const file of ["ASSETS.md", "AGENTS.md", "project/README.md"])
        expect(await readFile(path.join(dir, file), "utf8"), file).toMatch(/local study only/i);
      // The rig animates in the capture...
      const t0 = await readJson<{ scenes: { nodes: Nodes }[] }>(
        dir,
        "raw/webgl/index/desktop/t0.json",
      );
      const t1 = await readJson<{ scenes: { changed: Nodes }[] }>(
        dir,
        "raw/webgl/index/desktop/t1000.json",
      );
      const spine = (nodes: Nodes) => nodes.find((n) => n.path.endsWith("/Spine"))?.quaternion;
      expect(spine(t1.scenes[0]?.changed ?? [])).toBeDefined();
      expect(spine(t1.scenes[0]?.changed ?? [])).not.toEqual(spine(t0.scenes[0]?.nodes ?? []));
      // ...and the clone matches it at every keyframe, canvas within 8%.
      const verified = await verify({ workspace: dir, build: false, quietMs: 300 });
      const webgl = verified.report?.webgl?.[0];
      expect(webgl?.mode).toBe("clone");
      expect(
        webgl?.keyframes.filter((k) => !k.pass),
        JSON.stringify(webgl, null, 1),
      ).toEqual([]);
      expect(webgl?.keyframes.every((k) => k.canvasDiff !== null && k.canvasDiff <= 0.08)).toBe(
        true,
      );
    },
    SLOW,
  );

  test(
    "three-compressed: decoders detected; proxies need none; original mode serves three's",
    async () => {
      const source = await unbundled("three-compressed");
      const requests = (await readFile(path.join(source, "raw", "requests.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { url: string; tags?: string[] });
      const tags = new Set(requests.flatMap((r) => r.tags ?? []));
      expect(tags).toContain("decoder:draco");
      expect(tags).toContain("decoder:basis");
      expect(tags).toContain("asset:model");
      expect(tags).toContain("asset:texture");
      const framework = await readJson<{ details: { decoders: string[]; addons: string[] } }>(
        source,
        "analysis/framework.json",
      );
      expect(framework.details.decoders).toEqual(["basis", "draco"]);
      expect(framework.details.addons).toEqual(
        expect.arrayContaining(["DRACOLoader", "GLTFLoader", "KTX2Loader"]),
      );

      const proxy = await copyOf(source);
      const proxied = await scaffold({
        workspace: proxy,
        git: false,
        install: false,
        build: false,
        recoverer: { assets: "proxy" },
      });
      expect(proxied.status).toBe("complete");
      const { NodeIO } = await import("@gltf-transform/core");
      const glb = await new NodeIO().readBinary(
        new Uint8Array(
          await readFile(path.join(proxy, "project", "public", "models", "sculpture.glb")),
        ),
      );
      expect(
        glb
          .getRoot()
          .listExtensionsUsed()
          .map((e) => e.extensionName),
      ).toEqual([]);
      const ktx = await readFile(path.join(proxy, "project", "public", "textures", "wall.ktx2"));
      expect(ktx.readUInt32LE(20)).toBe(4);
      const proxyAssets = await readJson<AssetsJson>(proxy, "analysis/assets.json");
      expect(proxyAssets.checks.leak?.passed).toBe(true);
      // No decoder file from the site is copied, in any mode.
      expect(existsSync(path.join(proxy, "project", "public", "draco"))).toBe(false);

      const original = await copyOf(source);
      const result = await scaffold({
        workspace: original,
        git: false,
        recoverer: { assets: "original" },
      });
      expect(result.build, result.buildOutput).toBe("passed");
      expect(await readFile(path.join(original, "project", "vite.config.ts"), "utf8")).toContain(
        "s2sDecoders()",
      );
      expect(existsSync(path.join(original, "project", "public", "draco"))).toBe(false);
      expect(
        existsSync(path.join(original, "project", "dist", "draco", "draco_wasm_wrapper.js")),
      ).toBe(true);
      expect(
        existsSync(path.join(original, "project", "dist", "basis", "basis_transcoder.wasm")),
      ).toBe(true);
      const verified = await verify({ workspace: original, build: false, quietMs: 300 });
      const webgl = verified.report?.webgl?.[0];
      expect(webgl?.mode).toBe("original");
      expect(
        webgl?.keyframes.filter((k) => !k.pass),
        JSON.stringify([verified.report?.checks, webgl], null, 1),
      ).toEqual([]);
      expect(webgl?.keyframes.every((k) => k.canvasDiff !== null && k.canvasDiff <= 0.03)).toBe(
        true,
      );
    },
    SLOW,
  );

  test(
    "r3f-scene: React Three Fiber detected; the scaffold takes the R3F layout",
    async () => {
      const dir = await copyOf(await unbundled("r3f-scene"));
      const framework = await readJson<{
        recoverer: string;
        flavour: string;
        details: { companions: string[] };
      }>(dir, "analysis/framework.json");
      expect(framework.recoverer).toBe("three");
      expect(framework.flavour).toBe("r3f");
      expect(framework.details.companions).toContain("@react-three/fiber");
      const result = await scaffold({ workspace: dir, git: false, install: false, build: false });
      expect(result.status).toBe("complete");
      expect(existsSync(path.join(dir, "project", "src", "components", "README.md"))).toBe(true);
      expect(existsSync(path.join(dir, "project", "src", "objects"))).toBe(false);
      expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain(
        "through React Three Fiber",
      );
      const graph = await readJson<{ nodes: { path: string }[] }[]>(
        dir,
        "project/src/scene/graph.json",
      );
      expect(graph[0]?.nodes.map((n) => n.path)).toEqual(
        expect.arrayContaining([expect.stringMatching(/\/Shelf\/Middle$/)]),
      );
      // React Three Fiber starts its renderer late and animates by per-frame deltas; a second
      // capture lands on the same frames, within float rounding (well inside verify's tolerance).
      const again = await captured("r3f-scene");
      const ids = ["t0", "t1000", "t3000"];
      const first = await readKeyframes(workspacePaths(dir), "index", "desktop", ids);
      const second = await readKeyframes(workspacePaths(again), "index", "desktop", ids);
      for (const id of ids) {
        const a = first.get(id);
        const b = second.get(id);
        expect(a && b, id).toBeTruthy();
        if (a && b) expect(diffSnapshots(a, b).differences, id).toEqual([]);
      }
    },
    SLOW,
  );

  test(
    "three-postfx: the custom pass comes back as GLSL and the composer as code",
    async () => {
      const dir = await copyOf(await unbundled("three-postfx"));
      const shaders = await readJson<{ files: { name: string; stage: string; source: string }[] }>(
        dir,
        "analysis/shaders.json",
      );
      const vignette = shaders.files.filter((f) => f.name.startsWith("vignette"));
      expect(vignette.map((f) => `${f.stage}:${f.source}`).sort()).toEqual([
        "frag:bundle",
        "vert:bundle",
      ]);
      const result = await scaffold({ workspace: dir, git: false });
      expect(result.build, result.buildOutput).toBe("passed");
      const named = await readJson<{ named: { specifier: string; export: string }[] }>(
        dir,
        "analysis/vendor-names.json",
      );
      expect(named.named.map((n) => `${n.specifier}#${n.export}`)).toEqual(
        expect.arrayContaining([
          "three/addons/postprocessing/EffectComposer.js#EffectComposer",
          "three/addons/postprocessing/RenderPass.js#RenderPass",
          "three/addons/postprocessing/ShaderPass.js#ShaderPass",
        ]),
      );
      // A pass the index doesn't cover stays as recovered code, still wired to the composer.
      const recovered = path.join(dir, "project", "src", "_recovered");
      const files = (await readdir(recovered, { recursive: true })).filter((f) =>
        f.endsWith(".js"),
      );
      const code = (
        await Promise.all(files.map((f) => readFile(path.join(recovered, f), "utf8")))
      ).join("\n");
      expect(code).toMatch(/luminosityThreshold|UnrealBloomPass/);
      expect(code).toMatch(/vignette(?:-shader)?\.(?:vert|frag)\.glsl\?raw/);
      const verified = await verify({ workspace: dir, build: false, quietMs: 300 });
      expect(
        verified.report?.webgl?.[0]?.keyframes.filter((k) => !k.pass),
        JSON.stringify(verified.report, null, 1),
      ).toEqual([]);
    },
    SLOW,
  );

  test(
    "three-physics: Rapier detected; bodies compared at t0 only",
    async () => {
      const dir = await copyOf(await unbundled("three-physics"));
      const framework = await readJson<{ details: { physics: string[] } }>(
        dir,
        "analysis/framework.json",
      );
      expect(framework.details.physics).toEqual(["@dimforge/rapier3d-compat"]);
      const result = await scaffold({ workspace: dir, git: false });
      expect(result.build, result.buildOutput).toBe("passed");
      const verified = await verify({ workspace: dir, build: false, quietMs: 300 });
      const webgl = verified.report?.webgl?.[0];
      expect(
        webgl?.keyframes.filter((k) => !k.pass),
        JSON.stringify([verified.report?.checks, webgl], null, 1),
      ).toEqual([]);
      expect(verified.exitCode).toBe(0);
    },
    SLOW,
  );
});
