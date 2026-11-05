import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CaptureOptions, capture } from "../src/capture/capture.js";
import { detect } from "../src/detect/run.js";
import { maps } from "../src/maps/run.js";
import { unbundle } from "../src/unbundle/run.js";
import { type FixtureName, serveFixture } from "./helpers/fixtures.js";

let tmp: string;
let pnpmVersion: string | undefined;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-webgl-"));
  pnpmVersion = execSync("pnpm --version", { cwd: tmp, encoding: "utf8" }).trim();
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
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
  test("three-basic: two captures give byte-identical snapshots, screenshots and shaders", async () => {
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
  });
});
