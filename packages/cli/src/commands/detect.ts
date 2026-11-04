import {
  type Confidence,
  type DetectProgress,
  type DetectResult,
  detect,
  type Explanation,
  explain,
  PACKAGE_MANAGERS,
  type PackageManager,
  type PackageRow,
  WorkspaceError,
} from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
import type { CliIO } from "./capture.js";

export const detectArgs = {
  workspace: {
    type: "positional",
    description: "Workspace folder written by s2s capture",
    required: false,
    default: ".",
  },
  pm: { type: "string", description: "Package manager: pnpm, npm, yarn or bun" },
  install: {
    type: "boolean",
    description: "Install project/package.json with the package manager (scripts disabled)",
  },
  offline: { type: "boolean", description: "Skip npm registry checks; evidence is still written" },
  "min-confidence": {
    type: "string",
    description: "Lowest confidence that goes into dependencies: high, medium (default) or low",
  },
  ranges: { type: "string", description: "Version format: exact (default) or caret" },
  accept: {
    type: "string",
    description:
      "Put these packages in package.json anyway (comma-separated, name or name@version)",
  },
  reject: {
    type: "string",
    description: "Keep these packages out of package.json (comma-separated)",
  },
  explain: { type: "string", description: "Print every piece of evidence behind one package" },
  force: { type: "boolean", description: "Rebuild even if the stage is complete" },
  json: { type: "boolean", description: "Print only the result as JSON" },
} as const;

const CONFIDENCES = ["high", "medium", "low"] as const;

/** Exit codes: 0 complete or skipped, 1 failed (or a failed install), 2 bad flags, 130 interrupted. */
export function detectCommand(io: CliIO, setExitCode: (code: number) => void) {
  const runDetect = detectRunner(io);
  return defineCommand({
    meta: {
      name: "detect",
      description: "Stage 3: detect the site's npm packages and write project/package.json",
    },
    args: detectArgs,
    async run({ args }): Promise<void> {
      setExitCode(await runDetect(args));
    },
  });
}

/** The stage as a function of its parsed flags, for `s2s grab` to run in sequence. */
export function detectRunner(io: CliIO) {
  return runDetect;

  async function runDetect(args: ParsedArgs<typeof detectArgs>): Promise<number> {
    if (args.pm && !(PACKAGE_MANAGERS as readonly string[]).includes(args.pm)) {
      io.stderr(`--pm must be one of ${PACKAGE_MANAGERS.join(", ")}; got "${args.pm}".`);
      return 2;
    }
    const minConfidence = args["min-confidence"];
    if (minConfidence && !(CONFIDENCES as readonly string[]).includes(minConfidence)) {
      io.stderr(`--min-confidence must be high, medium or low; got "${minConfidence}".`);
      return 2;
    }
    if (args.ranges && args.ranges !== "exact" && args.ranges !== "caret") {
      io.stderr(`--ranges must be exact or caret; got "${args.ranges}".`);
      return 2;
    }

    const controller = new AbortController();
    const removeHandler = io.onInterrupt(() => controller.abort(new Error("Interrupted")));
    const quiet = Boolean(args.json || args.explain);
    const onProgress = (event: DetectProgress) => {
      if (quiet && event.kind !== "warning") return;
      switch (event.kind) {
        case "start":
          io.stderr(`Detecting packages in ${event.workspace}`);
          break;
        case "skip":
          io.stderr(
            `Nothing to do: ${event.reason} in ${event.workspace}. Use --force to rebuild.`,
          );
          break;
        case "warning":
          if (!args.json) io.stderr(`  warning: ${event.message}`);
          break;
        case "install":
          io.stderr(`Installing with ${event.manager} (scripts disabled) in ${event.dir}`);
          break;
        case "done":
          io.stderr(`Detect ${event.status}: ${event.summary}`);
          break;
      }
    };
    const list = (value: string | undefined) =>
      value
        ? value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    try {
      const result = await detect({
        workspace: args.workspace || ".",
        force: Boolean(args.force),
        offline: Boolean(args.offline),
        install: Boolean(args.install),
        ...(args.pm ? { pm: args.pm as PackageManager } : {}),
        ...(minConfidence ? { minConfidence: minConfidence as Confidence } : {}),
        ...(args.ranges ? { ranges: args.ranges as "exact" | "caret" } : {}),
        accept: list(args.accept),
        reject: list(args.reject),
        signal: controller.signal,
        onProgress,
      });
      if (args.explain) {
        if (result.status !== "complete")
          io.stderr(`Detect ${result.status}: ${result.error ?? ""}`);
        const explanation = await explain(result.workspace, args.explain);
        if (args.json) io.stdout(JSON.stringify(explanation, null, 2));
        else for (const line of explanationLines(explanation)) io.stdout(line);
        return explanation.record || explanation.evidence.length > 0 ? 0 : 1;
      }
      if (args.json) io.stdout(JSON.stringify(result, null, 2));
      else {
        if (result.error) io.stderr(`  error: ${result.error}`);
        for (const line of tableLines(result.packages)) io.stdout(line);
        if (result.install)
          io.stderr(
            `Install ${result.install.exitCode === 0 ? "ok" : `failed (exit ${result.install.exitCode})`}: ${result.install.lockfile ?? "no lockfile"}`,
          );
      }
      if (result.status === "partial") return 130;
      if (result.status !== "complete") return 1;
      return result.install && result.install.exitCode !== 0 ? 1 : 0;
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

/** The summary table: package, version, confidence, where it went, signal types. */
export function tableLines(rows: PackageRow[]): string[] {
  if (rows.length === 0) return ["No packages found."];
  const header = ["package", "version", "confidence", "status", "signals"];
  const body = rows.map((r) => [
    r.name,
    r.version ?? "-",
    r.confidence,
    r.status,
    r.signals.join(", ") || "implied",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(header), ...body.map(line)];
}

export function explanationLines(explanation: Explanation): string[] {
  const { record, evidence } = explanation;
  const lines: string[] = [];
  if (!record && evidence.length === 0)
    return [`No evidence for ${explanation.package} in this workspace.`];
  if (record) {
    lines.push(
      `${record.name} ${record.version ?? "(no version)"}: ${record.confidence} confidence, ${record.status}${record.reason ? ` (${record.reason})` : ""}`,
    );
    lines.push(`  version source: ${record.versionSource}`);
    if (record.impliedBy.length > 0) lines.push(`  implied by: ${record.impliedBy.join(", ")}`);
    if (record.transitiveOf.length > 0)
      lines.push(`  dependency of: ${record.transitiveOf.join(", ")}`);
    if (record.disagreements.length > 0)
      lines.push(`  other versions seen: ${record.disagreements.join(", ")}`);
    if (record.registry)
      lines.push(
        `  registry: ${record.registry.status}${record.registry.reason ? ` (${record.registry.reason})` : ""}`,
      );
    if (record.vendorBytes > 0) lines.push(`  vendor bytes marked: ${record.vendorBytes}`);
  }
  lines.push(`  evidence (${evidence.length}):`);
  for (const e of evidence) {
    const where =
      e.location.offset === null ? e.location.file : `${e.location.file} @${e.location.offset}`;
    lines.push(
      `  - ${e.signal} [${e.strength}] ${e.version ?? "no version"} ${e.trusted ? "" : "(site text) "}in ${where}`,
    );
    if (e.excerpt) lines.push(`      ${e.excerpt}`);
  }
  return lines;
}

export type { DetectResult };
