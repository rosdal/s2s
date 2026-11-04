import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanUrl,
  detectSummaryLine,
  summaryLine as mapsSummaryLine,
  readManifest,
  scaffoldSummaryLine,
  unbundleSummaryLine,
  workspacePaths,
  workspaceSlug,
} from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
import { type CliIO, captureArgs, captureRunner } from "./capture.js";
import { detectArgs, detectRunner } from "./detect.js";
import { mapsRunner } from "./maps.js";
import { scaffoldArgs, scaffoldRunner } from "./scaffold.js";
import { unbundleArgs, unbundleRunner } from "./unbundle.js";
import { verifyRunner } from "./verify.js";

const { json: _cj, ...captureFlags } = captureArgs;
const {
  workspace: _dw,
  explain: _de,
  install: _di,
  json: _dj,
  force: _df,
  ...detectFlags
} = detectArgs;
const { workspace: _uw, json: _uj, force: _uf, ...unbundleFlags } = unbundleArgs;
const { workspace: _sw, json: _sj, force: _sf, ...scaffoldFlags } = scaffoldArgs;

export const grabArgs = {
  ...captureFlags,
  ...detectFlags,
  ...unbundleFlags,
  ...scaffoldFlags,
  verify: {
    type: "boolean",
    default: true,
    description: "Run s2s verify on the untouched scaffold at the end (--no-verify skips it)",
  },
} as const;

export type GrabArgs = ParsedArgs<typeof grabArgs>;

/**
 * Exit codes: 0 every stage done (and the baseline verify passed), the failed stage's own code
 * otherwise. Finished stages are skipped on a rerun, so running the same command again resumes.
 */
export function grabCommand(io: CliIO, version: string, setExitCode: (code: number) => void) {
  const runGrab = grabRunner(io, version);
  return defineCommand({
    meta: {
      name: "grab",
      description:
        "Run every stage on a URL (capture, maps, detect, unbundle, scaffold) and check the result",
    },
    args: grabArgs,
    async run({ args }): Promise<void> {
      setExitCode(await runGrab(args));
    },
  });
}

export function grabRunner(io: CliIO, version: string) {
  return async function runGrab(args: GrabArgs): Promise<number> {
    const target = cleanUrl(args.url);
    if (!target) {
      io.stderr(`Not an http(s) URL: ${args.url}`);
      return 2;
    }
    const workspace = path.resolve(args.out ?? workspaceSlug(target));
    const force = Boolean(args.force);
    const common = { _: [] as string[], json: false, force };
    const stages: [string, () => Promise<number>][] = [
      [
        "capture",
        () => captureRunner(io, version)({ ...args, ...common, out: workspace } as never),
      ],
      ["maps", () => mapsRunner(io)({ ...common, workspace } as never)],
      [
        "detect",
        () => detectRunner(io)({ ...args, ...common, workspace, install: false } as never),
      ],
      ["unbundle", () => unbundleRunner(io)({ ...args, ...common, workspace } as never)],
      ["scaffold", () => scaffoldRunner(io)({ ...args, ...common, workspace } as never)],
    ];
    for (const [name, run] of stages) {
      io.stderr("");
      const code = await run();
      if (code !== 0) {
        io.stderr(
          `\ns2s grab stopped at ${name} (exit ${code}). Fix what it reported and run the same command again; finished stages are skipped.`,
        );
        return code;
      }
    }

    let verifyCode: number | null = null;
    if (args.verify !== false) {
      io.stderr("\nChecking the untouched scaffold against the capture");
      verifyCode = await verifyRunner(io)({ _: [], workspace, json: false } as never);
    }
    io.stderr(await finalSummary(workspace, verifyCode));
    return verifyCode ?? 0;
  };
}

async function finalSummary(workspace: string, verifyCode: number | null): Promise<string> {
  const paths = workspacePaths(workspace);
  const manifest = await readManifest(paths.manifest);
  const stages = manifest?.stages;
  const packages = await readFile(path.join(paths.analysis, "packages.json"), "utf8")
    .then((t) => JSON.parse(t) as { packages: { status: string; confidence: string }[] })
    .catch(() => ({ packages: [] }));
  const byConfidence = (c: string) =>
    packages.packages.filter(
      (p) => (p.status === "dependency" || p.status === "devDependency") && p.confidence === c,
    ).length;
  const review = packages.packages.filter((p) => p.status === "review").length;
  const verifyLine =
    verifyCode === null
      ? "skipped"
      : verifyCode === 0
        ? "passes"
        : verifyCode === 1
          ? "regressions (see verify/report.md)"
          : verifyCode === 2
            ? "build failed"
            : "could not run";
  const rel = path.relative(process.cwd(), workspace) || ".";
  const cd = /\s/.test(rel) ? `"${rel}"` : rel;
  return [
    "",
    `Workspace: ${workspace}`,
    `  Source maps:  ${stages ? mapsSummaryLine(stages.maps.stats) : "n/a"}`,
    `  Packages:     ${stages ? detectSummaryLine(stages.detect.stats) : "n/a"}`,
    `                ${byConfidence("high")} high, ${byConfidence("medium")} medium, ${byConfidence("low")} low confidence; ${review} to review`,
    `  Modules:      ${stages ? unbundleSummaryLine(stages.unbundle.stats, String(stages.unbundle.details?.bundler ?? "unknown")) : "n/a"}`,
    `  Scaffold:     ${stages ? scaffoldSummaryLine(String(stages.scaffold.details?.target ?? "unknown"), stages.scaffold.stats, String(stages.scaffold.details?.build ?? "skipped")) : "n/a"}`,
    `  Baseline:     verify ${verifyLine}`,
    "",
    "Next: hand it to Claude Code",
    `  cd ${cd} && claude "$(cat PROMPT.md)"`,
    "or run `claude` there and type /s2s",
  ].join("\n");
}
