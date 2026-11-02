# Site-to-Source — Product Design

Nov 2, 2026 · @Mark

## Summary

Site-to-Source (working name, CLI `s2s`) turns a live URL into a plausible, buildable reconstruction of its frontend source. It splits the work in two. The CLI does everything deterministic and cheap: capture, source maps, package detection, unbundling and scaffolding. Then it writes `AGENTS.md` and `PROMPT.md`, and the expensive reasoning part runs in Claude Code on your own subscription instead of per-token API calls.

**Goals**

- One command from URL to a workspace you can open in Claude Code: `s2s grab https://example.com`
- Recover as much as possible without an LLM, so the agent spends its budget on naming, structure and types, not on mechanical cleanup
- Third-party code becomes real dependencies in `package.json`, installed with the user's package manager (pnpm, npm, yarn, bun)
- Every claim carries evidence and a confidence score, so the agent and the user know what is certain and what is a guess
- A verify loop (build, serve, screenshot diff) so the agent can check its own reconstruction

**Non-goals**

- Server-side code, APIs, CMS pipelines and secrets; these never reach the browser
- Byte-identical original source; the target is "code a developer could have written that behaves the same"
- Calling an LLM API from the CLI itself (possible later as an opt-in, not the default)
- Bypassing logins, paywalls or bot protection

## Tech choice

Build it as a TypeScript CLI on Node 22+, published to npm so it runs with `npx s2s` or `pnpm dlx s2s`. Every hard dependency in this space is a JS library: Playwright, the JS parsers, and the existing unbundlers. Going TypeScript means wrapping them directly instead of shelling out across languages.

| Concern                  | Pick                                                    | Why                                                             |
| ------------------------ | ------------------------------------------------------- | --------------------------------------------------------------- |
| Runtime                  | Node 22+ (Bun supported for running, not required)      | Playwright is most reliable on Node; Bun users still get `bunx` |
| CLI framework            | citty or commander, @clack/prompts for interactive mode | Small, typed, good subcommand support                           |
| Browser capture          | Playwright (Chromium)                                   | Network interception, storage state, viewports, screenshots     |
| Fast parsing             | oxc-parser                                              | Fingerprinting needs to parse megabytes of JS quickly           |
| Transforms               | Babel (via webcrack and wakaru)                         | The existing deobfuscation tooling is Babel-based               |
| Source maps              | `source-map` / `@jridgewell/trace-mapping`              | Standard, fast                                                  |
| Formatting               | Prettier                                                | Readable output before the agent touches it                     |
| State and fingerprint DB | SQLite (better-sqlite3)                                 | One portable file, fast lookups by hash                         |
| Monorepo                 | pnpm workspaces + tsup                                  | `core`, `cli`, `ui`, `fingerprint-builder` packages             |

**CLI first, GUI second.** The CLI is scriptable, resumable and lives in the same terminal as Claude Code. The GUI (later section) is a local web UI served by the CLI (`s2s ui`), so it reuses `core` with no second codebase. A Tauri wrapper is an option once the web UI is stable.

## Architecture

&#91;embedded content: pipeline · 5 CLI stages, then the agent loop\]

Five deterministic stages run in the CLI and write one workspace folder; Claude Code then loops between reconstructing a module group and verifying it, tracking progress in `PROGRESS.md`. Each stage records its status in `manifest.json`, so any stage can be rerun or resumed without redoing the ones before it.

**Workspace layout**

```
shopify-com-editions-winter2026/
├── manifest.json        stage status, inputs, tool versions
├── raw/                 read-only capture
│   ├── har/
│   ├── bodies/          responses by content hash
│   ├── pages/           SSR HTML + hydrated DOM per page
│   └── screenshots/     verify baseline
├── recovered/
│   ├── sourcemap/       exact sources from maps
│   └── unbundled/       cleaned first-party modules
├── analysis/
│   ├── packages.json    detected packages + evidence
│   └── modules.json     module graph + work order
├── assets/              fonts, images, media
├── project/             becomes the reconstruction
│   ├── package.json
│   └── src/
├── CLAUDE.md            imports AGENTS.md
├── AGENTS.md
├── PROMPT.md
└── PROGRESS.md
```

## Stage 1: Capture

Capture drives a real Chromium through Playwright and stores every response body by content hash, so nothing the page used is missed and nothing is stored twice.

