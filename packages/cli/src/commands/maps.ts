import { type MapsProgress, maps, WorkspaceError } from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
import { ownStage, type StageReporter } from "../ui.js";
import type { CliIO } from "./capture.js";

export const mapsArgs = {
  workspace: {
    type: "positional",
    description: "Workspace folder written by s2s capture",
    required: false,
    default: ".",
  },
  force: { type: "boolean", description: "Rebuild even if the stage is complete" },
  json: { type: "boolean", description: "Print only the result as JSON" },
} as const;

/** Exit codes: 0 complete or skipped, 1 failed, 130 interrupted. */
export function mapsCommand(io: CliIO, setExitCode: (code: number) => void) {
  const runMaps = mapsRunner(io);
  return defineCommand({
    meta: {
      name: "maps",
      description: "Stage 2: recover original sources from the capture's source maps",
    },
    args: mapsArgs,
    async run({ args }): Promise<void> {
      setExitCode(await runMaps(args));
    },
  });
}

/** The stage as a function of its parsed flags, for `s2s grab` to run in sequence. */
export function mapsRunner(io: CliIO, shared?: StageReporter) {
  return async function runMaps(args: ParsedArgs<typeof mapsArgs>): Promise<number> {
    const own = shared || args.json ? undefined : ownStage(io, "maps");
    const stage = shared ?? own?.stage;
    const controller = new AbortController();
    const removeHandler = io.onInterrupt(() => controller.abort(new Error("Interrupted")));
    const onProgress = (event: MapsProgress) => {
      if (!stage) return;
      switch (event.kind) {
        case "start":
          stage.detail("reading source maps", `Reading source maps in ${event.workspace}`);
          break;
        case "warning":
          stage.warn(event.message);
          break;
        case "done":
          if (event.status === "complete") stage.done(event.summary);
          break;
      }
    };
    try {
      const result = await maps({
        workspace: args.workspace || ".",
        force: Boolean(args.force),
        signal: controller.signal,
        onProgress,
      });
      if (args.json) io.stdout(JSON.stringify(result, null, 2));
      else if (result.skipped) stage?.skipped(`already complete · ${result.summary}`);
      else if (result.status === "partial") stage?.failed("interrupted");
      else if (result.status !== "complete") stage?.failed(result.error ?? "maps failed");
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
  };
}
