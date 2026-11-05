import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanUrl,
  readManifest,
  type VerifyResult,
  workspacePaths,
  workspaceSlug,
} from "@rosdal/s2s-core";
import { defineCommand, type ParsedArgs } from "citty";
import {
  box,
  columns,
  plural,
  StageList,
  type StageReporter,
  type Surface,
  stackedBar,
  surfaceOf,
  symbols,
  truncate,
  visibleLength,
} from "../ui.js";
import { type CliIO, captureArgs, captureRunner } from "./capture.js";
import { confidenceText, detectArgs, detectRunner } from "./detect.js";
import { mapsRunner } from "./maps.js";
import { scaffoldArgs, scaffoldRunner } from "./scaffold.js";
import { unbundleArgs, unbundleRunner } from "./unbundle.js";
import { verifyReportLines, verifyRunner } from "./verify.js";

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

function displayPath(workspace: string): string {
  const rel = path.relative(process.cwd(), workspace);
  if (!rel) return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return workspace;
  return `.${path.sep}${rel}`;
}

export function grabRunner(io: CliIO, version: string) {
  return async function runGrab(args: GrabArgs): Promise<number> {
    const target = cleanUrl(args.url);
    if (!target) {
      io.stderr(`Not an http(s) URL: ${args.url}`);
      return 2;
    }
    const s = surfaceOf(io);
    const t = s.theme;
    const workspace = path.resolve(args.out ?? workspaceSlug(target));
    const force = Boolean(args.force);
    const common = { _: [] as string[], json: false, force };

    const facts: [string, string][] = [
      ["target", target.href.replace(/^https?:\/\//, "")],
      ["out", displayPath(workspace)],
    ];
    if (args.pm) facts.push(["pm", `${args.pm} ${t.dim("· from --pm")}`]);
    if (args.assets) facts.push(["assets", args.assets]);
    io.stderr("");
    io.stderr(`${t.accent(t.bold("s2s"))}  ${t.muted("site → source")}  ${t.dim(`v${version}`)}`);
    io.stderr("");
    for (const line of columns(
      facts.map(([k, v]) => [t.dim(k), v]),
      4,
    ))
      io.stderr(line);
    io.stderr("");
    if (args.assets === "clone" || args.assets === "original") {
      io.stderr(
        `${t.warn(`${symbols.warning} --assets ${args.assets}`)} ${t.muted("puts the site's own models, textures and sounds in project/: for local study only, never publish or share them.")}`,
      );
      io.stderr("");
    }

    const names = ["capture", "maps", "detect", "unbundle", "scaffold"];
    if (args.verify !== false) names.push("verify");
    const list = new StageList(s, names);
    list.footer = "ctrl+c stops · s2s grab again resumes from manifest.json";
    list.show();
    // Runner output that is not a stage event (a bad flag) prints above the live list.
    const sio: CliIO = { ...io, stderr: (line) => list.print([line]) };

    let verifyResult: VerifyResult | undefined;
    const stages: [string, (stage: StageReporter) => Promise<number>][] = [
      [
        "capture",
        (stage) =>
          captureRunner(sio, version, stage)({ ...args, ...common, out: workspace } as never),
      ],
      ["maps", (stage) => mapsRunner(sio, stage)({ ...common, workspace } as never)],
      [
        "detect",
        (stage) =>
          detectRunner(sio, stage)({ ...args, ...common, workspace, install: false } as never),
      ],
      [
        "unbundle",
        (stage) => unbundleRunner(sio, stage)({ ...args, ...common, workspace } as never),
      ],
      [
        "scaffold",
        (stage) => scaffoldRunner(sio, stage)({ ...args, ...common, workspace } as never),
      ],
    ];
    if (args.verify !== false)
      stages.push([
        "verify",
        (stage) =>
          verifyRunner(sio, stage, (r) => {
            verifyResult = r;
          })({ _: [], workspace, json: false } as never),
      ]);

    for (const [name, run] of stages) {
      const stage = list.start(name);
      let code: number;
      try {
        code = await run(stage);
      } catch (error) {
        list.close();
        throw error;
      }
      if (code === 0) continue;
      list.close();
      if (name === "verify" && code === 1 && verifyResult) {
        // A regression on the untouched scaffold is worth seeing, but the workspace is ready.
        for (const line of verifyReportLines(t, verifyResult)) io.stderr(line);
        for (const line of await finalSummary(s, workspace, verifyResult)) io.stderr(line);
        return code;
      }
      for (const line of failureLines(s, list, name, code)) io.stderr(line);
      return code;
    }
    list.close();
    for (const line of await finalSummary(s, workspace, verifyResult)) io.stderr(line);
    return 0;
  };
}

function failureLines(s: Surface, list: StageList, name: string, code: number): string[] {
  const t = s.theme;
  const failure = list.failure;
  const width = Math.min(s.columns, 100);
  const title =
    code === 130
      ? `${t.error(t.bold(`${name} interrupted`))}`
      : `${t.error(t.bold(`${name} failed`))}  ${failure?.name === name ? failure.summary : ""}`;
  const details = (failure?.details ?? []).slice(0, 24).map((l) => t.muted(truncate(l, width - 6)));
  const kept = list.stages.filter((st) => st.state === "done" || st.state === "skipped").length;
  return [
    "",
    ...box(t, [title, ...(details.length > 0 ? ["", ...details] : [])], width, t.error),
    "",
    `${t.bold("s2s grab")} ${t.muted(`again resumes at ${name}`)} ${t.dim(`· ${plural(kept, "stage")} kept`)}`,
    t.dim(`s2s grab stopped at ${name} (exit ${code})`),
  ];
}

interface PackagesFile {
  packages: {
    name: string;
    version: string | null;
    confidence: string;
    status: string;
    signals?: string[];
  }[];
}

async function finalSummary(
  s: Surface,
  workspace: string,
  verifyResult: VerifyResult | undefined,
): Promise<string[]> {
  const t = s.theme;
  const paths = workspacePaths(workspace);
  const manifest = await readManifest(paths.manifest).catch(() => undefined);
  const stages = manifest?.stages;
  const packages = await readFile(path.join(paths.analysis, "packages.json"), "utf8")
    .then((text) => JSON.parse(text) as PackagesFile)
    .catch((): PackagesFile => ({ packages: [] }));
  const progressItems = await readFile(path.join(workspace, "PROGRESS.md"), "utf8")
    .then((text) => text.split("\n").filter((l) => /^\s*- \[ \]/.test(l)).length)
    .catch(() => null);

  const width = Math.min(s.columns, 100);
  const inner = width - 4;
  const n = (stats: Record<string, number> | undefined, key: string) => stats?.[key] ?? 0;
  const maps = stages?.maps.stats;
  const unbundle = stages?.unbundle.stats;
  const bundler = String(stages?.unbundle.details?.bundler ?? "unknown bundler");
  const bundlerVersion = unbundle?.bundlerVersion ? ` ${unbundle.bundlerVersion}` : "";
  const scaffoldTarget = String(stages?.scaffold.details?.target ?? "vanilla");
  const build = String(stages?.scaffold.details?.build ?? "skipped");
  const webglSummary = stages?.scaffold.details?.webglSummary;

  const lines: string[] = [];
  const title = t.accent(t.bold("Reconstruction ready"));
  const stack = t.dim(`${bundler}${bundlerVersion} · ${scaffoldTarget}`);
  lines.push(
    `${title}${" ".repeat(Math.max(2, inner - visibleLength(title) - visibleLength(stack)))}${stack}`,
  );

  if (typeof webglSummary === "string") lines.push("", `${t.muted("webgl")}  ${webglSummary}`);
  if (stages?.scaffold.details?.localOnly === true)
    lines.push(t.warn("assets are the site's own art: local study only (see ASSETS.md)"));

  // How much of the first-party code came back as written, renamed, or must be reconstructed.
  const exact = Math.min(1, n(maps, "coverageJs"));
  const renamed = Math.min(1 - exact, n(maps, "coverageJsRenamed"));
  const rest = Math.max(0, 1 - exact - renamed);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  lines.push("", t.muted("first-party code"));
  lines.push(
    stackedBar(
      t,
      [
        [exact, t.accent],
        [renamed, t.info],
      ],
      inner,
    ),
  );
  lines.push(
    [
      `${t.accent("■")} exact ${pct(exact)}`,
      `${t.info("■")} renamed ${pct(renamed)}`,
      `${t.rule("■")} reconstructed ${pct(rest)}`,
      t.dim(
        n(maps, "maps") > 0 ? `from ${plural(n(maps, "maps"), "source map")}` : "no source maps",
      ),
    ].join("   "),
  );

  const shown = packages.packages
    .filter(
      (p) => p.status === "dependency" || p.status === "devDependency" || p.status === "review",
    )
    .sort((a, b) => Number(a.status === "review") - Number(b.status === "review"));
  if (shown.length > 0) {
    lines.push("", t.muted("packages"));
    const rows = shown.slice(0, 8).map((p) => {
      const review = p.status === "review";
      return [
        review ? t.warn(p.name) : p.name,
        p.version ?? t.dim("?"),
        review ? t.warn("review") : confidenceText(t, p.confidence),
        t.dim(truncate((p.signals ?? []).join(" · ") || "implied", 40)),
      ];
    });
    lines.push(...columns(rows, 3));
    if (shown.length > 8)
      lines.push(t.dim(`and ${shown.length - 8} more · analysis/packages.json`));
    const review = shown.filter((p) => p.status === "review");
    if (review[0]) lines.push(t.dim(`s2s detect --explain ${review[0].name} shows why`));
  }

  const totalBytes = n(unbundle, "totalBytes");
  const vendor = totalBytes === 0 ? 0 : n(unbundle, "vendorDroppedBytes") / totalBytes;
  const verifyChecks = verifyResult?.report?.checks ?? [];
  const verifyText =
    verifyResult === undefined
      ? t.dim("skipped")
      : verifyResult.exitCode === 0
        ? `${t.accent(`${symbols.done} pass`)} ${t.dim(plural(verifyChecks.length, "check"))}`
        : verifyResult.exitCode === 1
          ? t.error(`${symbols.failed} ${verifyChecks.filter((c) => !c.pass).length} regressed`)
          : t.error(
              `${symbols.failed} ${verifyResult.exitCode === 2 ? "build failed" : "could not run"}`,
            );
  lines.push(
    "",
    ...columns(
      [
        [t.dim("modules"), t.dim("vendor dropped"), t.dim("build"), t.dim("baseline verify")],
        [
          `${n(unbundle, "modules")} in ${plural(n(unbundle, "groups"), "group")}`,
          pct(vendor),
          build === "passed" ? t.accent(build) : build === "failed" ? t.error(build) : t.dim(build),
          verifyText,
        ],
      ],
      6,
    ),
  );

  const rel = path.relative(process.cwd(), workspace) || ".";
  const cd = /\s/.test(rel) ? `"${rel}"` : rel;
  const wrote = [
    "AGENTS.md",
    "PROMPT.md",
    progressItems === null ? "PROGRESS.md" : `PROGRESS.md ${t.dim(plural(progressItems, "item"))}`,
    "CLAUDE.md",
    `project/ ${t.dim(build === "passed" ? "builds" : "")}`.trimEnd(),
  ];
  return [
    "",
    ...box(t, lines, width),
    "",
    `${t.muted("wrote")}  ${wrote.join("   ")}`,
    "",
    t.muted("next"),
    `  ${t.dim("$")} cd ${cd}`,
    `  ${t.dim("$")} claude "$(cat PROMPT.md)"   ${t.dim("# or run claude there and type")} ${t.accent("/s2s")}`,
    "",
  ];
}
