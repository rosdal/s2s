import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright-core";
import { writeJsonAtomic } from "../fs-util.js";
import { decodePng, dynamicMask } from "../verify/image.js";
import { BodyStore } from "./body-store.js";
import { launchBrowser } from "./browser.js";
import { collectCdnPackages } from "./cdn.js";
import { BLIND_PROBE_GIVE_UP, Discovery } from "./discovery/run.js";
import { buildHar } from "./har.js";
import { type Manifest, newManifest, readManifest, writeManifest } from "./manifest.js";
import { isFirstParty } from "./origin.js";
import { RUNTIME_PROBE } from "./probe.js";
import { type CapturedAsset, Recorder, sleep, waitForQuiet } from "./recorder.js";
import { type Phase, RequestLog, readRequestLog } from "./request-log.js";
import { RobotsCache } from "./robots.js";
import { triggerLazyCode } from "./triggers.js";
import { cleanUrl, pageKey } from "./url.js";
import { pageSlug, type WorkspacePaths, workspacePaths, workspaceSlug } from "./workspace.js";

export type ViewportName = "desktop" | "mobile";

export const VIEWPORTS: Record<
  ViewportName,
  { width: number; height: number; mobile: boolean; scale: number }
> = {
  desktop: { width: 1440, height: 900, mobile: false, scale: 1 },
  mobile: { width: 390, height: 844, mobile: true, scale: 2 },
};

export const PROJECT_URL = "https://github.com/Rosdal/s2s";

export interface CaptureOptions {
  url: string;
  /** s2s version, recorded in the manifest and the user agent. */
  version: string;
  /** Workspace folder; defaults to `<cwd>/<host-path-slug>`. */
  outDir?: string;
  cwd?: string;
  force?: boolean;
  /** Link depth to crawl from the target (0 = target only). */
  depth?: number;
  maxPages?: number;
  /** Explicit page list; replaces link crawling. */
  pages?: string[];
  viewports?: ViewportName[];
  /** Playwright storage-state file for sites the user may access while logged in. */
  authState?: string;
  har?: boolean;
  ignoreRobots?: boolean;
  /** Parallel discovery and map fetches. */
  concurrency?: number;
  /** Pause between crawled pages, in ms. robots.txt Crawl-delay raises it. */
  delayMs?: number;
  /** How long the network must be idle to count as quiet. */
  quietMs?: number;
  /** Cap on waiting for quiet, per phase. */
  phaseTimeoutMs?: number;
  maxInteractions?: number;
  maxDiscoveryRounds?: number;
  maxDiscoveryFiles?: number;
  maxBodyBytes?: number;
  /**
   * Gap between the two screenshots of each page and viewport; regions that differ become the
   * dynamic mask `s2s verify` ignores. 0 takes one screenshot and no mask.
   */
  maskDelayMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: CaptureProgress) => void;
  headless?: boolean;
  executablePath?: string;
  /** Called for each new browser context before any page opens (tests use it to mock routes). */
  onContext?: (context: BrowserContext) => Promise<void> | void;
}

export type CaptureProgress =
  | { kind: "start"; workspace: string; url: string }
  | { kind: "skip"; workspace: string; reason: string }
  | {
      kind: "phase";
      phase: Phase | "snapshot" | "maps";
      viewport: string | null;
      page: string | null;
      url: string | null;
    }
  | {
      kind: "stats";
      requests: number;
      bytesStored: number;
      chunksDiscovered: number;
      mapsFound: number;
    }
  | { kind: "warning"; message: string }
  | {
      kind: "done";
      status: Manifest["stages"]["capture"]["status"];
      stats: Record<string, number>;
    };

export interface CaptureResult {
  workspace: string;
  status: Manifest["stages"]["capture"]["status"];
  skipped: boolean;
  stats: Record<string, number>;
  warnings: string[];
}

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(
      `robots.txt disallows ${url} for s2s. Re-run with --ignore-robots only if you are allowed to capture it.`,
    );
    this.name = "RobotsDisallowedError";
  }
}

const SKIP_LINK_EXT =
  /\.(pdf|zip|gz|tgz|rar|7z|dmg|exe|msi|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|wav|woff2?|ttf|xml|rss|json|txt|csv)$/i;

