import {
  DEFAULT_MAX_GROUP_KB,
  PASSES,
  type PassName,
  type UnbundleProgress,
  unbundle,
  WorkspaceError,
} from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
import { bar, ownStage, type StageReporter, surfaceOf } from "../ui.js";
import type { CliIO } from "./capture.js";

export const unbundleArgs = {
  workspace: {
    type: "positional",
    description: "Workspace folder written by s2s capture",
    required: false,
    default: ".",
  },
  force: { type: "boolean", description: "Rebuild even if the stage is complete" },
  skip: {
    type: "string",
    description: `Transform passes to leave out (comma-separated): ${PASSES.join(", ")}`,
  },
  "keep-vendor": {
    type: "boolean",
    description: "Keep vendor code instead of replacing it with package imports",
  },
  "heuristic-split": {
    type: "boolean",
    default: true,
    description:
      "Guess module boundaries in scope-hoisted chunks (--no-heuristic-split keeps them whole)",
  },
  "max-group-kb": {
    type: "string",
    description: `Largest agent work group in KB of code (default ${DEFAULT_MAX_GROUP_KB})`,
  },
  json: { type: "boolean", description: "Print only the result as JSON" },
} as const;

/** Exit codes: 0 complete or skipped, 1 failed, 2 bad flags, 130 interrupted. */
export function unbundleCommand(io: CliIO, setExitCode: (code: number) => void) {
  const runUnbundle = unbundleRunner(io);
  return defineCommand({
    meta: {
      name: "unbundle",
      description: "Stage 4: split first-party JS into readable modules and write modules.json",
    },
    args: unbundleArgs,
    async run({ args }): Promise<void> {
      setExitCode(await runUnbundle(args));
    },
  });
}

/** The stage as a function of its parsed flags, for `s2s grab` to run in sequence. */
export function unbundleRunner(io: CliIO, shared?: StageReporter) {
  return runUnbundle;

  async function runUnbundle(args: ParsedArgs<typeof unbundleArgs>): Promise<number> {
    const skip = (args.skip ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = skip.filter((s) => !(PASSES as readonly string[]).includes(s));
    if (unknown.length > 0) {
      io.stderr(`--skip takes ${PASSES.join(", ")}; got "${unknown.join(", ")}".`);
      return 2;
    }
    let maxGroupKb: number | undefined;
    if (args["max-group-kb"] !== undefined) {
      maxGroupKb = Number(args["max-group-kb"]);
      if (!Number.isFinite(maxGroupKb) || maxGroupKb <= 0) {
        io.stderr(`--max-group-kb must be a positive number; got "${args["max-group-kb"]}".`);
        return 2;
      }
    }

    const own = shared || args.json ? undefined : ownStage(io, "unbundle");
    const stage = shared ?? own?.stage;
    const t = surfaceOf(io).theme;
    const controller = new AbortController();
    const removeHandler = io.onInterrupt(() => controller.abort(new Error("Interrupted")));
    const onProgress = (event: UnbundleProgress) => {
      if (!stage) return;
      switch (event.kind) {
        case "start":
          stage.detail("reading bundles", `Unbundling ${event.workspace}`);
          break;
        case "chunk": {
          if (event.total === 0) break;
          const counts = `splitting ${event.done}/${event.total} chunks`;
          // Off a terminal, one line per chunk would flood the log; the module count says enough.
          stage.detail(`${bar(t, event.done / event.total, 24, t.info)}  ${counts}`, null);
          break;
        }
        case "module": {
          if (event.total === 0) break;
          const counts = `${event.done}/${event.total} modules`;
          stage.detail(`${bar(t, event.done / event.total, 24, t.info)}  ${counts}`, counts);
          break;
        }
        case "warning":
          stage.warn(event.message);
          break;
        case "done":
          if (event.status === "complete") stage.done(event.summary);
          break;
        default:
          break;
      }
    };
    try {
      const result = await unbundle({
        workspace: args.workspace || ".",
        force: Boolean(args.force),
        skip: skip as PassName[],
        keepVendor: Boolean(args["keep-vendor"]),
        noHeuristicSplit: args["heuristic-split"] === false,
        ...(maxGroupKb !== undefined ? { maxGroupKb } : {}),
        signal: controller.signal,
        onProgress,
      });
      if (args.json) io.stdout(JSON.stringify(result, null, 2));
      else if (result.skipped) stage?.skipped(`already complete · ${result.summary}`);
      else if (result.status === "partial") stage?.failed("interrupted");
      else if (result.status !== "complete") stage?.failed(result.error ?? "unbundle failed");
      if (result.status === "complete") return 0;
      return result.status === "partial" ? 130 : 1;
    } catch (error) {
      if (error instanceof WorkspaceError) {
        if (stage) stage.failed(error.message);
        else io.stderr(error.message);
        return 1;
      }
      throw error;
    } finally {
      removeHandler();
      own?.close();
    }
  }
}
