import {
  DEFAULT_MAX_GROUP_KB,
  PASSES,
  type PassName,
  type UnbundleProgress,
  unbundle,
  WorkspaceError,
} from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
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
export function unbundleRunner(io: CliIO) {
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

    const controller = new AbortController();
    const removeHandler = io.onInterrupt(() => controller.abort(new Error("Interrupted")));
    const onProgress = (event: UnbundleProgress) => {
      if (args.json) return;
      switch (event.kind) {
        case "start":
          io.stderr(`Unbundling ${event.workspace}`);
          break;
        case "skip":
          io.stderr(
            `Nothing to do: ${event.reason} in ${event.workspace}. Use --force to rebuild.`,
          );
          break;
        case "warning":
          io.stderr(`  warning: ${event.message}`);
          break;
        case "done":
          io.stderr(`Unbundle ${event.status}: ${event.summary}`);
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
      else if (result.skipped) io.stderr(result.summary);
      else if (result.error) io.stderr(`  error: ${result.error}`);
      if (result.status === "complete") return 0;
      return result.status === "partial" ? 130 : 1;
    } catch (error) {
      if (error instanceof WorkspaceError) {
        io.stderr(error.message);
        return 1;
      }
      throw error;
    } finally {
      removeHandler();
    }
  }
}
