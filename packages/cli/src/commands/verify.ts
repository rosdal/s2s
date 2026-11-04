import { type VerifyProgress, verify } from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
import type { CliIO } from "./capture.js";

export const verifyArgs = {
  workspace: {
    type: "positional",
    description: "Workspace folder (default: the current folder)",
    required: false,
    default: ".",
  },
  pages: { type: "string", description: "Page slugs to check, comma-separated (default: all)" },
  viewports: {
    type: "string",
    description: "Viewports to check, comma-separated (default: the captured ones)",
  },
  "update-baseline": {
    type: "boolean",
    description: "Accept the current screenshots as the baseline (for intended visual changes)",
  },
  json: { type: "boolean", description: "Print only the report as JSON" },
} as const;

const list = (value: string | undefined) =>
  value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Exit codes: 0 pass, 1 regression, 2 build failed, 3 verify itself failed. */
export function verifyCommand(io: CliIO, setExitCode: (code: number) => void) {
  const runVerify = verifyRunner(io);
  return defineCommand({
    meta: {
      name: "verify",
      description: "Build the project and compare it with the capture (exit 0 pass, 1 regression)",
    },
    args: verifyArgs,
    async run({ args }): Promise<void> {
      setExitCode(await runVerify(args));
    },
  });
}

export function verifyRunner(io: CliIO) {
  return async function runVerify(args: ParsedArgs<typeof verifyArgs>): Promise<number> {
    const controller = new AbortController();
    const removeHandler = io.onInterrupt(() => controller.abort(new Error("Interrupted")));
    const onProgress = (event: VerifyProgress) => {
      if (args.json) return;
      if (event.kind === "build") io.stderr("Building project/");
      if (event.kind === "page") io.stderr(`  checking ${event.page} (${event.viewport})`);
    };
    const pages = list(args.pages);
    const viewports = list(args.viewports);
    try {
      const result = await verify({
        workspace: args.workspace || ".",
        ...(pages ? { pages } : {}),
        ...(viewports ? { viewports } : {}),
        updateBaseline: Boolean(args["update-baseline"]),
        signal: controller.signal,
        onProgress,
      });
      if (args.json) {
        io.stdout(JSON.stringify(result, null, 2));
        return result.exitCode;
      }
      switch (result.exitCode) {
        case 0:
          io.stderr(`Verify passed: ${result.summary}`);
          break;
        case 1: {
          io.stderr(`Verify failed: ${result.summary}`);
          for (const c of result.report?.checks.filter((check) => !check.pass) ?? [])
            io.stderr(`  ${c.page} (${c.viewport}): ${c.reasons.join("; ")}`);
          io.stderr("Details: verify/report.md");
          break;
        }
        case 2:
          io.stderr("Build failed. First 50 lines of output:");
          io.stderr(result.buildOutput ?? "");
          break;
        case 3:
          io.stderr(`Verify could not run: ${result.error ?? "unknown error"}`);
          break;
      }
      return result.exitCode;
    } finally {
      removeHandler();
    }
  };
}
