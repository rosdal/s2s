import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { readManifest, type StageState, writeManifest } from "../capture/manifest.js";
import { type WorkspacePaths, workspacePaths } from "../capture/workspace.js";
import {
  installProject,
  PACKAGE_MANAGERS,
  type PackageJson,
  type PackageManager,
} from "../detect/project.js";
import { writeFileAtomic, writeJsonAtomic } from "../fs-util.js";
import { WorkspaceError } from "../maps/run.js";
import type { ModulesFile } from "../unbundle/graph.js";
import { packageName } from "../unbundle/graph.js";
import { loadThresholds } from "../verify/config.js";
import {
  agentsMd,
  CLAUDE_MD,
  claudeSettings,
  progressMd,
  promptMd,
  slashCommandMd,
} from "./agent-files.js";
import { git, runScript } from "./exec.js";
import {
  type AgentFacts,
  DEFAULT_THRESHOLDS,
  type GroupFact,
  type StackFact,
  type Target,
  type Thresholds,
} from "./facts.js";
import { buildIndexHtml } from "./html.js";
import { hasJsx, relocateReferences } from "./relocate.js";
import {
  configTs,
  mainTs,
  runtimeShim,
  SHIM_HELPERS,
  scaffoldPackageJson,
  tsconfig,
  viteConfig,
  WORKSPACE_GITIGNORE,
} from "./templates.js";

export interface ScaffoldOptions {
  workspace: string;
  cwd?: string;
  force?: boolean;
  /** UI library for the Vite project; detected from the packages when left out. */
  target?: Target;
  /** Install dependencies (scripts disabled). Defaults to true. */
  install?: boolean;
  /** Build once after installing and record the result. Defaults to true. */
  build?: boolean;
  /** `git init` and commit `s2s scaffold`. Defaults to true. */
  git?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: ScaffoldProgress) => void;
}

export type ScaffoldProgress =
  | { kind: "start"; workspace: string }
  | { kind: "skip"; workspace: string; reason: string }
  | { kind: "warning"; message: string }
  | { kind: "step"; step: "files" | "install" | "build" | "git" }
  | { kind: "done"; status: StageState["status"]; summary: string };

export interface ScaffoldResult {
  workspace: string;
  status: StageState["status"];
  skipped: boolean;
  stats: Record<string, number>;
  warnings: string[];
  summary: string;
  target?: Target;
  /** `passed`, `failed` or `skipped`. */
  build?: string;
  /** First lines of a failed build's output. */
  buildOutput?: string;
  error?: string;
}

/** What `analysis/scaffold.json` records: the target, the entry, and where each module went. */
export interface ScaffoldFile {
  target: Target;
  fallbackFrom: string | null;
  page: string;
  entry: { styles: string[]; modules: string[]; runtime: boolean };
  removedFromHtml: string[];
  files: { module: string; original: string; file: string }[];
}

/** For example "react · 3 modules · build passed". */
export function summaryLine(target: string, stats: Record<string, number>, build: string): string {
  const n = stats.modules ?? 0;
  return `${target} · ${n} module${n === 1 ? "" : "s"} · build ${build}`;
}

const SSR_FRAMEWORKS: Record<string, string> = {
  next: "Next.js",
  nuxt: "Nuxt",
  astro: "Astro",
  "@sveltejs/kit": "SvelteKit",
  gatsby: "Gatsby",
  "@remix-run/react": "Remix",
};

interface PackagesFile {
  packageManager?: { name: string; source: string; version: string | null };
  packages: {
    name: string;
    version: string | null;
    confidence: string;
    status: string;
    dev?: boolean;
  }[];
}

interface ReviewFile {
  packages: { name: string; version: string | null; confidence: string; reason: string | null }[];
}

interface ReportFile {
  modules: { id: string; file: string; chunk: string; range: { start: number } }[];
  styles?: { file: string; url: string; kind: string; pages: string[] }[];
  exactSources?: { file: string; chunk: string; pages: string[] }[];
}

