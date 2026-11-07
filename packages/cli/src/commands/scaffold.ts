import {
  ASSET_MODES,
  type ScaffoldProgress,
  scaffold,
  TARGETS,
  type Target,
  WorkspaceError,
} from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
import { ownStage, type StageReporter } from "../ui.js";
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
  assets: {
    type: "string",
    description:
      "three.js models, textures and sounds: proxy (generated stand-ins, the default), clone (simplified originals, local study only) or original (as captured, local study only)",
  },
  "clone-ratio": {
    type: "string",
    description:
      "With --assets clone: share of each static mesh's triangles to keep (0-1, default 0.25)",
  },
  "clone-texture": {
    type: "string",
    description: "With --assets clone: largest texture side in pixels (default 512)",
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
export function scaffoldRunner(io: CliIO, shared?: StageReporter) {
  return async function runScaffold(args: ParsedArgs<typeof scaffoldArgs>): Promise<number> {
    if (args.target && !(TARGETS as readonly string[]).includes(args.target)) {
      io.stderr(`--target must be one of ${TARGETS.join(", ")}; got "${args.target}".`);
      return 2;
    }
    const recoverer: Record<string, unknown> = {};
    if (args.assets !== undefined) {
      if (!(ASSET_MODES as readonly string[]).includes(args.assets)) {
        io.stderr(`--assets must be one of ${ASSET_MODES.join(", ")}; got "${args.assets}".`);
        return 2;
      }
      recoverer.assets = args.assets;
    }
    if (args["clone-ratio"] !== undefined) {
      const ratio = Number(args["clone-ratio"]);
      if (!(ratio > 0 && ratio <= 1)) {
        io.stderr(
          `--clone-ratio must be a number above 0 and at most 1; got "${args["clone-ratio"]}".`,
        );
        return 2;
      }
      recoverer.cloneRatio = ratio;
    }
    if (args["clone-texture"] !== undefined) {
      const size = Number(args["clone-texture"]);
      if (!Number.isInteger(size) || size < 16) {
        io.stderr(
          `--clone-texture must be a whole number of pixels, at least 16; got "${args["clone-texture"]}".`,
        );
        return 2;
      }
      recoverer.cloneTexture = size;
    }
    const own = shared || args.json ? undefined : ownStage(io, "scaffold");
    const stage = shared ?? own?.stage;
    const controller = new AbortController();
    const removeHandler = io.onInterrupt(() => controller.abort(new Error("Interrupted")));
    const onProgress = (event: ScaffoldProgress) => {
      if (!stage) return;
      switch (event.kind) {
        case "start":
          stage.detail("writing the project", `Scaffolding ${event.workspace}`);
          break;
        case "step":
          stage.detail(event.step);
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
      const result = await scaffold({
        workspace: args.workspace || ".",
        force: Boolean(args.force),
        ...(args.target ? { target: args.target as Target } : {}),
        install: args.install !== false,
        build: args.build !== false,
        git: args.git !== false,
        ...(Object.keys(recoverer).length > 0 ? { recoverer } : {}),
        signal: controller.signal,
        onProgress,
      });
      if (args.json) io.stdout(JSON.stringify(result, null, 2));
      else if (result.skipped) stage?.skipped(`already complete · ${result.summary}`);
      else if (result.status === "partial") stage?.failed("interrupted");
      else if (result.status !== "complete") stage?.failed(result.error ?? "scaffold failed");
      if (!args.json && !shared && result.buildOutput) {
        stage?.note("The build failed. Its first lines:");
        for (const line of result.buildOutput.split("\n").slice(0, 20)) stage?.note(`  ${line}`);
      }
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
