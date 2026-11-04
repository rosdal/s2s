import { createHash } from "node:crypto";
import path from "node:path";

const MAX_SLUG = 80;

function slugPart(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function capSlug(slug: string, seed: string): string {
  if (slug.length <= MAX_SLUG) return slug;
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `${slug.slice(0, MAX_SLUG - 9).replace(/-+$/, "")}-${hash}`;
}

/** Workspace folder name for a target URL: host (minus `www.`) plus path, e.g. `shopify-com-editions-winter2026`. */
export function workspaceSlug(target: string | URL): string {
  const url = new URL(target);
  const host = url.hostname.replace(/^www\./, "");
  const port = url.port ? `-${url.port}` : "";
  const slug = slugPart(`${host}${port} ${url.pathname}`) || "site";
  return capSlug(slug, url.href);
}

/** Folder name for one captured page inside `raw/pages/`; the site root is `index`. */
export function pageSlug(target: string | URL): string {
  const url = new URL(target);
  let slug = slugPart(url.pathname) || "index";
  if (url.search) {
    const hash = createHash("sha256").update(url.search).digest("hex").slice(0, 8);
    slug = `${slug}-q${hash}`;
  }
  return capSlug(slug, url.href);
}

export interface WorkspacePaths {
  root: string;
  manifest: string;
  raw: string;
  requests: string;
  bodies: string;
  maps: string;
  pages: string;
  screenshots: string;
  runtime: string;
  cdnPackages: string;
  discovery: string;
  har: string;
  recovered: string;
  /** Exact sources from source maps, plus `_virtual/` and `_vendor/`. */
  recoveredSourcemap: string;
  /** Minified chunks renamed from partial maps, as `<body-hash>.js`. */
  renamed: string;
  analysis: string;
  sourcemapsReport: string;
  sourcemapBoundaries: string;
  projectHints: string;
  evidence: string;
  sourcemapPackages: string;
  /** Stage 4: one file per first-party module, plus `styles/`. */
  unbundled: string;
  /** Images, fonts and media copied from the capture under readable names. */
  assets: string;
  bundlerReport: string;
  stylingReport: string;
  modules: string;
  unbundleReport: string;
  project: string;
  packageJson: string;
  /** Stage 5: recovered modules inside the project, shrinking as the agent works. */
  projectRecovered: string;
  agents: string;
  claude: string;
  prompt: string;
  progress: string;
  config: string;
  gitignore: string;
  verify: string;
  verifyReport: string;
  verifyReportMd: string;
  verifyDiffs: string;
  verifyHistory: string;
  /** Screenshots accepted with `s2s verify --update-baseline`; they win over the capture's. */
  verifyBaseline: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  const abs = path.resolve(root);
  const raw = path.join(abs, "raw");
  const recovered = path.join(abs, "recovered");
  const analysis = path.join(abs, "analysis");
  const evidence = path.join(analysis, "evidence");
  return {
    root: abs,
    manifest: path.join(abs, "manifest.json"),
    raw,
    requests: path.join(raw, "requests.jsonl"),
    bodies: path.join(raw, "bodies"),
    maps: path.join(raw, "maps"),
    pages: path.join(raw, "pages"),
    screenshots: path.join(raw, "screenshots"),
    runtime: path.join(raw, "runtime.json"),
    cdnPackages: path.join(raw, "cdn-packages.json"),
    discovery: path.join(raw, "discovery.json"),
    har: path.join(raw, "capture.har"),
    recovered,
    recoveredSourcemap: path.join(recovered, "sourcemap"),
    renamed: path.join(recovered, "renamed"),
    analysis,
    sourcemapsReport: path.join(analysis, "sourcemaps.json"),
    sourcemapBoundaries: path.join(analysis, "sourcemap-boundaries.json"),
    projectHints: path.join(analysis, "project-hints.json"),
    evidence,
    sourcemapPackages: path.join(evidence, "sourcemap-packages.json"),
    unbundled: path.join(recovered, "unbundled"),
    assets: path.join(abs, "assets"),
    bundlerReport: path.join(analysis, "bundler.json"),
    stylingReport: path.join(analysis, "styling.json"),
    modules: path.join(analysis, "modules.json"),
    unbundleReport: path.join(analysis, "unbundle-report.json"),
    project: path.join(abs, "project"),
    packageJson: path.join(abs, "project", "package.json"),
    projectRecovered: path.join(abs, "project", "src", "_recovered"),
    agents: path.join(abs, "AGENTS.md"),
    claude: path.join(abs, "CLAUDE.md"),
    prompt: path.join(abs, "PROMPT.md"),
    progress: path.join(abs, "PROGRESS.md"),
    config: path.join(abs, "s2s.config.ts"),
    gitignore: path.join(abs, ".gitignore"),
    verify: path.join(abs, "verify"),
    verifyReport: path.join(abs, "verify", "report.json"),
    verifyReportMd: path.join(abs, "verify", "report.md"),
    verifyDiffs: path.join(abs, "verify", "diffs"),
    verifyHistory: path.join(abs, "verify", "history.jsonl"),
    verifyBaseline: path.join(abs, "verify", "baseline"),
  };
}
