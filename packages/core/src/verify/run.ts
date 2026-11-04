import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { BodyStore } from "../capture/body-store.js";
import { launchBrowser } from "../capture/browser.js";
import { buildUserAgents, VIEWPORTS, type ViewportName } from "../capture/capture.js";
import { readManifest } from "../capture/manifest.js";
import { readRequestLog } from "../capture/request-log.js";
import { type WorkspacePaths, workspacePaths } from "../capture/workspace.js";
import { PACKAGE_MANAGERS, type PackageManager } from "../detect/project.js";
import { writeFileAtomic, writeJsonAtomic } from "../fs-util.js";
import { runScript } from "../scaffold/exec.js";
import type { Thresholds } from "../scaffold/facts.js";
import { loadThresholds } from "./config.js";
import { DOM_SIMILARITY, type DomResult } from "./dom.js";
import { comparePixels, decodePng, encodePng, type Rect } from "./image.js";
import { ReplayIndex } from "./replay.js";
import { renderReportMd } from "./report.js";

export interface VerifyOptions {
  workspace: string;
  cwd?: string;
  /** Page slugs (folder names under `raw/pages/`) to check; all by default. */
  pages?: string[];
  viewports?: string[];
  /** Accept the current screenshots as the new baseline. For people, never for the agent. */
  updateBaseline?: boolean;
  /** Build before checking. Defaults to true. */
  build?: boolean;
  /** How long the network must be quiet before the screenshot. */
  quietMs?: number;
  timeoutMs?: number;
  headless?: boolean;
  executablePath?: string;
  signal?: AbortSignal;
  onProgress?: (event: VerifyProgress) => void;
}

export type VerifyProgress =
  | { kind: "build" }
  | { kind: "page"; page: string; viewport: string }
  | { kind: "done"; exitCode: number; summary: string };

/** 0 pass, 1 regression, 2 build failed, 3 verify itself failed. */
export type VerifyExitCode = 0 | 1 | 2 | 3;

export interface PageCheck {
  page: string;
  viewport: string;
  url: string;
  pass: boolean;
  reasons: string[];
  /** Share of differing pixels, or `null` without a baseline screenshot. */
  pixelDiff: number | null;
  baseline: "capture" | "accepted" | "none";
  worstRegions: Rect[];
  diffImage: string | null;
  masked: number;
  domSimilarity: number;
  /**
   * What the DOM was compared with: this viewport's own capture, the primary viewport's (a
   * capture from before s2s kept one per viewport), or nothing.
   */
  domBaseline: "viewport" | "primary" | "none";
  domMissing: string[];
  domExtra: string[];
  newConsoleErrors: string[];
  knownConsoleErrors: number;
  failedRequests: { url: string; status: number | string }[];
  blockedRequests: string[];
  replayed: number;
}

export interface VerifyReport {
  at: string;
  status: "pass" | "regression";
  thresholds: Thresholds;
  baselineUpdated: boolean;
  checks: PageCheck[];
  sinceLastPass: {
    at: string;
    changes: {
      page: string;
      viewport: string;
      pixelDiff: [number | null, number | null];
      domSimilarity: [number, number];
    }[];
  } | null;
}

export interface VerifyResult {
  workspace: string;
  exitCode: VerifyExitCode;
  summary: string;
  report?: VerifyReport;
  /** First 50 lines of a failed build. */
  buildOutput?: string;
  error?: string;
}

