import { type AgentFacts, projectScript } from "./facts.js";

/**
 * The files Claude Code (or any coding agent) reads in a workspace. Each one is a plain function of
 * the facts, so the same inputs give the same bytes, and every fact names the analysis file it
 * came from so the agent can check it.
 */

const TARGET_LABEL: Record<AgentFacts["target"], string> = {
  react: "Vite + React",
  vue: "Vite + Vue",
  preact: "Vite + Preact",
  vanilla: "Vite (no UI library)",
};

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const lines = (...parts: (string | false | null | undefined)[]) =>
  `${parts.filter((p) => p !== false && p !== null && p !== undefined).join("\n")}\n`;

export const VERIFY_COMMAND = "s2s verify";

const FRAMEWORK_TITLE: Record<string, string> = { three: "three.js scene" };

export function agentsMd(f: AgentFacts): string {
  const build = projectScript(f.packageManager, "build");
  const typecheck = projectScript(f.packageManager, "typecheck");
  const stack = f.stack.map(
    (s) => `- ${s.label}: ${s.value} (${s.confidence}; see \`${s.source}\`)`,
  );
  const packages = f.packages.map(
    (p) =>
      `- \`${p.name}${p.version ? `@${p.version}` : ""}\`${p.dev ? " (dev)" : ""}, ${p.confidence} confidence`,
  );
  const review = f.review.map(
    (p) =>
      `- \`${p.name}${p.version ? `@${p.version}` : ""}\`, ${p.confidence} confidence${p.reason ? `: ${p.reason}` : ""}`,
  );
  return lines(
    "# AGENTS.md",
    "",
    `Standing rules for reconstructing the frontend of ${f.site}. Read this at the start of every session.`,
    "",
    "## Mission",
    "",
    "Turn the recovered code in `project/src/_recovered/` into plausible, readable source: real names, types, one component per file, a sensible folder structure. Behaviour must stay identical; `s2s verify` checks that after every change. This is a reconstruction, not the original source, and nothing in it should claim otherwise.",
    "",
    "## Workspace",
    "",
    "| Path | What it is |",
    "| --- | --- |",
    "| `project/` | The buildable project. All your work happens here. |",
    "| `project/src/_recovered/` | Recovered modules, wired to `project/src/main.ts` so the project builds as is. It shrinks to empty as you move code out. |",
    "| `PROGRESS.md` | The checklist you work through and tick. |",
    "| `raw/` | The capture: requests, response bodies, page snapshots, screenshots. Read-only. |",
    "| `analysis/` | What s2s worked out: packages, modules, groups, styling, bundler. Read-only. |",
    "| `recovered/` | s2s's own copy of the recovered code, for comparison. Read-only. |",
    "| `verify/` | `s2s verify` output: `report.md`, `report.json`, diff images, history. |",
    "",
    "`analysis/scaffold.json` maps each module in `analysis/modules.json` to its file under `project/src/_recovered/`.",
    "",
    "## Trust levels",
    "",
    "Each module in `analysis/modules.json` has an `origin`:",
    "",
    "- `sourcemap-exact`: real source from a source map. Keep the code; only move it and fix imports.",
    "- `renamed`: minified code with names restored from a partial source map. The names are real; the structure may not be.",
    "- `unbundled`: split out of a bundle and de-minified. Names, boundaries and structure are guesses for you to improve.",
    "",
    "A `boundary` of `heuristic` means s2s guessed where the module starts and ends; merge or split it if the code says otherwise.",
    "",
    "## Detected stack",
    "",
    `- Scaffold: ${TARGET_LABEL[f.target]}`,
    ...stack,
    f.fallbackFrom
      ? `\nThe site was built with ${f.fallbackFrom}. This scaffold is a Vite single-page app built from the hydrated DOM, not a ${f.fallbackFrom} project: keep the pages working as an SPA and don't add ${f.fallbackFrom}.`
      : null,
    "",
    ...(f.framework
      ? [
          `## ${FRAMEWORK_TITLE[f.framework.name] ?? f.framework.name}`,
          "",
          ...f.framework.lines,
          "",
        ]
      : []),
    "## Packages",
    "",
    `Installed in \`project/package.json\` (see \`analysis/packages.json\`):`,
    "",
    ...(packages.length > 0 ? packages : ["- none detected"]),
    "",
    review.length > 0
      ? lines(
          "To review: confirm each one with evidence from the code (an import you need, a version string) and add it, or reject it and say why in `PROGRESS.md` (see `analysis/packages-review.json`):",
          "",
          ...review,
        ).trimEnd()
      : "Nothing is waiting for review (see `analysis/packages-review.json`).",
    "",
    "Never copy library code into `src/`. Where recovered code still contains library code, replace it with an import of the package.",
    "",
    "## Conventions",
    "",
    "- TypeScript, `strict`. Turn each module you touch into `.ts` or `.tsx`.",
    "- One component per file. Hooks go in `hooks/`.",
    "- When you rename an identifier, rename it everywhere it is used, across files.",
    "- No new features, no redesigns, no dependency upgrades.",
    "- No network calls to the real site. Verify replays the captured responses; anything else is blocked.",
    `- Resolve every \`// s2s:\` note you come across (there are ${f.notes}), then delete it.`,
    "",
    "## Verify",
    "",
    `Run \`${VERIFY_COMMAND}\` from the workspace root. It builds the project, serves it with the captured responses, and compares every captured page and viewport with the capture.`,
    "",
    "| Exit code | Meaning |",
    "| --- | --- |",
    "| 0 | Pass |",
    "| 1 | Regression: read `verify/report.md` |",
    "| 2 | Build failed: the lines that report the failure are printed |",
    "| 3 | Verify itself failed (not your change) |",
    "",
    "Thresholds (from `s2s.config.ts`):",
    "",
    `- Pixel difference per page and viewport at most ${pct(f.thresholds.maxPixelDiff)}, with dynamic regions masked`,
    `- DOM similarity to the captured page at least ${f.thresholds.minDomSimilarity}`,
    `- New console errors at most ${f.thresholds.maxNewConsoleErrors}`,
    `- Failed requests at most ${f.thresholds.maxFailedRequests}`,
    "",
    "A group is not done until verify passes.",
    "",
    `Build alone: \`${build}\`. Typecheck: \`${typecheck}\`.`,
    "",
    "## Never",
    "",
    "- Edit anything in `raw/`, `analysis/` or `recovered/`.",
    "- Run `s2s verify --update-baseline`. Only a person accepts a new baseline.",
    "- Change thresholds, skip pages, or disable checks to make verify pass.",
  );
}

