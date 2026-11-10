import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { BodyStore } from "../capture/body-store.js";
import type { ViewportName } from "../capture/capture.js";
import type { Recorder } from "../capture/recorder.js";
import type { RequestRecord } from "../capture/request-log.js";
import type { WorkspacePaths } from "../capture/workspace.js";
import { writeJsonAtomic } from "../fs-util.js";
import { ReplayIndex } from "../verify/replay.js";
import { installReplay } from "../verify/routes.js";
import { DEFAULT_SEED } from "./init-script.js";
import type { Keyframe } from "./keyframes.js";
import {
  CLOCK_START,
  deterministicContext,
  launchDeterministicBrowser,
  loadDeterministic,
  walkKeyframes,
} from "./session.js";
import { encodeSnapshot, type SceneSnapshot } from "./snapshot.js";

export const WEBGL_INDEX_VERSION = 1;

export interface WebglKeyframeRecord {
  id: string;
  kind: Keyframe["kind"];
  value: number;
  scrollY: number;
  clockMs: number;
  canvases: number[][];
  /** False when the page exposed no three scene at this keyframe. */
  snapshot: boolean;
}

/** `raw/webgl/index.json`. */
export interface WebglIndex {
  version: typeof WEBGL_INDEX_VERSION;
  seed: number;
  clockStart: number;
  revision: string | null;
  keyframes: string;
  maxKeyframes: number;
  pages: {
    slug: string;
    url: string;
    viewports: {
      viewport: ViewportName;
      baseMs: number;
      loadMs: number;
      keyframes: WebglKeyframeRecord[];
    }[];
  }[];
  shaders: number;
}

export interface ShaderProgramRecord {
  id: string;
  /** `SHADER_NAME` three writes into the program: the material's name, or empty. */
  name: string | null;
  vertex: string;
  fragment: string;
  pages: string[];
}

export function webglDir(paths: WorkspacePaths): string {
  return path.join(paths.raw, "webgl");
}

export interface WebglPassInput {
  paths: WorkspacePaths;
  pages: { url: string; slug: string }[];
  viewports: ViewportName[];
  userAgents: Record<ViewportName, string>;
  recorder?: Recorder;
  /**
   * Take the snapshots from a replay of what the capture recorded, as verify does, after a live
   * run that records it. Without this, the snapshots come from the live run.
   */
  replay?: { records: () => RequestRecord[]; store: BodyStore };
  keyframes: Keyframe[] | "auto";
  keyframesSpec: string;
  maxKeyframes: number;
  quietMs: number;
  phaseTimeoutMs: number;
  authState?: string;
  headless?: boolean;
  executablePath?: string;
  onContext?: (context: BrowserContext) => Promise<void> | void;
  warn: (message: string) => void;
  onPage?: (page: string, viewport: string) => void;
  signal?: AbortSignal;
}

const shaderName = (vertex: string) =>
  /#define SHADER_NAME ([^\n]*)/.exec(vertex)?.[1]?.trim() || null;

/**
 * The deterministic WebGL pass: every captured page at every viewport on a frozen clock, a seeded
 * `Math.random` and software rendering; at each keyframe a screenshot and a scene snapshot, and
 * the final GLSL of every program linked along the way.
 */