interface HistoryLine {
  at: string;
  status: "pass" | "regression" | "build-failed";
  checks: {
    page: string;
    viewport: string;
    pass: boolean;
    pixelDiff: number | null;
    domSimilarity: number;
  }[];
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** For example "pass · 2 checks" or "regression · 1 of 2 checks failed". */
export function summaryLine(report: VerifyReport): string {
  const failed = report.checks.filter((c) => !c.pass).length;
  const n = report.checks.length;
  const checks = `${n} check${n === 1 ? "" : "s"}`;
  return failed === 0 ? `pass · ${checks}` : `regression · ${failed} of ${checks} failed`;
}

/**
 * Build the project, serve it with the captured responses replayed, and compare every captured
 * page and viewport with the capture: pixels (dynamic regions masked), DOM tree, console errors
 * and failed requests. Writes `verify/report.json`, `verify/report.md`, diff images and a line in
 * `verify/history.jsonl`. Never touches the real site.
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const root = path.resolve(options.cwd ?? process.cwd(), options.workspace);
  const paths = workspacePaths(root);
  const progress = options.onProgress ?? (() => {});
  const fail = (error: string): VerifyResult => {
    progress({ kind: "done", exitCode: 3, summary: error });
    return { workspace: root, exitCode: 3, summary: "verify failed", error };
  };
  try {
    const manifest = await readManifest(paths.manifest).catch(() => undefined);
    if (!manifest) return fail(`No workspace at ${root}. Run "s2s grab <url>" first.`);
    if (!existsSync(path.join(paths.project, "index.html")))
      return fail(`${root} has no project. Run "s2s scaffold" first.`);
    const thresholds = await loadThresholds(paths.config);
    const pm = packageManager(manifest.stages.scaffold.details, await readPm(paths));

    if (options.build !== false) {
      progress({ kind: "build" });
      const build = await runScript(paths.project, pm, "build", options.signal);
      if (options.signal?.aborted) return fail("Interrupted");
      if (build.exitCode !== 0) {
        const buildOutput = build.output.trim().split("\n").slice(0, 50).join("\n");
        await mkdir(paths.verify, { recursive: true });
        await appendFile(
          paths.verifyHistory,
          `${JSON.stringify({ at: new Date().toISOString(), status: "build-failed", checks: [] } satisfies HistoryLine)}\n`,
        );
        progress({ kind: "done", exitCode: 2, summary: "build failed" });
        return { workspace: root, exitCode: 2, summary: "build failed", buildOutput };
      }
    }
    const dist = path.join(paths.project, "dist");
    if (!existsSync(path.join(dist, "index.html")))
      return fail("project/dist/index.html is missing after the build.");

    const report = await check(paths, manifest.targetUrl, thresholds, dist, options, progress);
    await writeReport(paths, report);
    const exitCode: VerifyExitCode = report.status === "pass" ? 0 : 1;
    const summary = summaryLine(report);
    progress({ kind: "done", exitCode, summary });
    return { workspace: root, exitCode, summary, report };
  } catch (error) {
    if (options.signal?.aborted) return fail("Interrupted");
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
}

async function readPm(paths: WorkspacePaths): Promise<string | undefined> {
  try {
    const file = JSON.parse(await readFile(path.join(paths.analysis, "packages.json"), "utf8")) as {
      packageManager?: { name?: string };
    };
    return file.packageManager?.name;
  } catch {
    return undefined;
  }
}

function packageManager(
  _details: Record<string, unknown> | undefined,
  name: string | undefined,
): PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(name ?? "")
    ? (name as PackageManager)
    : "npm";
}

/** Serve `dist/` on localhost; unknown paths that look like pages get `index.html`. */
async function serveDist(dist: string): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const decoded = safeDecode(url.pathname);
      if (decoded === undefined) {
        res.writeHead(400).end();
        return;
      }
      let file = path.join(dist, decoded);
      if (!file.startsWith(dist)) {
        res.writeHead(403).end();
        return;
      }
      try {
        if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
        const body = await readFile(file);
        res.writeHead(200, {
          "content-type":
            CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(body);
      } catch {
        // Only page navigations fall back to index.html; a fetch for missing data must 404.
        const accept = req.headers.accept ?? "";
        if (accept.includes("text/html")) {
          res.writeHead(200, { "content-type": CONTENT_TYPES[".html"] as string });
          res.end(await readFile(path.join(dist, "index.html")));
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, server };
}

function safeDecode(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

const normalizeError = (text: string) =>
  text
    .replace(/https?:\/\/[^\s/)'"]+/g, "<origin>")
    .replace(/:\d+:\d+/g, "")
    .replace(/[-.][A-Za-z0-9_]{8,}\.(m?js|css)/g, ".$1")
    .trim();

const isResourceError = (text: string) => /^Failed to load resource\b/.test(text);

interface PageInfo {
  slug: string;
  url: string;
}

async function readPages(paths: WorkspacePaths): Promise<PageInfo[]> {
  const slugs = existsSync(paths.pages) ? (await readdir(paths.pages)).sort() : [];
  const pages: PageInfo[] = [];
  for (const slug of slugs) {
    try {
      const page = JSON.parse(
        await readFile(path.join(paths.pages, slug, "page.json"), "utf8"),
      ) as { url: string; finalUrl?: string };
      pages.push({ slug, url: page.finalUrl ?? page.url });
    } catch {
      // A page without its snapshot can't be checked.
    }
  }
  return pages;
}

async function check(
  paths: WorkspacePaths,
  targetUrl: string,
  thresholds: Thresholds,
  dist: string,
  options: VerifyOptions,
  progress: (event: VerifyProgress) => void,
): Promise<VerifyReport> {
  const manifest = await readManifest(paths.manifest);
  const captured = Array.isArray(manifest?.options.viewports)
    ? (manifest.options.viewports as string[])
    : ["desktop"];
  const requested = options.viewports ?? captured;
  const unknownViewports = requested.filter((v) => !Object.hasOwn(VIEWPORTS, v));
  if (unknownViewports.length > 0)
    throw new Error(
      `Unknown viewport ${unknownViewports.join(", ")}; viewports are ${Object.keys(VIEWPORTS).join(", ")}.`,
    );
  const viewports = requested as ViewportName[];
  if (viewports.length === 0) throw new Error("No viewports to check.");
  let pages = await readPages(paths);
  if (options.pages) {
    const wanted = new Set(options.pages);
    const unknown = options.pages.filter((p) => !pages.some((page) => page.slug === p));
    if (unknown.length > 0)
      throw new Error(
        `Unknown page ${unknown.join(", ")}; pages are ${pages.map((p) => p.slug).join(", ")}.`,
      );
    pages = pages.filter((p) => wanted.has(p.slug));
  }
  if (pages.length === 0) throw new Error("The capture has no page snapshots to compare with.");

  const records = await readRequestLog(paths.requests).catch(() => []);
  const replay = new ReplayIndex(records, targetUrl);
  const store = new BodyStore(paths.bodies);
  const runtime =
    (await readJsonFile<{ page: string; viewport: string; consoleErrors?: string[] }[]>(
      paths.runtime,
    )) ?? [];
  const knownErrors = (page: string, viewport: string) =>
    new Set(
      (runtime.find((r) => r.page === page && r.viewport === viewport)?.consoleErrors ?? [])
        .filter((e) => !isResourceError(e))
        .map(normalizeError),
    );

  const { origin, server } = await serveDist(dist);
  let browser: Browser | undefined;
  const onAbort = () => void browser?.close().catch(() => {});
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const checks: PageCheck[] = [];
  try {
    browser = await launchBrowser({
      ...(options.headless !== undefined ? { headless: options.headless } : {}),
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    });
    const agents = await buildUserAgents(browser, manifest?.s2sVersion ?? "0.0.0");
    await rm(path.join(paths.verify, "current"), { recursive: true, force: true });
    await rm(paths.verifyDiffs, { recursive: true, force: true });
    for (const viewport of viewports) {
      const spec = VIEWPORTS[viewport];
      const context = await browser.newContext({
        viewport: { width: spec.width, height: spec.height },
        deviceScaleFactor: spec.scale,
        isMobile: spec.mobile,
        hasTouch: spec.mobile,
        userAgent: agents[viewport],
        serviceWorkers: "block",
        reducedMotion: "reduce",
      });
      try {
        for (const page of pages) {
          options.signal?.throwIfAborted();
          progress({ kind: "page", page: page.slug, viewport });
          checks.push(
            await checkPage({
              context,
              paths,
              page,
              viewport,
              origin,
              dist,
              replay,
              store,
              thresholds,
              known: knownErrors(page.slug, viewport),
              primary: viewport === captured[0],
              options,
            }),
          );
        }
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  const status = checks.every((c) => c.pass) ? "pass" : "regression";
  const history = await readHistory(paths);
  const lastPass = [...history].reverse().find((h) => h.status === "pass");
  return {
    at: new Date().toISOString(),
    status,
    thresholds,
    baselineUpdated: Boolean(options.updateBaseline),
    checks,
    sinceLastPass: lastPass
      ? {
          at: lastPass.at,
          changes: checks
            .map((c) => {
              const before = lastPass.checks.find(
                (b) => b.page === c.page && b.viewport === c.viewport,
              );
              return {
                page: c.page,
                viewport: c.viewport,
                pixelDiff: [before?.pixelDiff ?? null, c.pixelDiff] as [
                  number | null,
                  number | null,
                ],
                domSimilarity: [before?.domSimilarity ?? 1, c.domSimilarity] as [number, number],
              };
            })
            .filter(
              (d) =>
                Math.abs((d.pixelDiff[1] ?? 0) - (d.pixelDiff[0] ?? 0)) >= 0.001 ||
                Math.abs(d.domSimilarity[1] - d.domSimilarity[0]) >= 0.001,
            ),
        }
      : null,
  };
}

async function checkPage(input: {
  context: BrowserContext;
  paths: WorkspacePaths;
  page: PageInfo;
  viewport: ViewportName;
  origin: string;
  dist: string;
  replay: ReplayIndex;
  store: BodyStore;
  thresholds: Thresholds;
  known: Set<string>;
  /** The viewport the capture wrote `dom.html` for. */
  primary: boolean;
  options: VerifyOptions;
}): Promise<PageCheck> {
  const { context, paths, viewport, origin, dist, replay, store, thresholds, options } = input;
  const slug = input.page.slug;
  const blocked = new Set<string>();
  const failed: { url: string; status: number | string }[] = [];
  const errors: string[] = [];
  let replayed = 0;
  let inflight = 0;
  let lastActivity = Date.now();

  const page: Page = await context.newPage();
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (!/^https?:/.test(url)) return route.continue();
    const parsed = new URL(url);
    if (parsed.origin === origin) {
      const file = path.join(dist, safeDecode(parsed.pathname) ?? "\0");
      const exists =
        file.startsWith(dist) &&
        (await stat(file).then(
          (s) => s.isFile(),
          () => false,
        ));
      if (!exists) {
        const hit = replay.lookup(url, origin);
        if (hit) {
          replayed++;
          return route.fulfill({
            status: hit.status,
            headers: hit.headers,
            body: await store.read(hit.bodyHash),
          });
        }
      }
      return route.continue();
    }
    const hit = replay.lookup(url, origin);
    if (hit) {
      replayed++;
      return route.fulfill({
        status: hit.status,
        headers: hit.headers,
        body: await store.read(hit.bodyHash),
      });
    }
    blocked.add(url);
    return route.abort("blockedbyclient");
  });
  page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
  page.on("console", (message) => {
    if (message.type() === "error" && !isResourceError(message.text())) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", () => {
    inflight++;
    lastActivity = Date.now();
  });
  const settled = () => {
    inflight = Math.max(0, inflight - 1);
    lastActivity = Date.now();
  };
  page.on("requestfinished", (request) => {
    settled();
    void request.response().then((response) => {
      const status = response?.status() ?? 0;
      const url = request.url();
      if (status >= 400 && url.startsWith(origin) && !replay.failedInCapture(url, origin))
        failed.push({ url: url.slice(origin.length) || "/", status });
    });
  });
  page.on("requestfailed", (request) => {
    settled();
    const url = request.url();
    if (blocked.has(url) || !url.startsWith(origin)) return;
    if (replay.failedInCapture(url, origin)) return;
    failed.push({
      url: url.slice(origin.length) || "/",
      status: request.failure()?.errorText ?? "failed",
    });
  });

  const target = new URL(input.page.url);
  const url = `${origin}${target.pathname}${target.search}${target.hash}`;
  const quietMs = options.quietMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (inflight === 0 && Date.now() - lastActivity >= quietMs) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const shot = await page.screenshot({
      fullPage: true,
      animations: "disabled",
      caret: "hide",
      timeout: timeoutMs,
    });
    const currentFile = path.join(paths.verify, "current", slug, `${viewport}.png`);
    await writeFileAtomic(currentFile, shot);
    const accepted = path.join(paths.verifyBaseline, slug, `${viewport}.png`);
    if (options.updateBaseline) {
      await mkdir(path.dirname(accepted), { recursive: true });
      await copyFile(currentFile, accepted);
    }
    const captureShot = path.join(paths.screenshots, slug, `${viewport}.png`);
    const baselineFile = existsSync(accepted)
      ? accepted
      : existsSync(captureShot)
        ? captureShot
        : null;
    const mask =
      (await readJsonFile<Rect[]>(path.join(paths.screenshots, slug, `${viewport}.mask.json`))) ??
      [];

    let pixelDiff: number | null = null;
    let worstRegions: Rect[] = [];
    let diffImage: string | null = null;
    if (baselineFile) {
      const result = comparePixels(decodePng(await readFile(baselineFile)), decodePng(shot), mask);
      pixelDiff = result.ratio;
      worstRegions = result.regions.slice(0, 3);
      if (result.differing > 0) {
        diffImage = `verify/diffs/${slug}/${viewport}.png`;
        await writeFileAtomic(path.join(paths.root, diffImage), encodePng(result.diff));
      }
    }

    // Responsive apps render different DOM per viewport; only a viewport's own capture compares.
    const own = await readFile(path.join(paths.pages, slug, `dom.${viewport}.html`), "utf8").catch(
      () => undefined,
    );
    const shared = await readFile(path.join(paths.pages, slug, "dom.html"), "utf8").catch(
      () => undefined,
    );
    const domBaseline: PageCheck["domBaseline"] =
      own !== undefined || (shared !== undefined && input.primary)
        ? "viewport"
        : shared !== undefined
          ? "primary"
          : "none";
    const capturedDom = own ?? shared ?? "";
    const domGated = domBaseline === "viewport";
    const dom = (await page.evaluate(
      `(${DOM_SIMILARITY})(${JSON.stringify(capturedDom)})`,
    )) as DomResult;

    const newErrors = [...new Set(errors)].filter((e) => !input.known.has(normalizeError(e)));
    const knownCount = errors.length - errors.filter((e) => newErrors.includes(e)).length;
    const reasons: string[] = [];
    if (pixelDiff !== null && pixelDiff > thresholds.maxPixelDiff)
      reasons.push(`pixels differ by ${pct(pixelDiff)} (limit ${pct(thresholds.maxPixelDiff)})`);
    if (domGated && dom.similarity < thresholds.minDomSimilarity)
      reasons.push(
        `DOM similarity ${dom.similarity.toFixed(3)} (limit ${thresholds.minDomSimilarity})`,
      );
    if (newErrors.length > thresholds.maxNewConsoleErrors)
      reasons.push(
        `${newErrors.length} new console error${newErrors.length === 1 ? "" : "s"} (limit ${thresholds.maxNewConsoleErrors})`,
      );
    if (failed.length > thresholds.maxFailedRequests)
      reasons.push(
        `${failed.length} failed request${failed.length === 1 ? "" : "s"} (limit ${thresholds.maxFailedRequests})`,
      );
    return {
      page: slug,
      viewport,
      url: input.page.url,
      pass: reasons.length === 0,
      reasons,
      pixelDiff,
      baseline: baselineFile === accepted ? "accepted" : baselineFile ? "capture" : "none",
      worstRegions,
      diffImage,
      masked: mask.length,
      domSimilarity: dom.similarity,
      domBaseline,
      domMissing: dom.missing,
      domExtra: dom.extra,
      newConsoleErrors: newErrors,
      knownConsoleErrors: knownCount,
      failedRequests: failed.sort((a, b) => a.url.localeCompare(b.url)),
      blockedRequests: [...blocked].sort(),
      replayed,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readHistory(paths: WorkspacePaths): Promise<HistoryLine[]> {
  const text = await readFile(paths.verifyHistory, "utf8").catch(() => "");
  const lines: HistoryLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as HistoryLine);
    } catch {
      // A torn line from an interrupted run.
    }
  }
  return lines;
}

async function writeReport(paths: WorkspacePaths, report: VerifyReport): Promise<void> {
  await writeJsonAtomic(paths.verifyReport, report);
  await writeFileAtomic(paths.verifyReportMd, renderReportMd(report));
  const line: HistoryLine = {
    at: report.at,
    status: report.status,
    checks: report.checks.map((c) => ({
      page: c.page,
      viewport: c.viewport,
      pass: c.pass,
      pixelDiff: c.pixelDiff,
      domSimilarity: c.domSimilarity,
    })),
  };
  await mkdir(paths.verify, { recursive: true });
  await appendFile(paths.verifyHistory, `${JSON.stringify(line)}\n`);
}