function resolvedOptions(options: CaptureOptions) {
  return {
    depth: options.depth ?? 0,
    maxPages: options.maxPages ?? 20,
    viewports: options.viewports ?? (["desktop", "mobile"] as ViewportName[]),
    har: options.har ?? false,
    ignoreRobots: options.ignoreRobots ?? false,
    concurrency: options.concurrency ?? 4,
    delayMs: options.delayMs ?? 1_000,
    quietMs: options.quietMs ?? 1_000,
    phaseTimeoutMs: options.phaseTimeoutMs ?? 30_000,
    maxInteractions: options.maxInteractions ?? 25,
    maxDiscoveryRounds: options.maxDiscoveryRounds ?? 5,
    maxDiscoveryFiles: options.maxDiscoveryFiles ?? 2_000,
    maxBodyBytes: options.maxBodyBytes ?? 50 * 1024 * 1024,
    maskDelayMs: options.maskDelayMs ?? 3_000,
  };
}

/** Clear everything a previous run wrote under `raw/` except the content-addressed bodies. */
async function resetRaw(paths: WorkspacePaths): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(paths.raw);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name !== "bodies")
      .map((name) => rm(path.join(paths.raw, name), { recursive: true, force: true })),
  );
}

/**
 * Stage 1: drive Chrome through the target (and optionally crawled pages) at each viewport, record
 * every request, trigger lazy code, discover chunks that never loaded, probe for source maps and
 * write it all to the workspace. Re-running on a complete workspace is a no-op unless `force`.
 */
