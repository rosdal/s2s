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

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Install a Ctrl+C handler; returns a function that removes it. */
  onInterrupt: (handler: () => void) => () => void;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  json: { type: "boolean", description: "Print only the result as JSON" },
} as const;

/**
 * Exit codes: 0 complete or skipped, 1 failed, 130 interrupted. The code goes to `setExitCode`
 * because citty does not pass a subcommand's return value back up.
 */
export function captureCommand(io: CliIO, version: string, setExitCode: (code: number) => void) {
  return defineCommand({
    meta: { name: "capture", description: "Stage 1: capture a live URL into a workspace" },
    args: captureArgs,
    async run({ args }): Promise<void> {
      setExitCode(await runCapture(args));
    },
  });

  async function runCapture(args: ParsedArgs<typeof captureArgs>): Promise<number> {
    const controller = new AbortController();
    let interrupts = 0;
    const removeHandler = io.onInterrupt(() => {
      interrupts++;
      if (interrupts === 1) {
        io.stderr("Stopping: saving what was captured so far (Ctrl+C again to quit at once)…");
        controller.abort(new Error("Interrupted"));
      } else {
        process.exit(130);
      }
    });

    let lastStats = { requests: 0, bytesStored: 0, chunksDiscovered: 0, mapsFound: 0 };
    const statsLine = () =>
      `requests ${lastStats.requests} · stored ${formatBytes(lastStats.bytesStored)} · chunks discovered ${lastStats.chunksDiscovered} · maps ${lastStats.mapsFound}`;
    const onProgress = (event: CaptureProgress) => {
      if (event.kind === "stats") {
        lastStats = event;
        return;
      }
      if (args.json) return;
      switch (event.kind) {
        case "start":
          io.stderr(`Capturing ${event.url}\n  into ${event.workspace}`);
          break;
        case "skip":
          io.stderr(
            `Nothing to do: ${event.reason} in ${event.workspace}. Use --force to recapture.`,
          );
          break;
        case "phase": {
          const where = [event.viewport, event.page].filter(Boolean).join(" ");
          io.stderr(`  ${event.phase.padEnd(8)} ${where.padEnd(28)} ${statsLine()}`);
          break;
        }
        case "warning":
          io.stderr(`  warning: ${event.message}`);
          break;
        case "done":
          io.stderr(`Capture ${event.status}: ${statsLine()}`);
          break;
      }
    };

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
        signal: controller.signal,
        onProgress,
      });
      if (args["ignore-robots"] && !args.json) {
        io.stderr("  note: robots.txt was ignored for this capture.");
      }
      if (args.json) io.stdout(JSON.stringify(result, null, 2));
      else if (result.status === "partial") {
        io.stderr(
          `Capture stopped early and is marked partial. Run the same command again to restart it.`,
        );
      }
      if (result.status === "complete") return 0;
      return result.status === "partial" ? 130 : 1;
    } catch (error) {
      if (
        error instanceof UsageError ||
        error instanceof RobotsDisallowedError ||
        error instanceof BrowserNotFoundError
      ) {
        io.stderr(error.message);
        return 1;
      }
      throw error;
    } finally {
      removeHandler();
    }
  }
}
