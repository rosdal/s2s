import { readFile } from "node:fs/promises";
import {
  BrowserNotFoundError,
  type CaptureProgress,
  capture,
  RobotsDisallowedError,
  VIEWPORTS,
  type ViewportName,
} from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
import {
  type ColorDepth,
  formatBytes,
  ownStage,
  plural,
  type StageReporter,
  surfaceOf,
} from "../ui.js";

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Raw stderr writes, for redrawing progress in place. */
  write?: (chunk: string) => void;
  /** Redraw progress in place (a terminal, not CI or a pipe). */
  live?: boolean;
  columns?: number;
  colors?: ColorDepth;
  /** Install a Ctrl+C handler; returns a function that removes it. */
  onInterrupt: (handler: () => void) => () => void;
  /** A terminal a person can answer prompts in; `s2s` alone then starts the guided flow. */
  interactive?: boolean;
}

export class UsageError extends Error {
  override name = "UsageError";
}

function int(name: string, value: string | undefined, min = 0): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new UsageError(`--${name} must be a whole number of at least ${min}, got "${value}"`);
  }
  return parsed;
}

function viewports(value: string): ViewportName[] {
  const names = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !(n in VIEWPORTS));
  if (names.length === 0 || unknown.length > 0) {
    throw new UsageError(
      `--viewports takes a comma-separated list of ${Object.keys(VIEWPORTS).join(", ")}; got "${value}"`,
    );
  }
  return [...new Set(names)] as ViewportName[];
}

