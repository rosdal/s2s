import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright-core";
import type { BodyStore } from "../capture/body-store.js";
import { buildUserAgents, type ViewportName } from "../capture/capture.js";
import type { WorkspacePaths } from "../capture/workspace.js";
import { writeFileAtomic } from "../fs-util.js";
import type { FrameworkFile } from "../recoverers/api.js";
import { comparePixels, decodePng, encodePng, type Image, type Rect } from "../verify/image.js";
import type { ReplayIndex } from "../verify/replay.js";
import { installReplay } from "../verify/routes.js";
import { type AssetMode, type AssetsFile, readKeyframes, readWebglIndex } from "./assets.js";
import { webglDir } from "./capture-pass.js";
import type { Keyframe } from "./keyframes.js";
import {
  deterministicContext,
  launchDeterministicBrowser,
  loadDeterministic,
  walkKeyframes,
} from "./session.js";
import { diffSnapshots, type SceneSnapshot } from "./snapshot.js";

/** Canvas pixel-diff limits by asset mode; proxies only promise structure. */
export const CANVAS_LIMITS: Record<AssetMode, number | null> = {
  proxy: null,
  clone: 0.08,
  original: 0.03,
};

/** A rebuilt site may load its assets a few steps later; verify waits this long for a match. */
export const MAX_LAG_MS = 300;

export interface WebglKeyframeCheck {
  keyframe: string;
  /** Milliseconds past the keyframe's time the scene matched (0: on time). */
  lagMs: number;
  pass: boolean;
  differences: string[];
  canvasDiff: number | null;
  diffImage: string | null;
}

export interface WebglCheck {
  page: string;
  viewport: string;
  pass: boolean;
  reasons: string[];
  mode: AssetMode;
  canvasLimit: number | null;
  keyframes: WebglKeyframeCheck[];
}

function crop(image: Image, r: Rect): Image {
  const x0 = Math.max(0, Math.min(image.width, r.x));
  const y0 = Math.max(0, Math.min(image.height, r.y));
  const width = Math.max(0, Math.min(image.width - x0, r.width));
  const height = Math.max(0, Math.min(image.height - y0, r.height));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    data.set(
      image.data.subarray(
        ((y0 + y) * image.width + x0) * 4,
        ((y0 + y) * image.width + x0 + width) * 4,
      ),
      y * width * 4,
    );
  return { width, height, data } as Image;
}

/** Nodes a physics engine moves: their transforms change between the captured time steps. */
function physicsNodes(snaps: Map<string, SceneSnapshot>): string[] {
  const t0 = snaps.get("t0");
  if (!t0) return [];
  const moving = new Set<string>();
  for (const [id, snap] of snaps) {
    if (id === "t0" || !id.startsWith("t")) continue;
    for (const scene of snap.scenes) {
      const before = new Map(
        t0.scenes.find((s) => s.name === scene.name)?.nodes.map((n) => [n.path, n]),
      );
      for (const n of scene.nodes) {
        const b = before.get(n.path);
        if (
          b &&
          JSON.stringify([b.position, b.quaternion]) !== JSON.stringify([n.position, n.quaternion])
        )
          moving.add(n.path);
      }
    }
  }
  return [...moving];
}

/**
 * Replay the capture's keyframe walk on the rebuilt site with the same clock, seed and renderer,
 * and compare scene snapshots at every keyframe; in clone and original mode, also the canvas
 * pixels.
 */
