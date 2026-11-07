import type { CdnPackageEntry } from "../capture/cdn.js";
import { readLicenseRef } from "../capture/discovery/readers.js";
import type { ProjectHints } from "../maps/hints.js";
import { findBanners, parseBanner } from "./banners.js";
import type { DetectContext } from "./context.js";
import { ByteIndex, type EvidenceInput, excerptOf, isNpmName } from "./evidence.js";
import { parseVersion } from "./registry.js";
import { type CompiledPattern, compileSignatures, matchSignatures } from "./signatures.js";

const isExact = (version: string | null | undefined): version is string =>
  typeof version === "string" && parseVersion(version) !== undefined;

/** `raw/cdn-packages.json`: a CDN URL names the package, and usually its exact version. */
export async function collectCdn(ctx: DetectContext): Promise<EvidenceInput[]> {
  const entries = (await ctx.readJson<CdnPackageEntry[]>(ctx.paths.cdnPackages)) ?? [];
  const out: EvidenceInput[] = [];
  for (const entry of entries) {
    if (!isNpmName(entry.name)) continue;
    const exact = isExact(entry.version);
    for (const url of entry.urls) {
      const asset = ctx.assets.find((a) => a.urls.includes(url));
      out.push({
        package: entry.name,
        // A tag or range (`lodash@4`) is not a version to pin; the registry resolves it later.
        version: exact ? entry.version : null,
        signal: "cdn-url",
        strength: exact ? "exact" : "strong",
        trusted: true,
        location: { file: url, bodyHash: asset?.hash ?? null, offset: null, length: null },
        bytes: asset?.size ?? 0,
        pages: asset?.pages ?? [],
        excerpt: excerptOf(url),
      });
    }
  }
  return out;
}

interface SourcemapPackages {
  packageManager: unknown;
  packages: {
    name: string;
    version: string | null;
    parents: string[];
    totalBytes: number;
    paths: string[];
  }[];
}

/** `analysis/evidence/sourcemap-packages.json` from Stage 2: vendor paths inside source maps. */
export async function collectSourcemap(ctx: DetectContext): Promise<EvidenceInput[]> {
  const file = await ctx.readJson<SourcemapPackages>(ctx.paths.sourcemapPackages);
  return (file?.packages ?? [])
    .filter((p) => isNpmName(p.name))
    .map((p) => ({
      package: p.name,
      version: isExact(p.version) ? p.version : null,
      signal: "sourcemap-path" as const,
      strength: isExact(p.version) ? ("exact" as const) : ("strong" as const),
      trusted: true,
      location: { file: p.paths[0] ?? p.name, bodyHash: null, offset: null, length: null },
      bytes: p.totalBytes,
      pages: [],
      excerpt: p.paths[0] ? excerptOf(p.paths[0]) : null,
      parents: p.parents,
    }));
}

/** License banners (`/*! name vX.Y.Z *\/`, `@license name X.Y.Z`) inside JS and CSS bodies. */
export async function collectBanners(ctx: DetectContext): Promise<EvidenceInput[]> {
  const out: EvidenceInput[] = [];
  for (const asset of ctx.assets) {
    const text = await ctx.text(asset.hash);
    if (!text) continue;
    const bytes = new ByteIndex(text);
    for (const banner of findBanners(text)) {
      for (const hit of parseBanner(banner.text)) {
        out.push({
          package: hit.name,
          version: hit.version,
          signal: "banner",
          strength: hit.version ? "strong" : "weak",
          trusted: false,
          location: {
            file: asset.urls[0] ?? "",
            bodyHash: asset.hash,
            offset: bytes.bytes(banner.index),
            length: Buffer.byteLength(banner.text),
          },
          bytes: 0,
          pages: asset.pages,
          excerpt: excerptOf(banner.text),
        });
      }
    }
  }
  return out;
}

/** webpack's extracted `*.js.LICENSE.txt` files, which hold the banners Terser moved out. */
export async function collectLicenseFiles(ctx: DetectContext): Promise<EvidenceInput[]> {
  // Pages of the bundles that point at each license file, so the evidence carries them too.
  const pagesByLicense = new Map<string, string[]>();
  for (const asset of ctx.assets) {
    if (asset.kind !== "js") continue;
    const text = await ctx.text(asset.hash);
    if (!text) continue;
    for (const url of asset.urls) {
      const target = readLicenseRef(text, url);
      if (!target) continue;
      pagesByLicense.set(target, [...(pagesByLicense.get(target) ?? []), ...asset.pages]);
    }
  }
  const out: EvidenceInput[] = [];
  for (const file of ctx.licenseFiles) {
    const text = await ctx.text(file.hash);
    if (!text) continue;
    const bytes = new ByteIndex(text);
    const pages = [...new Set([...file.pages, ...(pagesByLicense.get(file.url) ?? [])])];
    for (const banner of findBanners(text)) {
      for (const hit of parseBanner(banner.text)) {
        out.push({
          package: hit.name,
          version: hit.version,
          signal: "license-file",
          strength: hit.version ? "strong" : "weak",
          trusted: false,
          location: {
            file: file.url,
            bodyHash: file.hash,
            offset: bytes.bytes(banner.index),
            length: Buffer.byteLength(banner.text),
          },
          bytes: 0,
          pages,
          excerpt: excerptOf(banner.text),
        });
      }
    }
  }
  return out;
}

