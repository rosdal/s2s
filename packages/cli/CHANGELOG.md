# @rosdal/s2s

## 0.3.0

### Minor Changes

- 22f3f7d: Recover three.js sites. Capture records scene snapshots, screenshots and shaders at frozen keyframes; the scaffold writes models, textures and sounds as proxies (`--assets proxy`, the default), simplified clones or the originals, with an `ASSETS.md` swap guide and shaders as `.glsl` files; verify compares the rebuilt scene graph at every keyframe. Library code a bundle inlined is now named after install, so the untouched scaffold of a scope-hoisted bundle runs.

### Patch Changes

- 0258325: Show a real `s2s grab` run against excalidraw.com in the README and link the new project page.

## 0.2.1

### Patch Changes

- 588c88a: Detection no longer guesses a version whose peer ranges reject the peers the site really has: `jotai-scope` steps back from 0.12.2 to 0.8.3 when the bundle pins `jotai` 2.11.0, so a pnpm scaffold of Excalidraw installs and builds. A failed build now shows the lines that report the failure instead of the first 50 lines of output.
- 588c88a: The live stage list no longer flashes or freezes. Each frame is repainted in one write instead of clearing the block first, the cursor is hidden while it draws, and unbundle and maps give the spinner a turn between bundles, with unbundle showing how many chunks it has split.

## 0.2.0

### Minor Changes

- 3e44311: Redesign the terminal output: a live stage list with timings on a terminal, a "Reconstruction ready" summary after `s2s grab`, a framed error that says where a rerun resumes, a results table for `s2s verify`, colored package tables and evidence for `s2s detect`, and a shorter guided prompt. Colors follow NO_COLOR and FORCE_COLOR; CI and pipes get plain lines.

### Patch Changes

- 746ce8a: Monorepo sites like Excalidraw now build untouched: `s2s grab https://excalidraw.com/` produces a scaffold that builds and passes the baseline verify.
  - Source maps keep their folder depth: a file whose sources climb out of a deeper folder no longer loses that folder, and its real name is read from imports that need it.
  - The scaffold rebuilds barrel `index.ts` files that compiled to no code, writes empty stand-ins for stylesheets no map held, and aliases the site's own workspace packages (`@excalidraw/element`) to their recovered folders instead of installing them from npm.
  - Maps rebuild data the bundle inlined without mappings (JSON imports such as locale files, and namespaces of tree-shaken modules) from the binding the importer's map points at, and write captured bytes in place of the placeholder Vite keeps for each asset.
  - The scaffold points imports of a lazy chunk that came without a map (`./firebaseSDK`) at the unbundler's split parts, and aliases plugin virtual modules (`virtual:pwa-register`) to the code their map kept.
  - Capture keeps a DOM snapshot per viewport, and verify compares each viewport with its own, so a responsive app's mobile layout no longer fails against the desktop DOM.
  - Detection adds `sass` when code imports `.scss` files, reads React's `use-sync-external-store-shim/with-selector` banner as one package, and no longer guesses a parent version newer than a dependency the bundle still contains.
  - Build logs drop colour codes, plain-log capture lines show each phase's own totals, and the unbundle summary counts the same modules the scaffold does.
- 746ce8a: Add a README to the npm package.

## 0.1.1

### Patch Changes

- 66f0110: Fix four ways the untouched scaffold could fail to build or run, found on TodoMVC. The scaffold now copies every exact source, including CSS that the source-mapped code imports. It adds packages the recovered code imports but `package.json` lacked, such as `react-router-dom` (as an alias of `react-router` 7 and later), with a warning to confirm each one. npm installs no longer stop on peer-version conflicts between inferred versions. Stage 4 also keeps a constructor function that guards with `this instanceof` as a function, because turning it into a class broke callers that omit `new`.
- e7e8a36: The scaffold now adds `@types/react` and `@types/react-dom` for React projects, matching the site's React major, so the agent's strict TSX typechecks without a new dependency. npm projects also get a `.npmrc` with `legacy-peer-deps=true`, so the agent's own installs get past the same peer conflicts the scaffold's install does. Both came out of the first acceptance run, on TodoMVC.

