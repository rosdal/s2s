# AGENTS.md

Standing rules for reconstructing the frontend of https://shop.example.com/. Read this at the start of every session.

## Mission

Turn the recovered code in `project/src/_recovered/` into plausible, readable source: real names, types, one component per file, a sensible folder structure. Behaviour must stay identical; `s2s verify` checks that after every change. This is a reconstruction, not the original source, and nothing in it should claim otherwise.

## Workspace

| Path | What it is |
| --- | --- |
| `project/` | The buildable project. All your work happens here. |
| `project/src/_recovered/` | Recovered modules, wired to `project/src/main.ts` so the project builds as is. It shrinks to empty as you move code out. |
| `PROGRESS.md` | The checklist you work through and tick. |
| `raw/` | The capture: requests, response bodies, page snapshots, screenshots. Read-only. |
| `analysis/` | What s2s worked out: packages, modules, groups, styling, bundler. Read-only. |
| `recovered/` | s2s's own copy of the recovered code, for comparison. Read-only. |
| `verify/` | `s2s verify` output: `report.md`, `report.json`, diff images, history. |

`analysis/scaffold.json` maps each module in `analysis/modules.json` to its file under `project/src/_recovered/`.

## Trust levels

Each module in `analysis/modules.json` has an `origin`:

- `sourcemap-exact`: real source from a source map. Keep the code; only move it and fix imports.
- `renamed`: minified code with names restored from a partial source map. The names are real; the structure may not be.
- `unbundled`: split out of a bundle and de-minified. Names, boundaries and structure are guesses for you to improve.

A `boundary` of `heuristic` means s2s guessed where the module starts and ends; merge or split it if the code says otherwise.

## Detected stack

- Scaffold: Vite + React
- UI library: react 18.3.1 (high confidence; see `analysis/packages.json`)
- Original bundler: webpack 5 (high confidence; see `analysis/bundler.json`)

## Packages

Installed in `project/package.json` (see `analysis/packages.json`):

- `react@18.3.1`, high confidence
- `react-dom@18.3.1`, high confidence

To review: confirm each one with evidence from the code (an import you need, a version string) and add it, or reject it and say why in `PROGRESS.md` (see `analysis/packages-review.json`):

- `scheduler`, low confidence: license comment only

Never copy library code into `src/`. Where recovered code still contains library code, replace it with an import of the package.

## Conventions

- TypeScript, `strict`. Turn each module you touch into `.ts` or `.tsx`.
- One component per file. Hooks go in `hooks/`.
- When you rename an identifier, rename it everywhere it is used, across files.
- No new features, no redesigns, no dependency upgrades.
- No network calls to the real site. Verify replays the captured responses; anything else is blocked.
- Resolve every `// s2s:` note you come across (there are 2), then delete it.

## Verify

Run `s2s verify` from the workspace root. It builds the project, serves it with the captured responses, and compares every captured page and viewport with the capture.

| Exit code | Meaning |
| --- | --- |
| 0 | Pass |
| 1 | Regression: read `verify/report.md` |
| 2 | Build failed: the lines that report the failure are printed |
| 3 | Verify itself failed (not your change) |

Thresholds (from `s2s.config.ts`):

- Pixel difference per page and viewport at most 2%, with dynamic regions masked
- DOM similarity to the captured page at least 0.95
- New console errors at most 0
- Failed requests at most 0

A group is not done until verify passes.

Build alone: `pnpm --dir project run build`. Typecheck: `pnpm --dir project run typecheck`.

## Never

- Edit anything in `raw/`, `analysis/` or `recovered/`.
- Run `s2s verify --update-baseline`. Only a person accepts a new baseline.
- Change thresholds, skip pages, or disable checks to make verify pass.
