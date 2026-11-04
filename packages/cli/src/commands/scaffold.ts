import {
  type ScaffoldProgress,
  scaffold,
  TARGETS,
  type Target,
  WorkspaceError,
} from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
import type { CliIO } from "./capture.js";

export const scaffoldArgs = {
  workspace: {
    type: "positional",
    description: "Workspace folder written by s2s capture",
    required: false,
    default: ".",
  },
  target: {
    type: "string",
    description: `UI library for the Vite project: ${TARGETS.join(", ")} (default: detected)`,
  },
  install: {
    type: "boolean",
    default: true,
    description: "Install dependencies, scripts disabled (--no-install skips it)",
  },
  build: {
    type: "boolean",
    default: true,
    description: "Build once and record the result (--no-build skips it)",
  },
  git: {
    type: "boolean",
    default: true,
    description: "git init and commit the scaffold (--no-git skips it)",
  },
  force: { type: "boolean", description: "Regenerate even if the stage is complete" },
  json: { type: "boolean", description: "Print only the result as JSON" },
} as const;

/** Exit codes: 0 complete or skipped, 1 failed, 2 bad flags, 130 interrupted. */
export function scaffoldCommand(io: CliIO, setExitCode: (code: number) => void) {
  const runScaffold = scaffoldRunner(io);
  return defineCommand({
    meta: {
      name: "scaffold",
      description: "Stage 5: write the Vite project, the agent files and the git repo",
    },
    args: scaffoldArgs,
    async run({ args }): Promise<void> {
      setExitCode(await runScaffold(args));
    },
  });
}

/** The stage as a function of its parsed flags, for `s2s grab` to run in sequence. */
export function scaffoldRunner(io: CliIO) {
  return async function runScaffold(args: ParsedArgs<typeof scaffoldArgs>): Promise<number> {
    if (args.target && !(TARGETS as readonly string[]).includes(args.target)) {
      io.stderr(`--target must be one of ${TARGETS.join(", ")}; got "${args.target}".`);
      return 2;
    }
    const controller = new AbortController();
    const removeHandler = io.onInterrupt(() => controller.abort(new Error("Interrupted")));
    const onProgress = (event: ScaffoldProgress) => {
      if (args.json) return;
      switch (event.kind) {
        case "start":
          io.stderr(`Scaffolding ${event.workspace}`);
          break;
        case "skip":
          io.stderr(
            `Nothing to do: ${event.reason} in ${event.workspace}. Use --force to redo it.`,
          );
          break;
        case "step":
          io.stderr(`  ${event.step}`);
          break;
        case "warning":
          io.stderr(`  warning: ${event.message}`);
          break;
        case "done":
          io.stderr(`Scaffold ${event.status}: ${event.summary}`);
          break;
      }
    };
    try {
      const result = await scaffold({
        workspace: args.workspace || ".",
        force: Boolean(args.force),
        ...(args.target ? { target: args.target as Target } : {}),
        install: args.install !== false,
        build: args.build !== false,
        git: args.git !== false,
        signal: controller.signal,
        onProgress,
      });
      if (args.json) io.stdout(JSON.stringify(result, null, 2));
      else if (result.skipped) io.stderr(result.summary);
      else if (result.error) io.stderr(`  error: ${result.error}`);
      if (!args.json && result.buildOutput) io.stderr(result.buildOutput);
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
  };
}
