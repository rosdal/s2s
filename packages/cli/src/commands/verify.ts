import { type PageCheck, type VerifyProgress, type VerifyResult, verify } from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
import {
  bar,
  columns,
  StageList,
  type StageReporter,
  surfaceOf,
  symbols,
  type Theme,
} from "../ui.js";
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

/**
 * With `shared`, verify is one row in someone else's stage list (`s2s grab`) and prints nothing
 * else; the caller draws the report with `verifyReportLines`.
 */
export function verifyRunner(
  io: CliIO,
  shared?: StageReporter,
  onResult?: (r: VerifyResult) => void,
) {
  return async function runVerify(args: ParsedArgs<typeof verifyArgs>): Promise<number> {
    const s = surfaceOf(io);
    const own = shared || args.json ? undefined : new StageList(s, ["verify"]);
    own?.show();
    const stage = shared ?? own?.start("verify");
    let checked = 0;
    const controller = new AbortController();
    const removeHandler = io.onInterrupt(() => controller.abort(new Error("Interrupted")));
    const onProgress = (event: VerifyProgress) => {
      if (event.kind === "build") stage?.detail("building project/", "Building project/");
      if (event.kind === "page") {
        checked++;
        stage?.detail(
          `${event.page} ${s.theme.dim(`· ${event.viewport} · ${checked} checked`)}`,
          `checking ${event.page} (${event.viewport})`,
        );
      }
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
      onResult?.(result);
      if (args.json) {
        io.stdout(JSON.stringify(result, null, 2));
        return result.exitCode;
      }
      const checks = result.report?.checks ?? [];
      const passed = checks.filter((c) => c.pass).length;
      const counts = `${passed}/${checks.length} passed`;
      const buildLines = (result.buildOutput ?? "").split("\n").filter(Boolean);
      switch (result.exitCode) {
        case 0:
          stage?.done(counts);
          break;
        case 1:
          stage?.failed(counts);
          break;
        case 2:
          stage?.failed("Build failed. First 50 lines of output:", buildLines);
          break;
        default:
          stage?.failed(`Verify could not run: ${result.error ?? "unknown error"}`);
          break;
      }
      own?.close();
      if (own) {
        for (const line of own.failure?.details ?? []) io.stderr(`  ${s.theme.muted(line)}`);
        if (result.report) for (const line of verifyReportLines(s.theme, result)) io.stderr(line);
      }
      return result.exitCode;
    } finally {
      own?.close();
      removeHandler();
    }
  };
}

const SHORT_REASON: [RegExp, string][] = [
  [/^pixels/, "pixel"],
  [/^DOM/, "dom"],
  [/console error/, "errors"],
  [/failed request/, "requests"],
];

function shortReasons(check: PageCheck): string {
  return check.reasons
    .map((r) => SHORT_REASON.find(([pattern]) => pattern.test(r))?.[1] ?? r)
    .join(", ");
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** The results table, a block per regression, and the pass count. */
export function verifyReportLines(t: Theme, result: VerifyResult): string[] {
  const report = result.report;
  if (!report) return [];
  const limit = report.thresholds.maxPixelDiff;
  const head = ["page", "viewport", `pixel diff · max ${pct(limit)}`, "DOM", "errors", ""].map(
    (h) => t.dim(h),
  );
  const rows = report.checks.map((c) => {
    const bad = !c.pass;
    const paint = bad ? t.error : t.accent;
    const diff =
      c.pixelDiff === null
        ? t.dim("no baseline")
        : `${bar(t, Math.min(1, c.pixelDiff / (limit * 2)), 10, c.pixelDiff > limit ? t.error : t.accent)} ${c.pixelDiff > limit ? t.error(pct(c.pixelDiff)) : pct(c.pixelDiff)}`;
    const errors = c.newConsoleErrors.length + c.failedRequests.length;
    return [
      c.page,
      t.muted(c.viewport),
      diff,
      c.domSimilarity < report.thresholds.minDomSimilarity
        ? t.error(c.domSimilarity.toFixed(2))
        : c.domSimilarity.toFixed(2),
      errors > 0 ? t.error(String(errors)) : t.muted("0"),
      bad ? paint(`${symbols.failed} ${shortReasons(c)}`) : paint(symbols.done),
    ];
  });
  const lines = ["", ...columns([head, ...rows], 3).map((l) => `  ${l}`)];

  const failing = report.checks.filter((c) => !c.pass);
  for (const c of failing.slice(0, 3)) {
    lines.push("", `  ${t.error(t.bold("regression"))} ${t.muted(`${c.page} · ${c.viewport}`)}`);
    for (const reason of c.reasons) lines.push(`  ${t.muted(reason)}`);
    const worst = c.worstRegions[0];
    if (worst)
      lines.push(`  ${t.muted("worst region")} ${worst.width}×${worst.height} at y ${worst.y}`);
    const change = report.sinceLastPass?.changes.find(
      (x) => x.page === c.page && x.viewport === c.viewport,
    );
    if (change) {
      const [before, after] = change.pixelDiff;
      if (before !== null && after !== null)
        lines.push(`  ${t.muted("since last pass")} pixel diff ${pct(before)} → ${pct(after)}`);
    }
    if (c.diffImage) lines.push(`  ${t.dim(`diff  ${c.diffImage}`)}`);
  }
  if (failing.length > 3)
    lines.push(`  ${t.dim(`and ${failing.length - 3} more in verify/report.md`)}`);

  const passed = report.checks.length - failing.length;
  const total = `${passed}/${report.checks.length} passed`;
  lines.push(
    "",
    failing.length === 0
      ? `  ${t.accent(t.bold(`${symbols.done} ${total}`))}`
      : `  ${t.error(t.bold(`${symbols.failed} ${total}`))}  ${t.dim(`exit 1 · report verify/report.md`)}`,
  );
  return lines;
}