1. **Load and record.** Open the URL at desktop and mobile viewports. Record every request and response (URL, headers, status, initiator, body) and export a HAR alongside the raw bodies.
2. **Snapshot both HTML states.** Save the server-rendered HTML (first response) and the hydrated DOM after network idle. The difference tells later stages what is SSR and what is client-rendered.
3. **Trigger lazy code.** Scroll to the bottom, hover and open nav menus, focus inputs, and wait for idle after each step. This pulls in dynamic `import()` chunks.
4. **Find chunks that never loaded.** Parse every captured JS file for chunk references: webpack's chunk-URL function, Next.js `_buildManifest.js`, Vite `modulepreload` links and import maps, and string literals ending in `.js` or `.css` under the same base path. Fetch them directly.
5. **Crawl pages (optional).** Follow same-origin links up to `--depth` or a `--pages` list. Each page gets its own snapshot; assets stay deduplicated.
6. **Classify origins.** Tag each request as first-party, CDN library, analytics or ads, fonts, or media. CDN URLs like `cdn.jsdelivr.net/npm/pkg@1.2.3` are free, high-confidence package hits for Stage 3.
7. **Capture runtime facts.** Evaluate a probe script in the page for globals and version strings (`React.version`, `jQuery.fn.jquery`, `__NEXT_DATA__`, `__remixContext`, `__NUXT__`, devtools hooks). Take full-page screenshots per viewport as the verify baseline.

Defaults: polite rate limit, respects `robots.txt`, identifies itself in the user agent. `--auth-state` accepts a Playwright storage-state file for sites the user is allowed to access while logged in.

## Stage 2: Source maps

When a site ships source maps, this stage alone recovers near-original source, and the later stages only fill gaps. It runs before anything else touches the code.

- **Discovery:** the `SourceMap` / `X-SourceMap` response header, the `//# sourceMappingURL=` comment (including inline `data:` maps), and a blind probe for `<file>.map` on every JS and CSS file.
- **Full maps** (with `sourcesContent`): write each source to `recovered/sourcemap/` under its original path, with `webpack://`, `vite:` and `/@fs/` prefixes normalized. These files are marked `confidence: exact`.
- **Partial maps** (mappings and `names` only): use them to rename identifiers in the minified code back to original names, and to recover file boundaries.
- **Free package data:** source paths under `node_modules` give package names directly. pnpm-style paths like `node_modules/.pnpm/react@18.3.1/...` give exact versions. Both feed Stage 3 as top-tier evidence.
- **Hints for the scaffold:** `.ts`/`.tsx` extensions, `src/app/` or `pages/` folders, and `.vue`/`.svelte` files reveal language and framework.

## Stage 3: Package detection

Package detection combines cheap signals with an AST fingerprint database and outputs `packages.json`: name, version range, confidence, and the evidence behind each match. The fingerprint database is the product's moat; the other signals exist mostly to make it cheaper and to cross-check it.

**Signals, strongest first**

| Signal           | Example                                                 | Confidence           |
| ---------------- | ------------------------------------------------------- | -------------------- |
| Source map path  | `node_modules/.pnpm/zod@3.23.8/...`                     | Exact name + version |
| CDN URL          | `unpkg.com/swiper@11.1.4/...`                           | Exact name + version |
| License banner   | `/*! lodash v4.17.21 */`                                | High                 |
| Runtime probe    | `React.version === "18.3.1"`                            | High                 |
| AST fingerprint  | 214 of 260 function hashes match `framer-motion@11.2.x` | Scored               |
| Framework marker | `__NEXT_DATA__`, `data-astro-cid-*`                     | Name only            |

**Fingerprint database**

1. **Pick the corpus.** Start with the top \~1,000 npm packages by weekly downloads that ship browser code, plus the full ecosystems of React, Vue, Svelte, Next, Remix and Astro. Grow toward 10,000.
2. **Build variants.** For each version, bundle the package entry points with esbuild and terser in a few common minify configs. Different minifier settings are the main reason naive matching fails.
3. **Hash functions.** Parse with oxc, then hash each function's normalized AST: identifiers replaced by binding position, literals bucketed by type, trivia removed. Store hash → (package, version, export path).
4. **Match.** Hash every function in the target's vendor code, count hits per package-version, then use hashes unique to a single version to narrow the range. Report the best match with a score; tree-shaking means partial matches are normal.
5. **Ship it.** Distribute the index as a versioned SQLite file (`s2s db pull`). `s2s db build <pkg>` adds packages locally, for private or niche libraries.