export async function webglPass(input: WebglPassInput): Promise<WebglIndex> {
  const dir = webglDir(input.paths);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const index: WebglIndex = {
    version: WEBGL_INDEX_VERSION,
    seed: DEFAULT_SEED,
    clockStart: CLOCK_START,
    revision: null,
    keyframes: input.keyframesSpec,
    maxKeyframes: input.maxKeyframes,
    pages: [],
    shaders: 0,
  };
  const programs = new Map<string, ShaderProgramRecord>();
  let browser: Browser | undefined;
  const onAbort = () => void browser?.close().catch(() => {});
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    browser = await launchDeterministicBrowser({
      ...(input.headless !== undefined ? { headless: input.headless } : {}),
      ...(input.executablePath ? { executablePath: input.executablePath } : {}),
    });
    for (const page of input.pages) {
      const entry: WebglIndex["pages"][number] = { slug: page.slug, url: page.url, viewports: [] };
      index.pages.push(entry);
      for (const viewport of input.viewports) {
        input.signal?.throwIfAborted();
        input.onPage?.(page.slug, viewport);
        const open = async (record: boolean) => {
          const context = await deterministicContext(
            browser as Browser,
            viewport,
            input.userAgents[viewport],
            { ...(input.authState ? { authState: input.authState } : {}) },
          );
          if (record && input.recorder) {
            input.recorder.tag = { page: page.slug, viewport, phase: "webgl" };
            input.recorder.attach(context);
          }
          await input.onContext?.(context);
          const tab = await context.newPage();
          tab.on("dialog", (d) => void d.dismiss().catch(() => {}));
          return { context, tab };
        };
        const load = (tab: Page) =>
          loadDeterministic(tab, page.url, {
            quietMs: input.quietMs,
            timeoutMs: input.phaseTimeoutMs,
          });
        if (input.replay) {
          // Live, the order in which responses arrive within a clock step is the network's, and
          // what runs in between (an animation drawing Math.random(), say) shifts with it. Verify
          // replays the capture, so the snapshots come from replaying it too: one live run records
          // every response the load and the walk need, then a replayed run takes the snapshots.
          const live = await open(true);
          try {
            const loaded = await load(live.tab);
            await walkKeyframes(
              live.tab,
              input.keyframes,
              {
                baseMs: loaded.baseMs,
                maxKeyframes: input.maxKeyframes,
                ...(input.signal ? { signal: input.signal } : {}),
              },
              async () => {},
            );
          } finally {
            await live.context.close().catch(() => {});
          }
          await input.recorder?.drain();
        }
        const { context, tab } = await open(!input.replay);
        if (input.replay) {
          await installReplay(tab, {
            origin: new URL(page.url).origin,
            dist: null,
            replay: new ReplayIndex(input.replay.records(), page.url, { site: true }),
            store: input.replay.store,
            blocked: new Set<string>(),
            onReplay: () => {},
          });
        }
        try {
          const loaded = await load(tab);
          if (loaded.timedOut)
            input.warn(
              `${page.url} (${viewport}): the network never went quiet in the WebGL pass; keyframes may not be repeatable`,
            );
          const out = path.join(dir, page.slug, viewport);
          await mkdir(out, { recursive: true });
          const records: WebglKeyframeRecord[] = [];
          let base: { keyframe: string; snapshot: SceneSnapshot } | undefined;
          await walkKeyframes(
            tab,
            input.keyframes,
            {
              baseMs: loaded.baseMs,
              maxKeyframes: input.maxKeyframes,
              ...(input.signal ? { signal: input.signal } : {}),
            },
            async (k) => {
              await writeFile(path.join(out, `${k.keyframe.id}.png`), k.screenshot);
              if (k.snapshot) {
                index.revision ??= k.snapshot.revision;
                await writeJsonAtomic(
                  path.join(out, `${k.keyframe.id}.json`),
                  encodeSnapshot(k.keyframe.id, k.snapshot, base),
                );
                base ??= { keyframe: k.keyframe.id, snapshot: k.snapshot };
              }
              records.push({
                id: k.keyframe.id,
                kind: k.keyframe.kind,
                value: k.keyframe.value,
                scrollY: k.scrollY,
                clockMs: k.clockMs,
                canvases: k.canvases,
                snapshot: k.snapshot !== null,
              });
            },
          );
          if (!records.some((r) => r.snapshot))
            input.warn(
              `${page.url} (${viewport}): no three.js scene reported itself (a bundled three without devtools hooks, or no WebGL); only screenshots were kept`,
            );
          entry.viewports.push({
            viewport,
            baseMs: loaded.baseMs,
            loadMs: loaded.loadMs,
            keyframes: records,
          });
          const linked = (await tab
            .evaluate(() =>
              (
                window as unknown as { __s2sWebgl?: { programs(): unknown } }
              ).__s2sWebgl?.programs(),
            )
            .catch(() => [])) as { vertex: string; fragment: string }[] | undefined;
          for (const p of linked ?? []) {
            const key = createHash("sha256").update(`${p.vertex}\0${p.fragment}`).digest("hex");
            const known = programs.get(key);
            if (known) {
              if (!known.pages.includes(page.slug)) known.pages.push(page.slug);
              continue;
            }
            programs.set(key, {
              id: key.slice(0, 12),
              name: shaderName(p.vertex),
              vertex: p.vertex,
              fragment: p.fragment,
              pages: [page.slug],
            });
          }
        } finally {
          await context.close().catch(() => {});
        }
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
  }
  const shaderDir = path.join(dir, "shaders");
  await mkdir(shaderDir, { recursive: true });
  const list = [...programs.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const p of list) {
    await writeFile(path.join(shaderDir, `${p.id}.vert.glsl`), p.vertex);
    await writeFile(path.join(shaderDir, `${p.id}.frag.glsl`), p.fragment);
  }
  await writeJsonAtomic(
    path.join(shaderDir, "index.json"),
    list.map((p) => ({
      id: p.id,
      name: p.name,
      vertex: `${p.id}.vert.glsl`,
      fragment: `${p.id}.frag.glsl`,
      pages: p.pages.sort(),
    })),
  );
  index.shaders = list.length;
  await writeJsonAtomic(path.join(dir, "index.json"), index);
  return index;
}
