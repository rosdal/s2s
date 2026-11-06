import type { Browser, BrowserContext, Page } from "playwright-core";
import { launchBrowser } from "../capture/browser.js";
import { VIEWPORTS, type ViewportName } from "../capture/capture.js";
import { DEFAULT_SEED, webglInitScript } from "./init-script.js";
import { type Keyframe, planKeyframes } from "./keyframes.js";
import type { SceneSnapshot } from "./snapshot.js";

/** Software WebGL, so every machine renders the same pixels. */
export const SOFTWARE_GL_ARGS = [
  "--use-angle=swiftshader",
  "--use-gl=angle",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--disable-gpu-rasterization",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
];

/** The fake clock starts here: 2023-11-14T22:13:20Z, a fixed instant. */
export const CLOCK_START = 1_700_000_000_000;
/** The clock is frozen this long after its start, before the page opens. */
export const PAUSE_AT_MS = 1_000;
/** Load runs on the frozen clock in steps of this many milliseconds. */
export const LOAD_STEP_MS = 100;
/**
 * Real milliseconds the network must be quiet before each load step. Capture and verify use the
 * same value, so a response and the decoding after it land on the same step in both.
 */
export const WEBGL_QUIET_MS = 300;
/** Loading gives up waiting for a renderer after this long on the clock. */
export const MAX_LOAD_MS = 20_000;
/** Real frames the page gets after each clock step. */
const SETTLE_FRAMES = 2;
/** Real milliseconds between clock steps, for work outside the fake clock. */
export const REAL_PAUSE_MS = 20;
/** The walk starts no earlier than this long after the clock starts. */
export const MIN_BASE_MS = 3_000;
/** A scroll keyframe settles when two snapshots this far apart are equal, or after the cap. */
export const SETTLE_STEP_MS = 100;
export const SETTLE_MAX_MS = 2_000;

export interface DeterministicSettings {
  seed: number;
  clockStart: number;
  /** Milliseconds after the clock start that the first keyframe is taken at. */
  baseMs: number;
}

export function launchDeterministicBrowser(options: {
  headless?: boolean;
  executablePath?: string;
}): Promise<Browser> {
  return launchBrowser({ ...options, args: SOFTWARE_GL_ARGS });
}

/** A context at device pixel ratio 1 with the WebGL instrumentation and a seeded `Math.random`. */
export async function deterministicContext(
  browser: Browser,
  viewport: ViewportName,
  userAgent: string,
  extra: { authState?: string; seed?: number } = {},
): Promise<BrowserContext> {
  const spec = VIEWPORTS[viewport];
  const context = await browser.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: 1,
    isMobile: spec.mobile,
    hasTouch: spec.mobile,
    userAgent,
    serviceWorkers: "block",
    // The choreography is the point here, so motion stays on.
    reducedMotion: "no-preference",
    ...(extra.authState ? { storageState: extra.authState } : {}),
  });
  await context.addInitScript(webglInitScript({ seed: extra.seed ?? DEFAULT_SEED, full: true }));
  return context;
}