**Package manager output**

The user picks a manager with `--pm`, the config file, or auto-detection of what is installed. `s2s` writes `package.json` with `dependencies` and inferred `devDependencies` (TypeScript, the bundler, the framework CLI). With `--install`, it runs the manager to produce a real lockfile. Low-confidence matches are commented in `AGENTS.md` instead of silently installed.

## Stage 4: Unbundle and clean up

This stage does every mechanical transform before the agent starts, so Claude Code receives split, readable modules instead of a 2 MB minified blob. All passes are deterministic and each writes a diffable snapshot.

1. **Detect the bundler** (webpack 4/5, Rollup/Vite, esbuild, Parcel, Turbopack) from runtime signatures.
2. **Unpack modules** with webcrack's unpacker (webpack, Browserify) and wakaru's unpacker, plus a custom Rollup/Vite splitter that uses chunk boundaries and export maps.
3. **Drop vendor code.** Modules matched in Stage 3 are removed and every reference is rewritten to `import { x } from "pkg"`. On most sites, vendor code is the bulk of the bundle, so this is the biggest cut to what the agent must read.
4. **Undo transpilation:** `jsx()` and `createElement` calls back to JSX, regenerator and `_asyncToGenerator` back to `async`/`await`, class helpers back to `class`, optional-chaining and spread helpers back to syntax.
5. **Undo minification:** `!0` to `true`, split comma sequences, expand ternary statements, restore `if` blocks, inline the obvious constants. Apply partial-source-map names where available.
6. **CSS:** prettify, detect Tailwind (`--tw-` variables, utility-class density), CSS Modules (hashed class names), and CSS-in-JS runtimes. Pull fonts and images into `assets/`.
7. **Build the module graph.** Write `modules.json`: each module's file, size, imports, exports, the pages that use it, and a suggested work order (leaves first). The agent's plan is built from this file.
8. **Format** everything with Prettier.

## Stage 5: Agent handoff

`s2s` ends by writing a project skeleton plus four agent files; the user runs `claude` in the workspace and pastes `PROMPT.md` (or passes it as the first message). The reconstruction then runs on the user's Claude subscription.

**Files written**

- `CLAUDE.md` contains one line, `@AGENTS.md`, so Claude Code loads the shared instructions and other agents (Codex, Cursor) read the same file.
- `AGENTS.md` holds standing context and rules:
  - What each workspace folder is, and that `raw/` and `recovered/sourcemap/` are read-only ground truth
  - The detected framework, bundler, language and package manager, with confidence
  - The package list, with low-confidence matches flagged for the agent to confirm or replace
  - Conventions: consistent renames across files, TypeScript with inferred types, no invented features, import packages instead of vendoring them
  - The verify command and what passing means
- `PROMPT.md` is the task itself, written as a resumable phased plan:
  1. Read `AGENTS.md`, `modules.json` and `PROGRESS.md`; continue from the first unchecked item
  2. Scaffold the framework structure (routes, layouts, entry points) from the page snapshots
  3. Work through modules in `modules.json` order, one group per pass: rename, add types, split into components and hooks, move into the folder structure
  4. Run `s2s verify` after each group and fix regressions before moving on
  5. Tick items in `PROGRESS.md` and commit after each group
- `PROGRESS.md` is a checklist generated from `modules.json`. It lets a new session pick up where the last one stopped when usage limits or context run out.

**Verify loop**

`s2s verify` builds the reconstructed project, serves it locally, screenshots the same pages and viewports as Stage 1, and diffs them against the baseline. It reports a per-page pixel difference plus console errors and missing requests. This gives the agent an objective "did I break it" signal instead of guessing.

**Why this split saves money**

Stages 1–4 are pure computation, so they cost nothing per run. The agent only sees deobfuscated first-party code, already stripped of vendor modules, which keeps both token use and session count low on a subscription.

## CLI

`s2s grab <url>` runs every stage end to end; each stage is also its own command, and all of them resume from the workspace's `manifest.json`.