async function pagesFile(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** "capture is already complete" reads as "already complete" next to the stage's name. */
export function skipReason(reason: string): string {
  return reason.replace(/^\w+ is /, "");
}

export const captureArgs = {
  url: { type: "positional", description: "Page to capture", required: true },
  out: { type: "string", description: "Workspace folder (default: a slug of host and path)" },
  force: { type: "boolean", description: "Recapture even if the workspace is complete" },
  depth: {
    type: "string",
    description: "Follow same-origin links this many levels deep",
    default: "0",
  },
  "max-pages": {
    type: "string",
    description: "Stop crawling after this many pages",
    default: "20",
  },
  pages: {
    type: "string",
    description: "File with extra page URLs, one per line (replaces link crawling)",
  },
  viewports: {
    type: "string",
    description: "Comma-separated viewports",
    default: "desktop,mobile",
  },
  "auth-state": {
    type: "string",
    description: "Playwright storage-state file for a site you may access while logged in",
  },
  har: { type: "boolean", description: "Also write raw/capture.har" },
  "ignore-robots": {
    type: "boolean",
    description: "Capture pages robots.txt disallows (only where you are allowed to)",
  },
  concurrency: { type: "string", description: "Parallel chunk and map fetches", default: "4" },
  delay: { type: "string", description: "Milliseconds between crawled pages", default: "1000" },
  "quiet-ms": {
    type: "string",
    description: "Network idle time that counts as quiet",
    default: "1000",
  },
  "phase-timeout": {
    type: "string",
    description: "Max milliseconds to wait for quiet per phase",
    default: "30000",
  },
  "mask-delay": {
    type: "string",
    description: "Milliseconds between the two screenshots that find dynamic regions (0: one shot)",
    default: "3000",
  },
  json: { type: "boolean", description: "Print only the result as JSON" },
} as const;

/**
 * Exit codes: 0 complete or skipped, 1 failed, 130 interrupted. The code goes to `setExitCode`
 * because citty does not pass a subcommand's return value back up.
 */
export function captureCommand(io: CliIO, version: string, setExitCode: (code: number) => void) {
  const runCapture = captureRunner(io, version);
  return defineCommand({
    meta: { name: "capture", description: "Stage 1: capture a live URL into a workspace" },
    args: captureArgs,
    async run({ args }): Promise<void> {
      setExitCode(await runCapture(args));
    },
  });
}

/** The stage as a function of its parsed flags, for `s2s grab` to run in sequence. */
export function captureRunner(io: CliIO, version: string, shared?: StageReporter) {
  return runCapture;

  async function runCapture(args: ParsedArgs<typeof captureArgs>): Promise<number> {
    const own = shared || args.json ? undefined : ownStage(io, "capture");
    const stage = shared ?? own?.stage;
    try {
      return await captureStage(args, stage);
    } finally {
      own?.close();
    }
  }

  async function captureStage(
    args: ParsedArgs<typeof captureArgs>,
    stage: StageReporter | undefined,
  ): Promise<number> {
    const t = surfaceOf(io).theme;
    const controller = new AbortController();
    let interrupts = 0;
    const removeHandler = io.onInterrupt(() => {
      interrupts++;
      if (interrupts === 1) {
        stage?.note("Stopping: saving what was captured so far (Ctrl+C again to quit at once)…");
        controller.abort(new Error("Interrupted"));
      } else {
        process.exit(130);
      }
    });

    let lastStats = { requests: 0, bytesStored: 0, chunksDiscovered: 0, mapsFound: 0 };
    let ended = false;
    const statsLine = () =>
      `requests ${lastStats.requests} · stored ${formatBytes(lastStats.bytesStored)} · chunks discovered ${lastStats.chunksDiscovered} · maps ${lastStats.mapsFound}`;
    const onProgress = (event: CaptureProgress) => {
      if (event.kind === "stats") {
        lastStats = event;
        return;
      }
      if (!stage) return;
      switch (event.kind) {
        case "start":
          stage.detail(`opening ${event.url}`, `Capturing ${event.url}\n  into ${event.workspace}`);
          break;
        case "skip":
          ended = true;
          stage.skipped(`${skipReason(event.reason)} · --force recaptures`);
          break;
        case "phase": {
          const where = [event.viewport, event.page].filter(Boolean).join(" ");
          stage.detail(
            `${event.phase} ${t.dim("·")} ${where} ${t.dim(`· ${plural(lastStats.requests, "request")} · ${formatBytes(lastStats.bytesStored)}`)}`,
            `${event.phase.padEnd(8)} ${where.padEnd(28)} ${statsLine()}`,
          );
          break;
        }
        case "warning":
          stage.warn(event.message);
          break;
        case "done": {
          if (event.status !== "complete") break;
          ended = true;
          const views = args.viewports
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
            .join(", ");
          stage.done(
            [
              plural(lastStats.requests, "request"),
              formatBytes(lastStats.bytesStored),
              views,
              `${plural(lastStats.mapsFound, "map")} found`,
            ].join(" · "),
          );
          break;
        }
      }
    };

    if (args["ignore-robots"]) stage?.warn("robots.txt is ignored for this capture");
    try {
      const pages = args.pages ? await pagesFile(args.pages) : undefined;
      const result = await capture({
        url: args.url,
        version,
        ...(args.out ? { outDir: args.out } : {}),
        force: Boolean(args.force),
        depth: int("depth", args.depth) ?? 0,
        maxPages: int("max-pages", args["max-pages"], 1) ?? 20,
        ...(pages ? { pages } : {}),
        viewports: viewports(args.viewports),
        ...(args["auth-state"] ? { authState: args["auth-state"] } : {}),
        har: Boolean(args.har),
        ignoreRobots: Boolean(args["ignore-robots"]),
        concurrency: int("concurrency", args.concurrency, 1) ?? 4,
        delayMs: int("delay", args.delay) ?? 1000,
        quietMs: int("quiet-ms", args["quiet-ms"], 100) ?? 1000,
        phaseTimeoutMs: int("phase-timeout", args["phase-timeout"], 1000) ?? 30_000,
        maskDelayMs: int("mask-delay", args["mask-delay"]) ?? 3_000,
        signal: controller.signal,
        onProgress,
      });
      if (args.json) io.stdout(JSON.stringify(result, null, 2));
      else if (!ended && result.status === "partial") {
        stage?.failed("stopped early; the capture is marked partial", [
          "Run the same command again to restart it.",
        ]);
      } else if (!ended && result.status !== "complete") {
        stage?.failed("capture failed");
      }
      if (result.status === "complete") return 0;
      return result.status === "partial" ? 130 : 1;
    } catch (error) {
      if (
        error instanceof UsageError ||
        error instanceof RobotsDisallowedError ||
        error instanceof BrowserNotFoundError
      ) {
        const [first = "", ...rest] = error.message.split("\n");
        if (stage) stage.failed(first, rest);
        else io.stderr(error.message);
        return 1;
      }
      throw error;
    } finally {
      removeHandler();
    }
  }
}