export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const target = cleanUrl(options.url);
  if (!target) throw new Error(`Not an http(s) URL: ${options.url}`);
  const opts = resolvedOptions(options);
  const root = path.resolve(options.cwd ?? process.cwd(), options.outDir ?? workspaceSlug(target));
  const paths = workspacePaths(root);
  const progress = options.onProgress ?? (() => {});
  const signal = options.signal;

  let existing: Manifest | undefined;
  try {
    existing = await readManifest(paths.manifest);
  } catch (error) {
    // A corrupt or foreign manifest can only be replaced, never resumed.
    if (!options.force) {
      throw new Error(
        `${paths.manifest} is unreadable (${(error as Error).message.split("\n")[0]}). Use --force to replace the workspace.`,
      );
    }
  }
  if (existing) {
    if (pageKey(existing.targetUrl) !== pageKey(target) && !options.force) {
      throw new Error(
        `${root} holds a capture of ${existing.targetUrl}. Use another --out folder, or --force to replace it.`,
      );
    }
    if (existing.stages.capture.status === "complete" && !options.force) {
      progress({ kind: "skip", workspace: root, reason: "capture is already complete" });
      return {
        workspace: root,
        status: "complete",
        skipped: true,
        stats: existing.stages.capture.stats,
        warnings: existing.stages.capture.warnings,
      };
    }
  }

  const recordedOptions = {
    ...opts,
    pages: options.pages ?? null,
    authState: options.authState ? path.resolve(options.authState) : null,
  };
  const manifest = newManifest({
    s2sVersion: options.version,
    targetUrl: target.href,
    options: recordedOptions,
  });
  if (existing) manifest.createdAt = existing.createdAt;
  const startedAt = new Date();
  manifest.stages.capture = {
    status: "partial",
    startedAt: startedAt.toISOString(),
    stats: {},
    warnings: [],
  };
  await mkdir(paths.raw, { recursive: true });
  await resetRaw(paths);
  await writeManifest(paths.manifest, manifest);
  progress({ kind: "start", workspace: root, url: target.href });

  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    progress({ kind: "warning", message });
  };

  const store = new BodyStore(paths.bodies);
  const log = new RequestLog(paths.requests);
  await log.open();
  const recorder = new Recorder({ store, log, target, maxBodyBytes: opts.maxBodyBytes });
  const runtime: unknown[] = [];
  const pagesCaptured: { url: string; slug: string }[] = [];
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const discovery = new Discovery({
    request: () => {
      if (!context) throw new Error("no browser context");
      return context.request;
    },
    store,
    log,
    target,
    limits: {
      maxRounds: opts.maxDiscoveryRounds,
      maxFiles: opts.maxDiscoveryFiles,
      concurrency: opts.concurrency,
    },
    mapsDir: paths.maps,
    seen: recorder.seen,
  });

  let lastStats = 0;
  const emitStats = (force = false) => {
    const now = Date.now();
    if (!force && now - lastStats < 500) return;
    lastStats = now;
    progress({
      kind: "stats",
      requests: log.count,
      bytesStored: store.bytesWritten,
      chunksDiscovered: discovery.fetchedCount,
      mapsFound: discovery.maps.length,
    });
  };
  recorder.onRecord = () => emitStats();
  discovery.onFetch = () => emitStats();

  const onAbort = () => void browser?.close().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });

  const stats = () => ({
    pages: pagesCaptured.length,
    viewports: opts.viewports.length,
    requests: log.count,
    failedRequests: recorder.failed,
    bytesStored: store.bytesWritten,
    assets: recorder.assets.length,
    chunksDiscovered: discovery.fetchedCount,
    discoveryRounds: discovery.rounds,
    mapsFound: discovery.maps.length,
    blindProbesSkipped: discovery.blindProbesSkipped,
    durationMs: Date.now() - startedAt.getTime(),
  });

  let status: Manifest["stages"]["capture"]["status"] = "partial";
  let errorMessage: string | undefined;
  const allAssets: CapturedAsset[] = [];
  try {
    signal?.throwIfAborted();
    browser = await launchBrowser({
      ...(options.headless !== undefined ? { headless: options.headless } : {}),
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    });
    signal?.throwIfAborted();
    const userAgents = await buildUserAgents(browser, options.version);

    const documents: { url: string; html: string }[] = [];
    let pageQueue: { url: string; depth: number }[] = [];
    const queued = new Set<string>();
    // Crawled links stay on the target's origin, or the origin it redirects to (apex to www,
    // http to https). Listed pages may be anywhere on the same registrable domain.
    const crawlOrigins = new Set([target.origin]);
    const enqueue = (url: string, depth: number, listed = false): boolean => {
      const clean = cleanUrl(url, target);
      if (!clean || SKIP_LINK_EXT.test(clean.pathname)) return false;
      if (listed ? !isFirstParty(clean, target) : !crawlOrigins.has(clean.origin)) return false;
      const key = pageKey(clean);
      if (queued.has(key)) return true;
      queued.add(key);
      pageQueue.push({ url: clean.href, depth });
      return true;
    };
    enqueue(target.href, 0);
    for (const page of options.pages ?? []) {
      if (!enqueue(page, opts.depth, true))
        warn(`Skipped listed page ${page}: not a page on ${target.hostname}'s site`);
    }
    // Different URLs can slug the same (`/blog/post` and `/blog-post`); later ones get a suffix.
    const slugs = new Map<string, string>();
    const slugFor = (url: string): string => {
      const key = pageKey(url);
      const known = slugs.get(key);
      if (known) return known;
      let slug = pageSlug(url);
      const taken = new Set(slugs.values());
      for (let n = 2; taken.has(slug); n++) slug = `${pageSlug(url)}-${n}`;
      slugs.set(key, slug);
      return slug;
    };

    for (const [viewportIndex, viewport] of opts.viewports.entries()) {
      const primary = viewportIndex === 0;
      context = await newContext(browser, viewport, userAgents[viewport], options.authState);
      recorder.attach(context);
      await options.onContext?.(context);
      const robots = new RobotsCache(context.request);
      const list = primary ? pageQueue : pagesCaptured.map((p) => ({ url: p.url, depth: 0 }));

      for (let index = 0; index < list.length; index++) {
        signal?.throwIfAborted();
        const item = list[index];
        if (!item) break;
        if (primary && pagesCaptured.length >= opts.maxPages) break;

        if (primary && !opts.ignoreRobots && !(await robots.isAllowed(item.url))) {
          if (index === 0) throw new RobotsDisallowedError(item.url);
          warn(`Skipped ${item.url}: disallowed by robots.txt`);
          continue;
        }
        if (index > 0) {
          const crawlDelay = opts.ignoreRobots ? undefined : await robots.crawlDelayMs(item.url);
          await sleep(Math.max(opts.delayMs, crawlDelay ?? 0), signal);
        }

        const slug = slugFor(item.url);
        const pageResult = await capturePage({
          context,
          recorder,
          url: item.url,
          slug,
          viewport,
          phase: index === 0 ? "load" : "crawl",
          primary,
          paths,
          opts,
          progress,
          warn,
          ...(signal ? { signal } : {}),
        });
        if (!pageResult) {
          if (primary && index === 0) throw new Error(`Could not load ${item.url}`);
          continue;
        }
        runtime.push({ page: slug, viewport, ...pageResult.probe });
        if (primary) {
          pagesCaptured.push({ url: item.url, slug });
          if (pageResult.ssr !== undefined)
            documents.push({ url: pageResult.finalUrl, html: pageResult.ssr });
          documents.push({ url: pageResult.finalUrl, html: pageResult.dom });
          if (index === 0) crawlOrigins.add(new URL(pageResult.finalUrl).origin);
          if (!options.pages && item.depth < opts.depth) {
            for (const link of pageResult.links) enqueue(link, item.depth + 1);
          }
        }
      }

      // Discovery and map probing run through this context, so they share its cookies and headers.
      await recorder.drain();
      progress({ kind: "phase", phase: "discover", viewport, page: null, url: null });
      const newAssets = recorder.assets.filter((a) => !allAssets.includes(a));
      allAssets.push(...newAssets);
      const found = await discovery.run(
        newAssets,
        primary ? documents : [],
        (h) => store.read(h),
        signal,
      );
      allAssets.push(...found);
      progress({ kind: "phase", phase: "maps", viewport, page: null, url: null });
      await discovery.probeMaps(allAssets, (h) => store.read(h), signal);
      emitStats(true);
      await context.close();
      context = undefined;
      if (primary) pageQueue = [];
    }
    if (discovery.capped)
      warn("Chunk discovery hit its round or file cap; some chunks may be missing.");
    if (discovery.blindProbesSkipped > 0) {
      warn(
        `Stopped blind .map probing after ${BLIND_PROBE_GIVE_UP} misses in a row; skipped ${discovery.blindProbesSkipped} probes.`,
      );
    }
    status = "complete";
  } catch (error) {
    if (signal?.aborted) {
      status = "partial";
      errorMessage = "Interrupted";
    } else {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
      if (
        error instanceof RobotsDisallowedError ||
        (error as Error).name === "BrowserNotFoundError"
      ) {
        await finish();
        throw error;
      }
    }
  }
  await finish();
  return { workspace: root, status, skipped: false, stats: stats(), warnings };

  async function finish(): Promise<void> {
    signal?.removeEventListener("abort", onAbort);
    await recorder.drain().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await log.close();
    await writeJsonAtomic(paths.runtime, runtime);
    await writeJsonAtomic(paths.discovery, {
      rounds: discovery.rounds,
      capped: discovery.capped,
      fetched: discovery.fetchedCount,
      entries: discovery.entries,
    });
    await writeJsonAtomic(path.join(paths.maps, "index.json"), discovery.maps);
    const records = await readRequestLog(paths.requests).catch(() => []);
    await writeJsonAtomic(paths.cdnPackages, collectCdnPackages(records.map((r) => r.url)));
    if (opts.har) await writeJsonAtomic(paths.har, await buildHar(records, store, options.version));
    manifest.stages.capture = {
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      stats: stats(),
      warnings,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
    await writeManifest(paths.manifest, manifest);
    progress({ kind: "done", status, stats: stats() });
  }
}