interface PageInfo {
  slug: string;
  url: string;
  finalUrl: string;
  tags: { tag: string; attributes: Record<string, string> }[];
}

/**
 * Stage 5a: turn the recovered modules into a Vite project that builds as is, wired so the
 * untouched scaffold behaves like the site, and write the files that hand the rest to an agent.
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const root = path.resolve(options.cwd ?? process.cwd(), options.workspace);
  const paths = workspacePaths(root);
  const progress = options.onProgress ?? (() => {});
  const manifest = await readManifest(paths.manifest).catch((error: Error) => {
    throw new WorkspaceError(`${paths.manifest} is unreadable: ${error.message.split("\n")[0]}`);
  });
  if (!manifest)
    throw new WorkspaceError(`No workspace at ${root}. Run "s2s capture <url>" first.`);
  if (manifest.stages.unbundle.status !== "complete")
    throw new WorkspaceError(
      `Unbundle in ${root} is ${manifest.stages.unbundle.status}. Run "s2s unbundle" before "s2s scaffold".`,
    );
  const previous = manifest.stages.scaffold;
  const sameTarget = !options.target || previous.details?.target === options.target;
  if (previous.status === "complete" && !options.force && sameTarget) {
    progress({ kind: "skip", workspace: root, reason: "scaffold is already complete" });
    const target = String(previous.details?.target ?? "vanilla");
    const build = String(previous.details?.build ?? "skipped");
    return {
      workspace: root,
      status: "complete",
      skipped: true,
      stats: previous.stats,
      warnings: previous.warnings,
      summary: summaryLine(target, previous.stats, build),
      target: target as Target,
      build,
    };
  }

  const startedAt = new Date();
  manifest.stages.scaffold = {
    status: "partial",
    startedAt: startedAt.toISOString(),
    stats: {},
    warnings: [],
  };
  await writeManifest(paths.manifest, manifest);
  progress({ kind: "start", workspace: root });
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (warnings.includes(message)) return;
    warnings.push(message);
    progress({ kind: "warning", message });
  };

  let status: StageState["status"] = "failed";
  let error: string | undefined;
  let outcome: Outcome | undefined;
  try {
    outcome = await run(paths, manifest.targetUrl, options, warn, progress);
    status = "complete";
  } catch (caught) {
    if (options.signal?.aborted) {
      status = "partial";
      error = "Interrupted";
    } else {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  const stats = outcome?.stats ?? {};
  manifest.stages.scaffold = {
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    stats,
    warnings,
    ...(outcome
      ? {
          details: {
            target: outcome.target,
            fallbackFrom: outcome.fallbackFrom,
            install: outcome.install,
            build: outcome.build,
            lockfile: outcome.lockfile,
          },
        }
      : {}),
    ...(error ? { error } : {}),
  };
  await writeManifest(paths.manifest, manifest);
  // The manifest changed after the commit; fold it in so the tree starts clean.
  if (outcome?.committed)
    await git(["commit", "-q", "--amend", "--no-edit", "-a"], root, outcome.fallbackIdentity);
  const summary = summaryLine(outcome?.target ?? "unknown", stats, outcome?.build ?? "skipped");
  progress({ kind: "done", status, summary });
  return {
    workspace: root,
    status,
    skipped: false,
    stats,
    warnings,
    summary,
    ...(outcome ? { target: outcome.target, build: outcome.build } : {}),
    ...(outcome?.buildOutput ? { buildOutput: outcome.buildOutput } : {}),
    ...(error ? { error } : {}),
  };
}

interface Outcome {
  target: Target;
  fallbackFrom: string | null;
  stats: Record<string, number>;
  install: string;
  build: string;
  buildOutput?: string;
  lockfile: string | null;
  committed: boolean;
  fallbackIdentity: boolean;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const posix = (p: string) => p.split(path.sep).join("/");

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

/** The project path a workspace file moves to (both workspace-relative, posix). */
function projectPath(file: string, jsx: boolean): string {
  let rel: string;
  if (file.startsWith("recovered/unbundled/"))
    rel = `project/src/_recovered/${file.slice("recovered/unbundled/".length)}`;
  else if (file.startsWith("recovered/sourcemap/"))
    rel = `project/src/_recovered/_sourcemap/${file.slice("recovered/sourcemap/".length)}`;
  else if (file.startsWith("assets/")) rel = `project/src/${file}`;
  else rel = `project/src/_recovered/_other/${file}`;
  return jsx ? rel.replace(/\.js$/, ".jsx") : rel;
}