## 0.1.0

### Minor Changes

- cadeb53: Add `s2s capture <url>`: Stage 1 records every request a site makes at desktop and mobile viewports, saves server-rendered and hydrated HTML, triggers lazily loaded code, fetches JS and CSS chunks the page never loaded, collects source maps, reads CDN package versions, probes runtime framework facts and takes baseline screenshots into a resumable workspace.
- 1581ecc: Add `s2s detect` (Stage 3). It merges every cheap package signal in a capture (CDN URLs, source-map paths, license banners, webpack `.LICENSE.txt` files, version strings matched against signature files, runtime versions and framework markers) into one scored list in `analysis/packages.json`, with the evidence behind each match. Candidates are checked against the npm registry; a name that only the site's own text gives must exist and pass a popularity floor, or it goes to `analysis/packages-review.json`. It writes `project/package.json` with exact pins, marks vendor byte ranges per bundle in `analysis/vendor-ranges.json`, and with `--install` runs pnpm, npm, yarn or bun with install scripts disabled. `--explain <pkg>` prints the evidence for one package, and `--offline` skips only the registry checks. Capture now also fetches the `*.LICENSE.txt` files webpack bundles point at.
- 9db02f6: Add `s2s maps` (Stage 2). It reads the source maps in a capture and writes the original sources to `recovered/sourcemap/`, with bundler internals under `_virtual/` and `node_modules` sources under `_vendor/`. Minified chunks whose maps carry names but no sources get their bindings renamed, scope-safely, into `recovered/renamed/`. It also writes package evidence with exact versions from pnpm and Yarn paths, project hints (language, framework, styling, path aliases, package manager), file boundaries for later unbundling, and a coverage report of how much first-party JS and CSS is now explained.
- 22296e2: Add `s2s grab`, `s2s scaffold` and `s2s verify` (Stage 5). `grab <url>` runs every stage in order and resumes after an interruption, then checks the untouched project and prints the command that hands it to Claude Code. Run `s2s` with no arguments for a guided prompt. `scaffold` writes a Vite project (React, Vue, Preact or vanilla; `--target` to choose) that builds and behaves like the site before any change. It also writes `AGENTS.md`, `PROMPT.md`, `PROGRESS.md`, a `/s2s` slash command, a narrow Claude Code allowlist, and a git repo with a first commit. `verify` builds the project and serves it with captured responses replayed, without contacting the site. It compares each page and viewport with the capture on pixels (regions that changed during capture are masked), DOM similarity, new console errors and failed requests. It writes `verify/report.md` for the agent and exits 0 on a pass, 1 on a regression, 2 when the build fails and 3 when verify cannot run. Capture now takes a second screenshot per page (`--mask-delay`) and records console errors. Stage 4 no longer turns non-React `createElement` calls into JSX, and a `react-dom` vendor import now includes `react-dom/client`.
- 2a5d526: Add `s2s unbundle` (Stage 4). It splits the site's first-party JS into one readable module per file under `recovered/unbundled/<chunk>/`: webpack 4 and 5 on their real module maps (merged across chunks), Browserify on its module table, esbuild and Rolldown on their CommonJS/ESM wrappers, and Vite/Rollup chunks on partial source-map boundaries or, failing that, clusters of the reference graph. Code inside Stage 3's vendor ranges is replaced with package imports. Each module then goes through deobfuscation (webcrack, with obfuscator code run in a locked-down child process), unminify, de-transpile (classes, async/await, spread, optional chaining and more, including Babel helpers a minifier inlined), JSX restore, CommonJS-to-ESM and Prettier; `--skip <pass>` turns any of them off. First-party CSS is formatted into `styles/`, CSS Module class maps become `import styles from "./X.module.css"` with local class names restored, and images, fonts and media are copied into `assets/` with their references rewritten. It writes `analysis/modules.json` (module graph, kind guesses, work order and agent groups), `bundler.json`, `styling.json` and `unbundle-report.json`, and adds the bundler to `project/package.json`. Output is deterministic; `--keep-vendor`, `--no-heuristic-split` and `--max-group-kb` tune it.