/** Tracks in-flight requests on a page, so loading can wait for the network to go quiet. */
export function networkWatch(page: Page): {
  quiet(quietMs: number, deadline: number): Promise<boolean>;
  started(): number;
} {
  let inflight = 0;
  let total = 0;
  let last = Date.now();
  page.on("request", () => {
    inflight++;
    total++;
    last = Date.now();
  });
  const done = () => {
    inflight = Math.max(0, inflight - 1);
    last = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return {
    async quiet(quietMs, deadline) {
      while (Date.now() < deadline) {
        if (inflight === 0 && Date.now() - last >= quietMs) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    },
    started: () => total,
  };
}

/**
 * Open `url` on a frozen clock. Loading advances the clock in fixed steps, waiting for the network
 * to go quiet after each, so what the page sees (which responses arrived by which tick) is the same
 * on every run. Returns once the page is loaded and the clock sits at the walk's base time.
 */
export async function loadDeterministic(
  page: Page,
  url: string,
  options: {
    clockStart?: number;
    /** Use this base time (verify passes the capture's); otherwise one is chosen. */
    baseMs?: number;
    quietMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<{ baseMs: number; loadMs: number; finalUrl: string; timedOut: boolean }> {
  const clockStart = options.clockStart ?? CLOCK_START;
  const quietMs = options.quietMs ?? WEBGL_QUIET_MS;
  const timeoutMs = options.timeoutMs ?? 30_000;
  // install() starts the clock running; pausing a full second later lands on an exact time
  // however long the call took.
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart + PAUSE_AT_MS);
  const net = networkWatch(page);
  const deadline = Date.now() + timeoutMs;
  await page.goto(url, { waitUntil: "load", timeout: timeoutMs }).catch((error: Error) => {
    if (!page.url().startsWith("http")) throw error;
  });
  let elapsed = PAUSE_AT_MS;
  let calm = 0;
  let timedOut = false;
  let loadMs: number | undefined;
  let baseMs = options.baseMs;
  // Capture and verify step the same way all the way to the base time: wait for the network to go
  // quiet (which also gives decoding and parsing that follow a response time to finish), then one
  // clock step. Only the end differs: capture picks the base once the page is loaded.
  while (elapsed < (baseMs ?? MAX_LOAD_MS)) {
    if (!(await net.quiet(quietMs, deadline))) {
      timedOut = true;
      break;
    }
    const before = net.started();
    await page.clock.runFor(LOAD_STEP_MS);
    elapsed += LOAD_STEP_MS;
    await settle(page);
    if (net.started() !== before) {
      calm = 0;
      continue;
    }
    calm++;
    // Two quiet steps in a row, nothing new requested and a renderer up (React Three Fiber
    // creates its renderer only after a few rounds of layout and scheduling): loaded.
    if (loadMs === undefined && calm >= 2 && (await rendering(page))) {
      loadMs = elapsed;
      // A second of margin, rounded to whole two seconds, so a load a step slower or faster on
      // another run still lands on the same base time.
      baseMs ??= Math.max(MIN_BASE_MS, Math.ceil((loadMs + 1000) / 2000) * 2000);
    }
  }
  loadMs ??= elapsed;
  baseMs ??= Math.max(MIN_BASE_MS, Math.ceil((loadMs + 1000) / 2000) * 2000);
  if (elapsed < baseMs) await advance(page, baseMs - elapsed);
  await net.quiet(quietMs, Date.now() + 5_000);
  return { baseMs, loadMs, finalUrl: page.url(), timedOut };
}

/** Whether the page has a three renderer (or no instrumentation to ask). */
async function rendering(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const api = (
        window as unknown as {
          __s2sWebgl?: { summary(): { renderers: number; contexts: Record<string, number> } };
        }
      ).__s2sWebgl;
      if (!api) return true;
      const s = api.summary();
      return s.renderers > 0 || (s.contexts.webgpu ?? 0) > 0;
    })
    .catch(() => true);
}

/**
 * Move the frozen clock forward in fixed steps with a short real pause between them, so work the
 * fake clock doesn't drive (React's scheduler runs on MessageChannel, ResizeObserver on real
 * frames) gets to run between timer ticks, the same way on every run.
 */
export async function advance(page: Page, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= LOAD_STEP_MS) {
    await page.clock.runFor(Math.min(LOAD_STEP_MS, left));
    await settle(page);
  }
}

/**
 * Let the page catch up in real time after a clock step: two real frames (layout, resize
 * observers) and a drained task queue (React's scheduler), the same amount on every run.
 */
export async function settle(page: Page): Promise<void> {
  await page
    .evaluate(
      (n) =>
        (
          window as unknown as { __s2sWebgl?: { settle(n: number): Promise<void> } }
        ).__s2sWebgl?.settle(n),
      SETTLE_FRAMES,
    )
    .catch(() => {});
  await new Promise((r) => setTimeout(r, REAL_PAUSE_MS));
}