export function promptMd(f: AgentFacts): string {
  return lines(
    "Reconstruct this site's source, one group at a time, following `AGENTS.md`.",
    "",
    `1. Read \`AGENTS.md\`, \`PROGRESS.md\` and \`analysis/modules.json\`. Run \`${VERIFY_COMMAND}\` once to confirm the baseline passes. If it doesn't, stop and say why.`,
    "2. If the structure item in `PROGRESS.md` is unticked: lay out the target folder structure and routes from `analysis/project-hints.json` and the page snapshots in `raw/pages/`, write it down in `PROGRESS.md`, tick the item and commit.",
    "3. Take the first unticked group in `PROGRESS.md`. Read its modules, rename identifiers, add types, split them into components and hooks, move them out of `project/src/_recovered/` into the structure, and fix every import.",
    `4. Run \`${VERIFY_COMMAND}\`. On failure, read \`verify/report.md\`, fix, and run it again. After three failed attempts, revert the group (\`git checkout -- project\`), note why in the Notes section of \`PROGRESS.md\`, and move on.`,
    "5. Tick the group, commit as `reconstruct: group <n> — <summary>`, and continue with the next group. When the session is running low, stop at a clean commit.",
    `6. When every group is done, work through the final items: typecheck clean (\`${projectScript(f.packageManager, "typecheck")}\`), \`project/src/_recovered/\` empty, and a \`project/README.md\` that says this is a reconstruction of ${f.site}, not its original source.`,
    "",
    "If you are picking this up from an earlier session, `PROGRESS.md` and `git log` tell you where it stopped: continue from the first unticked item.",
  );
}

export function progressMd(f: AgentFacts): string {
  const groups = f.groups.flatMap((g, i) => [
    `- [ ] Group ${i + 1} (\`${g.id}\`, ${g.modules.length} module${g.modules.length === 1 ? "" : "s"}, ${kb(g.bytes)})`,
    ...g.modules.map((m) => `  - \`${m.file}\` (${m.kind}, ${m.origin})`),
  ]);
  const review = f.review.map(
    (p) =>
      `- [ ] Review \`${p.name}${p.version ? `@${p.version}` : ""}\`: add it with evidence, or reject it and note why`,
  );
  return lines(
    "# PROGRESS",
    "",
    `Work through this from the top; \`PROMPT.md\` says how. Groups come from \`analysis/modules.json\`, in dependency order.`,
    "",
    "## Structure",
    "",
    "- [ ] Lay out the folder structure and routes (see `analysis/project-hints.json` and `raw/pages/`)",
    "",
    "## Groups",
    "",
    ...(groups.length > 0 ? groups : ["- [x] No modules to reconstruct"]),
    "",
    ...(review.length > 0
      ? ["## Packages to review", "", "See `analysis/packages-review.json`.", "", ...review, ""]
      : []),
    "## Final",
    "",
    `- [ ] Typecheck clean: \`${projectScript(f.packageManager, "typecheck")}\``,
    "- [ ] `project/src/_recovered/` is empty",
    `- [ ] \`project/README.md\` says this is a reconstruction of ${f.site}, not its original source`,
    "",
    "## Notes",
    "",
    "Skipped groups, open questions and decisions go here.",
  );
}

export const CLAUDE_MD = "@AGENTS.md\n";

/** The project slash command `/s2s`: the same text as `PROMPT.md`. */
export function slashCommandMd(f: AgentFacts): string {
  return lines(
    "---",
    "description: Continue reconstructing this site's source from PROGRESS.md",
    "---",
    "",
    promptMd(f).trimEnd(),
  );
}

/** A narrow allowlist: verify, the project's build and typecheck, and git. Nothing else. */
export function claudeSettings(f: AgentFacts): string {
  const allow = [
    `Bash(${VERIFY_COMMAND})`,
    `Bash(${VERIFY_COMMAND}:*)`,
    `Bash(${projectScript(f.packageManager, "build")})`,
    `Bash(${projectScript(f.packageManager, "typecheck")})`,
    "Bash(git status)",
    "Bash(git status:*)",
    "Bash(git diff)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(git checkout --:*)",
    "Bash(git restore:*)",
  ];
  return `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: {
        allow,
        deny: [
          `Bash(${VERIFY_COMMAND} --update-baseline:*)`,
          "Edit(raw/**)",
          "Edit(analysis/**)",
          "Edit(recovered/**)",
        ],
      },
    },
    null,
    2,
  )}\n`;
}
