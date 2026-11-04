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
import {
  columns,
  createTheme,
  ownStage,
  type StageReporter,
  surfaceOf,
  symbols,
  type Theme,
  truncate,
} from "../ui.js";
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
export function detectRunner(io: CliIO, shared?: StageReporter) {
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

    const own = shared || args.json || args.explain ? undefined : ownStage(io, "detect");
    const stage = shared ?? own?.stage;
    const t = surfaceOf(io).theme;
    const controller = new AbortController();
    const removeHandler = io.onInterrupt(() => controller.abort(new Error("Interrupted")));
    const onProgress = (event: DetectProgress) => {
      if (event.kind === "warning" && !stage && !args.json) {
        io.stderr(`${t.warn(symbols.warning)} ${t.muted(event.message)}`);
        return;
      }
      if (!stage) return;
      switch (event.kind) {
        case "start":
          stage.detail(
            args.offline ? "weighing the evidence" : "weighing the evidence, checking the registry",
            `Detecting packages in ${event.workspace}`,
          );
          break;
        case "warning":
          stage.warn(event.message);
          break;
        case "install":
          stage.detail(
            `installing with ${event.manager} ${t.dim("· scripts disabled")}`,
            `Installing with ${event.manager} (scripts disabled) in ${event.dir}`,
          );
          break;
        case "done":
          if (event.status === "complete") stage.done(event.summary);
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
        else for (const line of explanationLines(explanation, t)) io.stdout(line);
        return explanation.record || explanation.evidence.length > 0 ? 0 : 1;
      }
      if (args.json) io.stdout(JSON.stringify(result, null, 2));
      else {
        if (result.skipped) stage?.skipped(`already complete · ${result.summary}`);
        else if (result.status === "partial") stage?.failed("interrupted");
        else if (result.status !== "complete") stage?.failed(result.error ?? "detect failed");
        if (result.install)
          stage?.note(
            `install ${result.install.exitCode === 0 ? "ok" : `failed (exit ${result.install.exitCode})`}: ${result.install.lockfile ?? "no lockfile"}`,
          );
        own?.close();
        if (!shared) {
          io.stderr("");
          for (const line of tableLines(result.packages, t)) io.stdout(line);
        }
      }
      if (result.status === "partial") return 130;
      if (result.status !== "complete") return 1;
      return result.install && result.install.exitCode !== 0 ? 1 : 0;
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

/** Confidence in its color: high in the accent, medium in blue, low and review in amber. */
export function confidenceText(t: Theme, confidence: string): string {
  return confidence === "high"
    ? t.accent(confidence)
    : confidence === "medium"
      ? t.info(confidence)
      : t.warn(confidence);
}

/** The summary table: package, version, confidence, where it went, signal types. */
export function tableLines(rows: PackageRow[], t: Theme = createTheme(1)): string[] {
  if (rows.length === 0) return ["No packages found."];
  const header = ["package", "version", "confidence", "status", "signals"].map((h) => t.dim(h));
  const body = rows.map((r) => {
    const review = r.status === "review";
    return [
      review ? t.warn(r.name) : r.status === "rejected" ? t.dim(r.name) : r.name,
      r.version ?? t.dim("-"),
      confidenceText(t, r.confidence),
      review ? t.warn(r.status) : t.muted(r.status),
      t.dim(r.signals.join(", ") || "implied"),
    ];
  });
  return columns([header, ...body]);
}

const STRENGTH_PAINT: Record<string, "accent" | "info" | "warn" | "dim"> = {
  exact: "accent",
  strong: "accent",
  weak: "warn",
  "name-only": "dim",
};

export function explanationLines(explanation: Explanation, t: Theme = createTheme(1)): string[] {
  const { record, evidence } = explanation;
  const lines: string[] = [];
  if (!record && evidence.length === 0)
    return [`No evidence for ${explanation.package} in this workspace.`];
  if (record) {
    const tagColor =
      record.confidence === "high" ? "accent" : record.confidence === "medium" ? "info" : "warn";
    lines.push(
      `${t.bold(record.name)}  ${record.version ?? t.dim("(no version)")}  ${t.tag(tagColor, record.confidence.toUpperCase())}  ${t.dim(`${record.status} · version from ${record.versionSource}`)}`,
    );
    if (record.reason) lines.push(t.muted(record.reason));
    const facts: [string, string][] = [];
    if (record.impliedBy.length > 0) facts.push(["implied by", record.impliedBy.join(", ")]);
    if (record.transitiveOf.length > 0)
      facts.push(["dependency of", record.transitiveOf.join(", ")]);
    if (record.disagreements.length > 0)
      facts.push(["other versions", record.disagreements.join(", ")]);
    if (record.registry)
      facts.push([
        "registry",
        `${record.registry.status}${record.registry.reason ? ` (${record.registry.reason})` : ""}`,
      ]);
    if (record.vendorBytes > 0) facts.push(["vendor bytes", String(record.vendorBytes)]);
    if (facts.length > 0) {
      lines.push("");
      lines.push(...columns(facts.map(([k, v]) => [t.dim(k), v])));
    }
  }
  lines.push("", t.muted(`evidence (${evidence.length})`));
  const signalWidth = Math.max(0, ...evidence.map((e) => e.signal.length)) + 2;
  const indent = " ".repeat(signalWidth + 11);
  evidence.forEach((e, i) => {
    const where =
      e.location.offset === null ? e.location.file : `${e.location.file} @${e.location.offset}`;
    const paint = t[STRENGTH_PAINT[e.strength] ?? "dim"];
    const last = i === evidence.length - 1;
    const stem = t.rule(last ? " " : "│");
    lines.push(
      `  ${t.rule(last ? symbols.last : symbols.branch)} ${t.muted(e.signal.padEnd(signalWidth))}${paint(e.strength.padEnd(11))}${e.version ?? t.dim("no version")}${e.trusted ? "" : t.warn("  site text")}`,
    );
    lines.push(`  ${stem} ${indent}${t.dim(where)}`);
    if (e.excerpt) lines.push(`  ${stem} ${indent}${t.dim(truncate(e.excerpt, 80))}`);
  });
  if (record) {
    const pin = record.version ? `${record.name}@${record.version}` : record.name;
    lines.push(
      "",
      `${t.bold("--accept")} ${pin}  ${t.dim("put it in package.json")}`,
      `${t.bold("--reject")} ${record.name}  ${t.dim("keep it out")}`,
    );
  }
  return lines;
}

export type { DetectResult };
