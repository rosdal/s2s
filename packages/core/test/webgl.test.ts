import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildLocal } from "../../fingerprints/src/local.js";
import { type CaptureOptions, capture } from "../src/capture/capture.js";
import { detect } from "../src/detect/run.js";
import { OVERLAY_FILE } from "../src/fingerprint/store.js";
import { maps } from "../src/maps/run.js";
import { scaffold } from "../src/scaffold/run.js";
import { unbundle } from "../src/unbundle/run.js";
import { verify } from "../src/verify/run.js";
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
    specs: ["three@0.187.0", "gsap@3.13.0"],
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
async function captured(name: FixtureName, extra: Partial<CaptureOptions> = {}): Promise<string> {
  const server = await serveFixture(name);
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