| Command                              | Does                                                         |
| ------------------------------------ | ------------------------------------------------------------ |
| `s2s grab <url>`                     | All stages, then prints the next step (`cd <dir> && claude`) |
| `s2s capture <url>`                  | Stage 1 only                                                 |
| `s2s maps`                           | Stage 2 on an existing capture                               |
| `s2s detect`                         | Stage 3; writes `packages.json`                              |
| `s2s unbundle`                       | Stage 4; writes `recovered/unbundled/` and `modules.json`    |
| `s2s scaffold`                       | Stage 5; writes `project/` and the agent files               |
| `s2s verify`                         | Build, serve, screenshot diff against the baseline           |
| `s2s db pull` / `s2s db build <pkg>` | Download the fingerprint index / add packages to it          |
| `s2s ui`                             | Start the local GUI                                          |

**Main flags:** `--out <dir>`, `--pm pnpm|npm|yarn|bun`, `--install`, `--depth <n>`, `--pages <file>`, `--viewports desktop,mobile`, `--auth-state <file>`, `--framework <hint>`, `--from <stage>` (rerun from a stage), `--no-agent-files`.

**Config:** an optional `s2s.config.ts` in the working directory sets defaults (preferred package manager, rate limit, ignored origins, custom probe scripts). Running `s2s` with no arguments opens an interactive prompt flow for the same options.

## GUI

The GUI is a local web app (`s2s ui`, Vite + React) over the same `core` package, aimed at inspecting a capture rather than replacing the CLI.

- **New job:** URL input, the main flags as toggles, and a live log per stage
- **Capture view:** requests grouped by origin and type, with previews of HTML, JS, CSS and images
- **Packages view:** each detected package with version, confidence and evidence; accept, reject or override before scaffolding
- **Code view:** side-by-side diff of minified versus cleaned module, plus the module graph
- **Verify view:** baseline versus rebuilt screenshots with the diff overlay, per page and viewport
- **Handoff:** a button that copies `cd <workspace> && claude` and the prompt

A Tauri desktop wrapper can come later if a double-click app is worth it.

## Limits, legal and ethics

The output is a reconstruction of public frontend code, and the product should be positioned and defaulted as an analysis and learning tool.

- **What it can't recover:** server code, API logic, environment variables, comments, tests, git history, and code paths a public visitor never triggers (A/B variants, logged-in features).
- **Copyright:** reconstructed first-party code still belongs to the site owner. Studying it, or recovering your own lost source, is reasonable; republishing or reusing someone else's code is not.
- **Terms and load:** many sites forbid scraping in their terms. Keep the polite defaults (rate limit, `robots.txt`, honest user agent) and never add CAPTCHA or bot-protection bypass.
- **Output stays local:** no upload or sharing features in the tool itself.

I'm not a lawyer; if this becomes a public or paid product, get the positioning and terms reviewed.

## Roadmap

Ship the handoff early, because the agent can already do useful work on a raw capture; each later release makes its input cleaner. Durations are rough estimates for one developer.

1. **v0.1 Capture and handoff** (1–2 weeks): Stage 1, Stage 2, CDN/banner/runtime package signals, `package.json` with `--pm`, agent files. Exit: a source-mapped site comes out as a working project.
2. **v0.2 Unbundle and verify** (2–3 weeks): Stage 4 via webcrack and wakaru, CSS handling, `modules.json`, `PROGRESS.md`, `s2s verify`. Exit: Claude Code completes a full pass on a non-source-mapped site using only the generated files.
3. **v0.3 Fingerprint DB** (4–6 weeks): index builder, top \~1,000 packages, `s2s db pull/build`, scored matching. Exit: measured precision and recall on the test corpus.
4. **v0.4 GUI** (2–3 weeks): `s2s ui` with the five views above.
5. **v1.0 Framework recoverers** (ongoing): dedicated handling for Next.js, Remix/React Router, Astro, Nuxt and SvelteKit (route manifests, server/client splits), and growing the index toward 10,000 packages.

**Test corpus from day one.** Build a set of open-source sites whose real source is known, run `s2s` on their deployed builds, and score the result against the real repo: packages found, versions right, files and exports recovered, visual diff after the agent pass. Every stage change is judged against it.

https://claude.ai/artifact/LZeJQttSRxAbwfueZBYe4C#d709ed71-ff70.m9gkdx0k3vb.15569