export function chooseTarget(packages: PackagesFile["packages"]): {
  target: Target;
  fallbackFrom: string | null;
} {
  const accepted = new Set(
    packages
      .filter((p) => p.status === "dependency" || p.status === "devDependency")
      .map((p) => p.name),
  );
  const fallback = Object.entries(SSR_FRAMEWORKS).find(([name]) => accepted.has(name));
  const target: Target =
    accepted.has("react") || accepted.has("react-dom")
      ? "react"
      : accepted.has("preact")
        ? "preact"
        : accepted.has("vue")
          ? "vue"
          : "vanilla";
  return { target, fallbackFrom: fallback?.[1] ?? null };
}

async function readPages(paths: WorkspacePaths): Promise<PageInfo[]> {
  const slugs = existsSync(paths.pages) ? (await readdir(paths.pages)).sort() : [];
  const pages: PageInfo[] = [];
  for (const slug of slugs) {
    const page = await readJson<Omit<PageInfo, "slug">>(path.join(paths.pages, slug, "page.json"));
    if (page) pages.push({ slug, url: page.url, finalUrl: page.finalUrl, tags: page.tags ?? [] });
  }
  return pages;
}

async function run(
  paths: WorkspacePaths,
  targetUrl: string,
  options: ScaffoldOptions,
  warn: (message: string) => void,
  progress: (event: ScaffoldProgress) => void,
): Promise<Outcome> {
  const signal = options.signal;
  const graph = await readJson<ModulesFile>(paths.modules);
  if (!graph) throw new Error('analysis/modules.json is missing; run "s2s unbundle" again.');
  const report = (await readJson<ReportFile>(paths.unbundleReport)) ?? { modules: [] };
  const packagesFile = (await readJson<PackagesFile>(
    path.join(paths.analysis, "packages.json"),
  )) ?? { packages: [] };
  const reviewFile = (await readJson<ReviewFile>(
    path.join(paths.analysis, "packages-review.json"),
  )) ?? { packages: [] };
  const pkg = await readJson<PackageJson>(paths.packageJson);
  if (!pkg) throw new Error('project/package.json is missing; run "s2s detect" again.');

  const chosen = chooseTarget(packagesFile.packages);
  const target = options.target ?? chosen.target;
  const fallbackFrom = chosen.fallbackFrom;
  if (fallbackFrom)
    warn(
      `The site was built with ${fallbackFrom}; the scaffold is a Vite SPA built from the hydrated DOM.`,
    );
  const pmName = packagesFile.packageManager?.name;
  const pm: PackageManager = (PACKAGE_MANAGERS as readonly string[]).includes(pmName ?? "")
    ? (pmName as PackageManager)
    : "npm";

  // 1. Clear what an earlier scaffold wrote, keeping node_modules so a rerun installs fast.
  progress({ kind: "step", step: "files" });
  for (const p of ["src", "dist", "index.html", "vite.config.ts", "tsconfig.json"])
    await rm(path.join(paths.project, p), { recursive: true, force: true });

  // 2. Plan where every file goes, then copy with references re-pointed.
  const sources: string[] = [];
  for (const m of graph.modules) sources.push(m.file);
  // Exact sources the graph doesn't list (their CSS, JSON, images) are still imported by the ones
  // it does. Bundler internals and node_modules copies stay out.
  const listed = new Set(sources.map((s) => s.toLowerCase()));
  for (const file of await listFiles(paths.recoveredSourcemap)) {
    const rel = posix(path.relative(paths.root, file));
    const inner = rel.slice("recovered/sourcemap/".length);
    if (/^_(?:vendor|virtual)\//.test(inner) || listed.has(rel.toLowerCase())) continue;
    sources.push(rel);
    listed.add(rel.toLowerCase());
  }
  for (const file of await listFiles(paths.assets))
    sources.push(posix(path.relative(paths.root, file)));
  const texts = new Map<string, string>();
  const moves = new Map<string, string>();
  for (const file of sources) {
    const text = /\.(?:m?jsx?|cjs|tsx?|vue|svelte|css|scss|sass|less)$/i.test(file)
      ? await readFile(path.join(paths.root, file), "utf8").catch(() => undefined)
      : undefined;
    if (text !== undefined) texts.set(file, text);
    const jsx = /\.js$/i.test(file) && text !== undefined && hasJsx(text);
    moves.set(file.toLowerCase(), projectPath(file, jsx));
  }
  let notes = 0;
  const requirePackages = new Set<string>();
  const requireHelpers = new Set<string>();
  for (const file of sources) {
    signal?.throwIfAborted();
    const next = moves.get(file.toLowerCase()) as string;
    const out = path.join(paths.root, next);
    await mkdir(path.dirname(out), { recursive: true });
    const text = texts.get(file);
    if (text === undefined) {
      await copyFile(path.join(paths.root, file), out);
      continue;
    }
    const relocated = relocateReferences(text, file, next, moves);
    notes += relocated.match(/\/\/ s2s:/g)?.length ?? 0;
    if (/\.(?:m?jsx?|cjs)$/.test(next)) {
      for (const m of relocated.matchAll(/(?<![\w$.])require\s*\(\s*["']([^"'./][^"']*)["']\s*\)/g))
        requirePackages.add(m[1] as string);
      for (const m of relocated.matchAll(/(?<![\w$.])require\.(\w+)\b/g))
        requireHelpers.add(m[1] as string);
      if (/(?<![\w$.])require\s*\(\s*["']\./.test(relocated))
        warn(`${next}: requires a local file with require(); convert it to an import.`);
    }
    await writeFileAtomic(out, relocated);
  }

  // 3. The entry: what the first page's own scripts and stylesheets ran, in document order.
  const pages = await readPages(paths);
  const page =
    pages.find((p) => p.url === targetUrl || p.finalUrl === targetUrl) ?? pages[0] ?? null;
  const pageUrl = page?.finalUrl ?? targetUrl;
  const abs = (href: string) => {
    try {
      return new URL(href, pageUrl).href.replace(/#.*$/, "");
    } catch {
      return href;
    }
  };
  const scripts = (page?.tags ?? [])
    .filter((t) => t.tag === "script" && t.attributes.src)
    .map((t) => abs(t.attributes.src as string));
  const links = (page?.tags ?? [])
    .filter(
      (t) =>
        t.tag === "link" && /\bstylesheet\b/i.test(t.attributes.rel ?? "") && t.attributes.href,
    )
    .map((t) => abs(t.attributes.href as string));
  const sheets = (report.styles ?? []).filter((s) => s.kind === "sheet");
  const styles = links
    .map((url) => sheets.find((s) => s.url === url))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => s.file);

  const chunkOf = new Map<string, string>();
  for (const m of report.modules) chunkOf.set(m.file, m.chunk);
  for (const e of report.exactSources ?? []) chunkOf.set(e.file, e.chunk);
  const startOf = new Map(report.modules.map((m) => [m.file, m.range.start]));
  const importedBy = new Set(graph.modules.flatMap((m) => m.imports));
  const dynamicTargets = new Set(graph.modules.flatMap((m) => m.dynamicImports));
  const code = graph.modules.filter((m) => m.kind !== "style");
  // Per script, in document order: the chunk's modules nothing imports. When every module in a
  // chunk is imported (they import each other), the one that ends the chunk: importing it runs
  // its dependencies first, which is the order the chunk ran them.
  const byStart = (a: (typeof code)[number], b: (typeof code)[number]) =>
    (startOf.get(a.file) ?? 0) - (startOf.get(b.file) ?? 0) || a.file.localeCompare(b.file);
  let entryModules: typeof code = [];
  for (const script of scripts) {
    const inChunk = code.filter((m) => chunkOf.get(m.file) === script).sort(byStart);
    if (inChunk.length === 0) continue;
    const roots = inChunk.filter((m) => !importedBy.has(m.id));
    entryModules.push(...(roots.length > 0 ? roots : [inChunk.at(-1) as (typeof code)[number]]));
  }
  if (entryModules.length === 0 && code.length > 0) {
    entryModules = code.filter((m) => !importedBy.has(m.id) && !dynamicTargets.has(m.id));
    warn(
      "No recovered module belongs to a script the page loads; the entry imports every module nothing else imports.",
    );
  }
  const fromMain = (file: string) => {
    const moved = moves.get(file.toLowerCase()) ?? file;
    return `./${moved.slice("project/src/".length)}`;
  };
  const runtimePackages = [...requirePackages]
    .filter((name) => {
      const base = packageName(name);
      const ok = base in (pkg.dependencies ?? {}) || base in (pkg.devDependencies ?? {});
      if (!ok) warn(`Recovered code calls require("${name}"), which is not in package.json.`);
      return ok;
    })
    .sort();
  for (const helper of [...requireHelpers].sort())
    if (!SHIM_HELPERS.includes(helper))
      warn(
        `Recovered code calls the webpack helper require.${helper}, which the runtime shim does not provide.`,
      );
  const runtime = runtimePackages.length > 0 || requireHelpers.size > 0;
  if (runtime) {
    await writeFileAtomic(
      path.join(paths.project, "src", "_s2s", "runtime.ts"),
      runtimeShim(runtimePackages, [...requireHelpers].sort()),
    );
  }
  const mainStyles = styles.map(fromMain);
  const mainModules = entryModules.map((m) => fromMain(m.file));
  await writeFileAtomic(
    path.join(paths.project, "src", "main.ts"),
    mainTs({ runtime, styles: mainStyles, modules: mainModules }),
  );

  // 4. index.html from the captured page; an SSR site's hydrated DOM instead of its server HTML.
  let removedFromHtml: string[] = [];
  if (page) {
    const dir = path.join(paths.pages, page.slug);
    const ssr = await readFile(path.join(dir, "ssr.html"), "utf8").catch(() => undefined);
    const dom = await readFile(path.join(dir, "dom.html"), "utf8").catch(() => undefined);
    const source = fallbackFrom ? (dom ?? ssr) : (ssr ?? dom);
    // Every first-party JS chunk (a webpack runtime chunk has no modules but still goes).
    const bundlerFile = await readJson<{ chunks: { url: string }[] }>(paths.bundlerReport);
    const replaced = new Set<string>([
      ...(bundlerFile?.chunks ?? []).map((c) => c.url),
      ...report.modules.map((m) => m.chunk),
      ...(report.exactSources ?? []).map((e) => e.chunk),
      ...sheets.map((s) => s.url),
    ]);
    const built = buildIndexHtml({
      html: source ?? "<!doctype html>\n<html>\n<body>\n</body>\n</html>\n",
      pageUrl,
      replaced,
      dropInlineScripts: fallbackFrom !== null,
      entry: "/src/main.ts",
    });
    removedFromHtml = built.removed;
    await writeFileAtomic(path.join(paths.project, "index.html"), built.html);
  } else {
    warn("No page snapshot was captured; index.html is a blank page.");
    await writeFileAtomic(
      path.join(paths.project, "index.html"),
      '<!doctype html>\n<html>\n  <body>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n',
    );
  }

  // 5. Project config.
  await writeFileAtomic(path.join(paths.project, "vite.config.ts"), viteConfig(target));
  await writeFileAtomic(path.join(paths.project, "tsconfig.json"), tsconfig(target));
  // Inferred versions often disagree on peers; every npm install in the project, the agent's
  // included, should get past that the way the scaffold's own install does.
  if (pm === "npm")
    await writeFileAtomic(path.join(paths.project, ".npmrc"), "legacy-peer-deps=true\n");
  addMissingImports(pkg, graph, packagesFile, warn);
  await writeJsonAtomic(paths.packageJson, scaffoldPackageJson(pkg, target));

  // 6. Agent files and the analysis record of where everything went.
  const files = graph.modules.map((m) => ({
    module: m.id,
    original: m.file,
    file: (moves.get(m.file.toLowerCase()) ?? m.file).replace(/^project\//, ""),
  }));
  const scaffoldFile: ScaffoldFile = {
    target,
    fallbackFrom,
    page: page?.slug ?? "",
    entry: { styles: mainStyles, modules: mainModules, runtime },
    removedFromHtml,
    files,
  };
  await writeJsonAtomic(path.join(paths.analysis, "scaffold.json"), scaffoldFile);
  if (!existsSync(paths.config)) await writeFileAtomic(paths.config, configTs());
  const thresholds = await loadThresholds(paths.config).catch((e: Error) => {
    warn(`${e.message}; AGENTS.md lists the default thresholds.`);
    return DEFAULT_THRESHOLDS;
  });
  const facts = await gatherFacts(paths, targetUrl, {
    thresholds,
    target,
    fallbackFrom,
    pm,
    graph,
    packagesFile,
    reviewFile,
    pages,
    moves,
    notes,
  });
  await writeAgentFiles(paths, facts);
  await writeFileAtomic(paths.gitignore, WORKSPACE_GITIGNORE);

  // 7. Install and build once.
  let install = "skipped";
  let lockfile: string | null = null;
  let build = "skipped";
  let buildOutput: string | undefined;
  if (options.install !== false) {
    signal?.throwIfAborted();
    progress({ kind: "step", step: "install" });
    const result = await installProject(
      paths.project,
      { name: pm, version: packagesFile.packageManager?.version ?? undefined },
      signal,
    );
    lockfile = result.lockfile;
    install = result.exitCode === 0 ? "passed" : "failed";
    await writeFileAtomic(path.join(paths.analysis, "scaffold-install.log"), result.output);
    if (result.exitCode !== 0)
      warn(`${pm} install exited with ${result.exitCode}; see analysis/scaffold-install.log.`);
  }
  if (options.build !== false && install !== "failed") {
    signal?.throwIfAborted();
    progress({ kind: "step", step: "build" });
    const result = await runScript(paths.project, pm, "build", signal);
    build = result.exitCode === 0 ? "passed" : "failed";
    await writeFileAtomic(path.join(paths.analysis, "scaffold-build.log"), result.output);
    if (result.exitCode !== 0) {
      buildOutput = result.output.split("\n").slice(0, 50).join("\n");
      warn("The untouched scaffold does not build; see analysis/scaffold-build.log.");
    }
  }

  // A Ctrl+C reaches the child process, which then just exits non-zero; stop here, partial.
  signal?.throwIfAborted();

  // 8. Git: a repo at the workspace root with everything but bodies and build output.
  let committed = false;
  let fallbackIdentity = false;
  if (options.git !== false) {
    progress({ kind: "step", step: "git" });
    const fresh = !existsSync(path.join(paths.root, ".git"));
    const init = fresh ? await git(["init", "-q"], paths.root) : { exitCode: 0, output: "" };
    if (init.exitCode !== 0) {
      warn(`git init failed: ${init.output.trim().split("\n")[0] ?? ""}`);
    } else {
      const email = await git(["config", "user.email"], paths.root);
      fallbackIdentity = email.exitCode !== 0 || email.output.trim() === "";
      await git(["add", "-A"], paths.root);
      const message = fresh ? "s2s scaffold" : "s2s scaffold (regenerated)";
      const commit = await git(["commit", "-q", "-m", message], paths.root, fallbackIdentity);
      committed = commit.exitCode === 0;
      if (!committed && fresh)
        warn(`git commit failed: ${commit.output.trim().split("\n")[0] ?? ""}`);
    }
  }

  return {
    target,
    fallbackFrom,
    install,
    build,
    lockfile,
    committed,
    fallbackIdentity,
    ...(buildOutput ? { buildOutput } : {}),
    stats: {
      modules: code.length,
      styles: graph.modules.length - code.length,
      assets: sources.filter((s) => s.startsWith("assets/")).length,
      groups: graph.groups.length,
      entryModules: mainModules.length,
      notes,
    },
  };
}

/**
 * The version spec for a missing package that Stage 3 only saw as its companion. From React
 * Router 7 on, react-router-dom is a thin re-export of react-router that stopped tracking its
 * versions, so it becomes an npm alias of the react-router actually found.
 */
function companionSpec(name: string, deps: Record<string, string>, packagesFile: PackagesFile) {
  if (name !== "react-router-dom") return undefined;
  const version =
    deps["react-router"] ?? packagesFile.packages.find((p) => p.name === "react-router")?.version;
  if (!version) return undefined;
  const major = Number.parseInt(version.replace(/^[^\d]*/, ""), 10);
  return major >= 7 ? "npm:react-router@" + version : version;
}

/**
 * Add packages the recovered code imports that `package.json` lacks, so the untouched scaffold
 * builds. The version comes from Stage 3 when it saw the package (any status), else from a
 * companion package, else `latest`; each one is a warning for the agent to confirm.
 */
export function addMissingImports(
  pkg: PackageJson,
  graph: ModulesFile,
  packagesFile: PackagesFile,
  warn: (message: string) => void,
): void {
  const deps = { ...(pkg.dependencies ?? {}) };
  const known = (name: string) => name in deps || name in (pkg.devDependencies ?? {});
  const imported = new Set(graph.modules.flatMap((m) => m.packageImports));
  for (const name of [...imported].sort()) {
    if (known(name) || name.startsWith("node:")) continue;
    const seen = packagesFile.packages.find((p) => p.name === name);
    const version = seen?.version ?? companionSpec(name, deps, packagesFile) ?? "latest";
    deps[name] = version;
    warn(
      "Recovered code imports " +
        name +
        ", which package.json lacked; added " +
        name +
        "@" +
        version +
        ". Confirm it.",
    );
  }
  pkg.dependencies = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function writeAgentFiles(paths: WorkspacePaths, facts: AgentFacts): Promise<void> {
  await writeFileAtomic(paths.agents, agentsMd(facts));
  await writeFileAtomic(paths.claude, CLAUDE_MD);
  await writeFileAtomic(paths.prompt, promptMd(facts));
  // PROGRESS.md is the agent's own record once work starts; a rerun only writes it if missing.
  if (!existsSync(paths.progress)) await writeFileAtomic(paths.progress, progressMd(facts));
  await writeFileAtomic(
    path.join(paths.root, ".claude", "commands", "s2s.md"),
    slashCommandMd(facts),
  );
  await writeFileAtomic(path.join(paths.root, ".claude", "settings.json"), claudeSettings(facts));
}

const CONFIDENCE_WORD = (n: number) => (n >= 0.8 ? "high" : n >= 0.5 ? "medium" : "low");

async function gatherFacts(
  paths: WorkspacePaths,
  site: string,
  input: {
    thresholds: Thresholds;
    target: Target;
    fallbackFrom: string | null;
    pm: PackageManager;
    graph: ModulesFile;
    packagesFile: PackagesFile;
    reviewFile: ReviewFile;
    pages: PageInfo[];
    moves: Map<string, string>;
    notes: number;
  },
): Promise<AgentFacts> {
  const { graph, packagesFile } = input;
  const hints = await readJson<{
    language: { value: string; confidence: number } | null;
    styling: { value: string; confidence: number }[];
  }>(paths.projectHints);
  const styling = await readJson<Record<string, { detected?: boolean }>>(paths.stylingReport);
  const bundler = await readJson<{ bundler: string; version: string | null; confidence: string }>(
    paths.bundlerReport,
  );
  const manifest = await readManifest(paths.manifest);

  const stack: StackFact[] = [];
  const lib = { react: "react", vue: "vue", preact: "preact" }[
    input.target as "react" | "vue" | "preact"
  ];
  const libPkg = lib ? packagesFile.packages.find((p) => p.name === lib) : undefined;
  stack.push({
    label: "UI library",
    value: libPkg ? `${libPkg.name}${libPkg.version ? ` ${libPkg.version}` : ""}` : "none detected",
    confidence: libPkg ? `${libPkg.confidence} confidence` : "no evidence",
    source: "analysis/packages.json",
  });
  if (input.fallbackFrom)
    stack.push({
      label: "Framework",
      value: input.fallbackFrom,
      confidence: "detected",
      source: "analysis/packages.json",
    });
  stack.push(
    hints?.language
      ? {
          label: "Language",
          value: hints.language.value,
          confidence: `${CONFIDENCE_WORD(hints.language.confidence)} confidence`,
          source: "analysis/project-hints.json",
        }
      : {
          label: "Language",
          value: "unknown (no source maps); write TypeScript",
          confidence: "no evidence",
          source: "analysis/project-hints.json",
        },
  );
  const styleNames = [
    ...Object.entries(styling ?? {})
      .filter(([, v]) => v?.detected)
      .map(([k]) => k),
    ...(hints?.styling ?? []).map((s) => s.value),
  ];
  stack.push({
    label: "Styling",
    value: styleNames.length > 0 ? [...new Set(styleNames)].sort().join(", ") : "plain CSS",
    confidence: styleNames.length > 0 ? "detected" : "nothing else detected",
    source: "analysis/styling.json",
  });
  stack.push({
    label: "Original bundler",
    value: bundler
      ? `${bundler.bundler}${bundler.version ? ` ${bundler.version}` : ""}`
      : "unknown",
    confidence: bundler ? `${bundler.confidence} confidence` : "no evidence",
    source: "analysis/bundler.json",
  });
  stack.push({
    label: "Package manager",
    value: input.pm,
    confidence: packagesFile.packageManager?.source ?? "default",
    source: "analysis/packages.json",
  });

  const count = (origin: string) => graph.modules.filter((m) => m.origin === origin).length;
  const byId = new Map(graph.modules.map((m) => [m.id, m]));
  const groups: GroupFact[] = graph.groups
    .map((g) => ({
      id: g.id,
      bytes: g.bytes,
      modules: g.modules
        .map((id) => byId.get(id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined && m.kind !== "style")
        .map((m) => ({
          file: input.moves.get(m.file.toLowerCase()) ?? m.file,
          original: m.file,
          kind: m.kind,
          origin: m.origin,
        })),
    }))
    .filter((g) => g.modules.length > 0);
  const viewports = Array.isArray(manifest?.options.viewports)
    ? (manifest.options.viewports as string[])
    : ["desktop"];
  return {
    site,
    pages: input.pages.map((p) => ({ slug: p.slug, url: p.url })),
    viewports,
    target: input.target,
    fallbackFrom: input.fallbackFrom,
    stack,
    packageManager: input.pm,
    packages: packagesFile.packages
      .filter((p) => p.status === "dependency" || p.status === "devDependency")
      .map((p) => ({
        name: p.name,
        version: p.version,
        confidence: p.confidence,
        dev: p.status === "devDependency",
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    review: input.reviewFile.packages
      .map((p) => ({
        name: p.name,
        version: p.version,
        confidence: p.confidence,
        reason: p.reason,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    modules: {
      total: graph.modules.filter((m) => m.kind !== "style").length,
      exact: count("sourcemap-exact"),
      renamed: count("renamed"),
      unbundled: count("unbundled"),
      obfuscated: graph.modules.filter((m) => m.obfuscated).length,
      styles: graph.modules.filter((m) => m.kind === "style").length,
    },
    groups,
    notes: input.notes,
    thresholds: input.thresholds,
  };
}