export function snapshotOf(page: Page): Promise<SceneSnapshot | null> {
  return page
    .evaluate(() => {
      const api = (window as unknown as { __s2sWebgl?: { snapshot(): unknown } }).__s2sWebgl;
      return api ? (api.snapshot() as SceneSnapshot) : null;
    })
    .catch(() => null);
}

async function scrollSteps(page: Page): Promise<number> {
  const { height, vh } = await page.evaluate(() => ({
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    vh: window.innerHeight,
  }));
  return vh > 0 ? Math.max(0, Math.ceil((height - vh) / vh - 0.01)) : 0;
}

export interface WalkedKeyframe {
  keyframe: Keyframe;
  scrollY: number;
  /** Clock milliseconds after the clock start. */
  clockMs: number;
  snapshot: SceneSnapshot | null;
  screenshot: Buffer;
  /** Canvas rectangles in CSS pixels, for masking the page diff. */
  canvases: number[][];
  /** How far past the keyframe's time the snapshot was taken to match (verify only). */
  lagMs: number;
}

/**
 * Walk the keyframes from the base time: time steps at the top first, then one scroll step at a
 * time, stepping the clock until the scene settles. Deterministic given the same page.
 */
export async function walkKeyframes(
  page: Page,
  spec: Keyframe[] | "auto",
  options: {
    baseMs: number;
    maxKeyframes?: number;
    signal?: AbortSignal;
    /**
     * Verify's check: when a snapshot doesn't match, the clock steps on (up to `maxLagMs`) and
     * tries again, since a rebuilt site may load its assets a step or two later.
     */
    matches?: (keyframe: Keyframe, snapshot: SceneSnapshot | null) => boolean;
    maxLagMs?: number;
  },
  onKeyframe: (k: WalkedKeyframe) => Promise<void>,
): Promise<Keyframe[]> {
  const plan = planKeyframes(spec, await scrollSteps(page), options.maxKeyframes);
  let clockMs = options.baseMs;
  const vh = await page.evaluate(() => window.innerHeight);
  const settleScroll = async () => {
    let previous = JSON.stringify(await snapshotOf(page));
    let stable = 0;
    for (let waited = 0; waited < SETTLE_MAX_MS; waited += SETTLE_STEP_MS) {
      await page.clock.runFor(SETTLE_STEP_MS);
      await settle(page);
      clockMs += SETTLE_STEP_MS;
      const next = JSON.stringify(await snapshotOf(page));
      stable = next === previous ? stable + 1 : 0;
      previous = next;
      if (stable >= 2) break;
    }
  };
  for (const keyframe of plan) {
    options.signal?.throwIfAborted();
    if (keyframe.kind === "time") {
      const target = options.baseMs + keyframe.value;
      if (target > clockMs) {
        await advance(page, target - clockMs);
        clockMs = target;
      }
    } else {
      await page.evaluate((y) => window.scrollTo(0, y), keyframe.value * vh);
      // Scroll events are dispatched on real frames; give the browser one before stepping.
      await new Promise((r) => setTimeout(r, 60));
      await settleScroll();
    }
    // Let the compositor present the last frame before the screenshot.
    await new Promise((r) => setTimeout(r, 60));
    const scrollY = await page.evaluate(() => Math.round(window.scrollY));
    let snapshot = await snapshotOf(page);
    let lagMs = 0;
    if (options.matches)
      while (!options.matches(keyframe, snapshot) && lagMs < (options.maxLagMs ?? 0)) {
        await page.clock.runFor(LOAD_STEP_MS);
        await settle(page);
        lagMs += LOAD_STEP_MS;
        clockMs += LOAD_STEP_MS;
        snapshot = await snapshotOf(page);
      }
    const canvases = await page
      .evaluate(() =>
        (window as unknown as { __s2sWebgl: { canvases(): number[][] } }).__s2sWebgl.canvases(),
      )
      .catch(() => [] as number[][]);
    const screenshot = await page.screenshot({ animations: "disabled", caret: "hide" });
    await onKeyframe({ keyframe, scrollY, clockMs, snapshot, screenshot, canvases, lagMs });
  }
  return plan;
}