export async function webglChecks(input: {
  paths: WorkspacePaths;
  framework: FrameworkFile;
  origin: string;
  dist: string;
  replay: ReplayIndex;
  store: BodyStore;
  viewports: ViewportName[];
  pages: string[];
  s2sVersion: string;
  headless?: boolean;
  executablePath?: string;
  signal?: AbortSignal;
  onPage?: (page: string, viewport: string) => void;
}): Promise<WebglCheck[]> {
  const { paths } = input;
  const index = await readWebglIndex(paths);
  if (!index) return [];
  const assets = await readFile(path.join(paths.analysis, "assets.json"), "utf8")
    .then((t) => JSON.parse(t) as AssetsFile)
    .catch(() => null);
  const mode: AssetMode = assets?.mode ?? "proxy";
  const withheld =
    mode === "original"
      ? new Set<string>()
      : new Set((assets?.assets ?? []).filter((a) => a.type !== "decoder").map((a) => a.bodyHash));
  const canvasLimit = CANVAS_LIMITS[mode];
  const physics = ((input.framework.details.physics as string[] | undefined) ?? []).length > 0;
  const checks: WebglCheck[] = [];
  let browser: Browser | undefined;
  const onAbort = () => void browser?.close().catch(() => {});
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    browser = await launchDeterministicBrowser({
      ...(input.headless !== undefined ? { headless: input.headless } : {}),
      ...(input.executablePath ? { executablePath: input.executablePath } : {}),
    });
    const agents = await buildUserAgents(browser, input.s2sVersion);
    for (const page of index.pages) {
      if (!input.pages.includes(page.slug)) continue;
      for (const v of page.viewports) {
        if (!input.viewports.includes(v.viewport)) continue;
        input.signal?.throwIfAborted();
        input.onPage?.(page.slug, v.viewport);
        const captured = await readKeyframes(
          paths,
          page.slug,
          v.viewport,
          v.keyframes.map((k) => k.id),
        );
        const ignore = physics ? physicsNodes(captured) : [];
        const reasons: string[] = [];
        const results: WebglKeyframeCheck[] = [];
        const context = await deterministicContext(browser, v.viewport, agents[v.viewport]);
        const tab = await context.newPage();
        const blocked = new Set<string>();
        await installReplay(tab, {
          origin: input.origin,
          dist: input.dist,
          replay: input.replay,
          store: input.store,
          blocked,
          onReplay: () => {},
          withheld,
        });
        try {
          const target = new URL(page.url);
          const loaded = await loadDeterministic(
            tab,
            `${input.origin}${target.pathname}${target.search}`,
            {
              baseMs: v.baseMs,
              clockStart: index.clockStart,
            },
          );
          if (loaded.timedOut) reasons.push("the network never went quiet while loading");
          const plan: Keyframe[] = v.keyframes.map((k) => ({
            id: k.id,
            kind: k.kind,
            value: k.value,
          }));
          const compare = (id: string, snap: SceneSnapshot) => {
            const want = captured.get(id);
            return want
              ? diffSnapshots(want, snap, {
                  geometry: mode === "original",
                  ...(id !== "t0" ? { ignoreTransforms: ignore } : {}),
                })
              : null;
          };
          await walkKeyframes(
            tab,
            plan,
            {
              baseMs: v.baseMs,
              maxKeyframes: plan.length,
              maxLagMs: MAX_LAG_MS,
              matches: (kf, snap) => snap !== null && (compare(kf.id, snap)?.equal ?? true),
            },
            async (k) => {
              const want = captured.get(k.keyframe.id);
              const differences: string[] = [];
              if (want && !k.snapshot) differences.push("no three.js scene reported itself");
              if (want && k.snapshot)
                differences.push(...(compare(k.keyframe.id, k.snapshot)?.differences ?? []));
              let canvasDiff: number | null = null;
              let diffImage: string | null = null;
              const rect = v.keyframes.find((r) => r.id === k.keyframe.id)?.canvases[0];
              const shot = path.join(
                webglDir(paths),
                page.slug,
                v.viewport,
                `${k.keyframe.id}.png`,
              );
              if (canvasLimit !== null && rect && existsSync(shot)) {
                const r = {
                  x: rect[0] ?? 0,
                  y: rect[1] ?? 0,
                  width: rect[2] ?? 0,
                  height: rect[3] ?? 0,
                };
                const result = comparePixels(
                  crop(decodePng(await readFile(shot)), r),
                  crop(decodePng(k.screenshot), r),
                  [],
                );
                canvasDiff = result.ratio;
                if (result.differing > 0) {
                  diffImage = `verify/diffs/webgl/${page.slug}/${v.viewport}/${k.keyframe.id}.png`;
                  await writeFileAtomic(path.join(paths.root, diffImage), encodePng(result.diff));
                }
                if (canvasDiff > canvasLimit)
                  differences.push(
                    `canvas pixels differ by ${(canvasDiff * 100).toFixed(2)}% (limit ${(canvasLimit * 100).toFixed(0)}%)`,
                  );
              }
              results.push({
                keyframe: k.keyframe.id,
                pass: differences.length === 0,
                differences,
                canvasDiff,
                diffImage,
                lagMs: k.lagMs,
              });
            },
          );
        } catch (error) {
          input.signal?.throwIfAborted();
          reasons.push(`the keyframe walk failed: ${(error as Error).message.split("\n")[0]}`);
        } finally {
          await context.close().catch(() => {});
        }
        const failed = results.filter((r) => !r.pass);
        if (failed.length > 0)
          reasons.push(
            `${failed.length} of ${results.length} keyframe${results.length === 1 ? "" : "s"} differ from the capture (${failed.map((f) => f.keyframe).join(", ")})`,
          );
        checks.push({
          page: page.slug,
          viewport: v.viewport,
          pass: reasons.length === 0,
          reasons,
          mode,
          canvasLimit,
          keyframes: results,
        });
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
  }
  return checks;
}