/** The signature files run over every body; matches need their anchor tokens nearby. */
export async function collectVersionStrings(
  ctx: DetectContext,
  patterns: CompiledPattern[] = compileSignatures(),
): Promise<EvidenceInput[]> {
  const out: EvidenceInput[] = [];
  for (const asset of ctx.assets) {
    const text = await ctx.text(asset.hash);
    if (!text) continue;
    const bytes = new ByteIndex(text);
    for (const match of matchSignatures(text, asset.kind, patterns)) {
      out.push({
        package: match.package,
        version: match.version,
        signal: "version-string",
        strength: match.version ? "strong" : "weak",
        trusted: true,
        location: {
          file: asset.urls[0] ?? "",
          bodyHash: asset.hash,
          offset: bytes.bytes(match.index),
          length: Buffer.byteLength(text.slice(match.index, match.index + match.length)),
        },
        bytes: 0,
        pages: asset.pages,
        excerpt: excerptOf(
          `${match.patternId}: ${text.slice(Math.max(0, match.index - 40), match.index + match.length + 40)}`,
        ),
        dev: match.dev,
      });
    }
  }
  return out;
}

interface RuntimeEntry {
  page: string;
  url: string;
  generator?: string | null;
  frameworks?: Record<string, unknown>;
}

const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/** Probe keys whose value carries a `version`, and the package that version belongs to. */
const VERSIONED_PROBES: Record<string, { package: string; strength: "exact" | "strong" }> = {
  react: { package: "react", strength: "exact" },
  next: { package: "next", strength: "exact" },
  reactRouter: { package: "react-router", strength: "exact" },
  vue: { package: "vue", strength: "exact" },
  angular: { package: "@angular/core", strength: "exact" },
  preact: { package: "preact", strength: "exact" },
  qwik: { package: "@builder.io/qwik", strength: "exact" },
  alpine: { package: "alpinejs", strength: "exact" },
  jquery: { package: "jquery", strength: "exact" },
  // underscore also sets `_.VERSION`, so a lodash version from the global is only strong.
  lodash: { package: "lodash", strength: "strong" },
  dayjs: { package: "dayjs", strength: "exact" },
  bootstrap: { package: "bootstrap", strength: "exact" },
};

/** Probe keys that prove a package is present without saying which version. */
const MARKER_PROBES: Record<string, string> = {
  react: "react",
  reactRoot: "react",
  next: "next",
  remix: "@remix-run/react",
  reactRouter: "react-router",
  nuxt: "nuxt",
  vue: "vue",
  svelte: "svelte",
  angular: "@angular/core",
  astro: "astro",
  gatsby: "gatsby",
  preact: "preact",
  solid: "solid-js",
  qwik: "@builder.io/qwik",
  alpine: "alpinejs",
};

/** `raw/runtime.json`: versions the page itself reports (`React.version`, `jQuery.fn.jquery`). */
export async function collectRuntime(ctx: DetectContext): Promise<EvidenceInput[]> {
  const entries = (await ctx.readJson<RuntimeEntry[]>(ctx.paths.runtime)) ?? [];
  const out: EvidenceInput[] = [];
  const push = (
    entry: RuntimeEntry,
    name: string,
    version: string,
    strength: "exact" | "strong",
    what: string,
    trusted = true,
  ) => {
    out.push({
      package: name,
      version,
      signal: "runtime",
      strength,
      trusted,
      location: { file: entry.url, bodyHash: null, offset: null, length: null },
      bytes: 0,
      pages: [entry.page],
      excerpt: `${what} = ${JSON.stringify(version)}`,
    });
  };
  for (const entry of entries) {
    const frameworks = entry.frameworks ?? {};
    for (const [key, probe] of Object.entries(VERSIONED_PROBES)) {
      const version = field(frameworks[key], "version");
      // AngularJS (1.x) reports through the same probe key, flagged `legacy`; it is `angular`.
      const name =
        key === "angular" && field(frameworks[key], "legacy") ? "angular" : probe.package;
      if (isExact(version as string))
        push(entry, name, version as string, probe.strength, `${key}.version`);
    }
    // three's `window.__THREE__` is its REVISION ("139"), the minor of the npm version.
    const revision = field(frameworks.three, "revision");
    if (typeof revision === "string" && /^\d{2,3}$/.test(revision))
      push(entry, "three", `0.${revision}.x`, "exact", "window.__THREE__");
    const renderers = frameworks.reactDevtoolsRenderers;
    if (Array.isArray(renderers)) {
      for (const renderer of renderers) {
        const name = field(renderer, "rendererPackageName");
        const version = field(renderer, "version");
        if (typeof name === "string" && isNpmName(name) && isExact(version as string))
          // The page names the renderer package itself, so the name is site text.
          push(entry, name, version as string, "exact", `devtools renderer ${name}`, false);
      }
    }
  }
  return out;
}