export async function buildUserAgents(
  browser: Browser,
  version: string,
): Promise<Record<ViewportName, string>> {
  const suffix = `s2s/${version} (+${PROJECT_URL})`;
  const context = await browser.newContext();
  const page = await context.newPage();
  const base = await page.evaluate(() => navigator.userAgent);
  await context.close();
  const chromeVersion = /Chrome\/([\d.]+)/.exec(base)?.[1] ?? browser.version();
  return {
    desktop: `${base} ${suffix}`,
    mobile: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36 ${suffix}`,
  };
}

function newContext(
  browser: Browser,
  viewport: ViewportName,
  userAgent: string,
  authState: string | undefined,
): Promise<BrowserContext> {
  const spec = VIEWPORTS[viewport];
  const contextOptions: BrowserContextOptions = {
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: spec.scale,
    isMobile: spec.mobile,
    hasTouch: spec.mobile,
    userAgent,
    serviceWorkers: "block",
    reducedMotion: "reduce",
    ignoreHTTPSErrors: false,
    ...(authState ? { storageState: authState } : {}),
  };
  return browser.newContext(contextOptions);
}

interface PageResult {
  finalUrl: string;
  ssr: string | undefined;
  dom: string;
  links: string[];
  probe: Record<string, unknown>;
}

async function capturePage(input: {
  context: BrowserContext;
  recorder: Recorder;
  url: string;
  slug: string;
  viewport: ViewportName;
  phase: Phase;
  primary: boolean;
  paths: WorkspacePaths;
  opts: ReturnType<typeof resolvedOptions>;
  progress: (event: CaptureProgress) => void;
  warn: (message: string) => void;
  signal?: AbortSignal;
}): Promise<PageResult | undefined> {
  const { context, recorder, url, slug, viewport, opts, progress, warn, signal } = input;
  recorder.tag = { page: slug, viewport, phase: input.phase };
  progress({ kind: "phase", phase: input.phase, viewport, page: slug, url });
  const page: Page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
  // Errors the site logs on its own; verify only fails on errors the capture didn't have.
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  try {
    const deadline = Date.now() + opts.phaseTimeoutMs;
    let response: Awaited<ReturnType<Page["goto"]>> = null;
    try {
      response = await page.goto(url, { waitUntil: "load", timeout: opts.phaseTimeoutMs });
    } catch (error) {
      signal?.throwIfAborted();
      // A load event that never fires (slow third parties) is fine once the document is in.
      if (!page.url().startsWith("http")) {
        warn(`Failed to load ${url} (${viewport}): ${(error as Error).message.split("\n")[0]}`);
        return undefined;
      }
      warn(`${url} (${viewport}) did not finish loading within ${opts.phaseTimeoutMs} ms`);
    }
    if (!(await waitForQuiet(recorder, opts.quietMs, deadline, signal))) {
      warn(
        `${url} (${viewport}): network never went quiet during load; continued after ${opts.phaseTimeoutMs} ms`,
      );
    }

    progress({ kind: "phase", phase: "snapshot", viewport, page: slug, url });
    const finalUrl = page.url();
    let ssr: string | undefined;
    let dom = "";
    let links: string[] = [];
    if (input.primary) {
      const pageDir = path.join(input.paths.pages, slug);
      await mkdir(pageDir, { recursive: true });
      ssr = response ? await response.text().catch(() => undefined) : undefined;
      if (ssr !== undefined) await writeFile(path.join(pageDir, "ssr.html"), ssr);
      else warn(`${url}: no server-rendered HTML was available`);
      dom = await page.content();
      await writeFile(path.join(pageDir, "dom.html"), dom);
      await writeFile(path.join(pageDir, `dom.${viewport}.html`), dom);
      const meta = await page.evaluate(() => ({
        title: document.title,
        tags: [...document.querySelectorAll("link, script")].map((el) => ({
          tag: el.tagName.toLowerCase(),
          inHead: el.closest("head") !== null,
          attributes: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
          ...(el.tagName === "SCRIPT" && !el.hasAttribute("src")
            ? { inlineLength: el.textContent?.length ?? 0 }
            : {}),
        })),
      }));
      const redirects: string[] = [];
      for (let req = response?.request().redirectedFrom(); req; req = req.redirectedFrom())
        redirects.unshift(req.url());
      await writeJsonAtomic(path.join(pageDir, "page.json"), {
        url,
        finalUrl,
        status: response?.status() ?? null,
        redirects,
        title: meta.title,
        tags: meta.tags,
      });
      links = await page
        .$$eval("a[href]", (anchors) => anchors.map((a) => (a as HTMLAnchorElement).href))
        .catch(() => []);
    } else {
      // Other viewports keep their own DOM: a responsive app renders a different tree on each.
      const pageDir = path.join(input.paths.pages, slug);
      await mkdir(pageDir, { recursive: true });
      dom = await page.content();
      await writeFile(path.join(pageDir, `dom.${viewport}.html`), dom);
    }

    const probe = (await page.evaluate(RUNTIME_PROBE).catch((error: Error) => ({
      error: error.message,
    }))) as Record<string, unknown>;

    const shotDir = path.join(input.paths.screenshots, slug);
    await mkdir(shotDir, { recursive: true });
    const shoot = () =>
      page.screenshot({
        fullPage: true,
        animations: "disabled",
        caret: "hide",
        timeout: opts.phaseTimeoutMs,
      });
    try {
      const first = await shoot();
      await writeFile(path.join(shotDir, `${viewport}.png`), first);
      if (opts.maskDelayMs > 0) {
        // A second screenshot a few seconds later: what changed on its own (a clock, a carousel,
        // video) becomes the dynamic mask verify ignores.
        await sleep(opts.maskDelayMs, signal);
        const second = await shoot();
        const mask = dynamicMask(decodePng(first), decodePng(second));
        await writeJsonAtomic(path.join(shotDir, `${viewport}.mask.json`), mask);
      }
    } catch (error) {
      signal?.throwIfAborted();
      warn(
        `Screenshot failed for ${url} (${viewport}): ${(error as Error).message.split("\n")[0]}`,
      );
    }

    recorder.tag = { page: slug, viewport, phase: "interact" };
    progress({ kind: "phase", phase: "interact", viewport, page: slug, url });
    const report = await triggerLazyCode(page, recorder, {
      quietMs: opts.quietMs,
      deadline: Date.now() + opts.phaseTimeoutMs,
      maxInteractions: opts.maxInteractions,
      ...(signal ? { signal } : {}),
    });
    probe.interactions = report;
    probe.consoleErrors = consoleErrors;
    return { finalUrl, ssr, dom, links, probe };
  } finally {
    await page.close().catch(() => {});
  }
}