const GENERATORS: { pattern: RegExp; package: string }[] = [
  { pattern: /^Astro\b/i, package: "astro" },
  { pattern: /^Docusaurus\b/i, package: "@docusaurus/core" },
  { pattern: /^Gatsby\b/i, package: "gatsby" },
  { pattern: /^VitePress\b/i, package: "vitepress" },
  { pattern: /^VuePress\b/i, package: "vuepress" },
  { pattern: /^Nuxt\b/i, package: "nuxt" },
  { pattern: /^Eleventy\b/i, package: "@11ty/eleventy" },
];

/** project-hints.json framework values, and the package each stands for. */
const HINT_FRAMEWORKS: Record<string, string> = {
  "next-app-router": "next",
  "next-pages-router": "next",
  nuxt: "nuxt",
  vue: "vue",
  sveltekit: "@sveltejs/kit",
  svelte: "svelte",
  astro: "astro",
  remix: "@remix-run/react",
  "react-router": "react-router",
  react: "react",
  preact: "preact",
  "solid-js": "solid-js",
  angular: "@angular/core",
};

/**
 * Framework markers from the runtime probe (`__NEXT_DATA__`, `data-v-*`), the generator meta tag
 * and Stage 2's project hints. They name a package but rarely a version.
 */
export async function collectFramework(ctx: DetectContext): Promise<EvidenceInput[]> {
  const entries = (await ctx.readJson<RuntimeEntry[]>(ctx.paths.runtime)) ?? [];
  const out: EvidenceInput[] = [];
  for (const entry of entries) {
    const frameworks = entry.frameworks ?? {};
    for (const [key, name] of Object.entries(MARKER_PROBES)) {
      if (!(key in frameworks)) continue;
      out.push({
        package: key === "angular" && field(frameworks[key], "legacy") ? "angular" : name,
        version: null,
        signal: "framework-marker",
        strength: "name-only",
        trusted: true,
        location: { file: entry.url, bodyHash: null, offset: null, length: null },
        bytes: 0,
        pages: [entry.page],
        excerpt: `runtime probe: ${key} ${excerptOf(JSON.stringify(frameworks[key]))}`,
      });
    }
    const generator = typeof entry.generator === "string" ? entry.generator.trim() : "";
    const known = GENERATORS.find((g) => g.pattern.test(generator));
    if (known) {
      const version = /\bv?(\d+\.\d+\.\d+)\b/.exec(generator)?.[1] ?? null;
      out.push({
        package: known.package,
        version,
        signal: "framework-marker",
        strength: version ? "strong" : "name-only",
        trusted: true,
        location: { file: entry.url, bodyHash: null, offset: null, length: null },
        bytes: 0,
        pages: [entry.page],
        excerpt: excerptOf(`<meta name="generator" content="${generator}">`),
      });
    }
  }
  const hints = await ctx.readJson<ProjectHints>(ctx.paths.projectHints);
  for (const hint of hints?.framework ?? []) {
    const name = HINT_FRAMEWORKS[hint.value];
    if (!name) continue;
    out.push({
      package: name,
      version: null,
      signal: "project-hint",
      strength: "name-only",
      trusted: true,
      location: { file: "analysis/project-hints.json", bodyHash: null, offset: null, length: null },
      bytes: 0,
      pages: [],
      excerpt: excerptOf(
        `framework ${hint.value} (${hint.confidence}): ${hint.evidence.join(", ")}`,
      ),
    });
  }
  return out;
}

export const COLLECTORS = {
  cdn: collectCdn,
  sourcemap: collectSourcemap,
  banners: collectBanners,
  "license-files": collectLicenseFiles,
  "version-strings": collectVersionStrings,
  runtime: collectRuntime,
  framework: collectFramework,
} as const;
export type CollectorName = keyof typeof COLLECTORS;
