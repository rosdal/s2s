import type { PackageManagerHint } from "./packages.js";

export interface Hint {
  value: string;
  confidence: number;
  evidence: string[];
}

export interface AliasHint {
  alias: string;
  target: string;
  confidence: number;
  evidence: string[];
}

export interface ProjectHints {
  language: Hint | null;
  framework: Hint[];
  styling: Hint[];
  aliases: AliasHint[];
  packageManager: PackageManagerHint | null;
}

export interface HintSource {
  /** Project-relative path of a first-party source. */
  path: string;
  content: string | null;
}

const round = (n: number) => Math.round(n * 100) / 100;
const sample = (paths: string[]) => paths.slice(0, 5);

/** Read language, framework, styling and alias hints from recovered first-party sources. */
export function projectHints(
  sources: HintSource[],
  vendorPackages: string[],
  packageManager: PackageManagerHint | undefined,
): ProjectHints {
  const paths = sources.map((s) => s.path);
  const matching = (re: RegExp) => paths.filter((p) => re.test(p));

  const ts = matching(/\.(?:ts|tsx|mts|cts)$/);
  const js = matching(/\.(?:js|jsx|mjs|cjs)$/);
  const language: Hint | null =
    ts.length + js.length === 0
      ? null
      : ts.length >= js.length
        ? {
            value: "typescript",
            confidence: round(ts.length / (ts.length + js.length)),
            evidence: [
              `${ts.length} TypeScript and ${js.length} JavaScript sources`,
              ...sample(ts),
            ],
          }
        : {
            value: "javascript",
            confidence: round(js.length / (ts.length + js.length)),
            evidence: [
              `${ts.length} TypeScript and ${js.length} JavaScript sources`,
              ...sample(js),
            ],
          };

  const vendor = new Set(vendorPackages);
  const framework: Hint[] = [];
  const addFramework = (value: string, confidence: number, evidence: string[]) => {
    if (evidence.length > 0) framework.push({ value, confidence, evidence: sample(evidence) });
  };
  const appRoutes = matching(/(?:^|\/)app\/(?:.*\/)?(?:page|layout)\.[jt]sx?$/);
  // Plenty of SPAs keep screens in `pages/`; only Next's own files or package make it a router.
  const pagesRoutes =
    vendor.has("next") || paths.some((p) => /(?:^|\/)pages\/_(?:app|document)\.[jt]sx?$/.test(p))
      ? matching(/(?:^|\/)pages\/.+\.[jt]sx?$/)
      : [];
  const vue = matching(/\.vue$/);
  const svelte = matching(/\.svelte$/);
  const astro = matching(/\.astro$/);
  const routes = sources
    .filter((s) => /(?:^|\/)routes\/.+\.[jt]sx?$/.test(s.path))
    .filter(
      (s) =>
        s.content &&
        /export\s+(?:async\s+)?(?:function|const)\s+(?:loader|action|clientLoader)\b/.test(
          s.content,
        ),
    )
    .map((s) => s.path);
  addFramework("next-app-router", vendor.has("next") ? 0.9 : 0.6, appRoutes);
  if (vue.length === 0)
    addFramework("next-pages-router", vendor.has("next") ? 0.9 : 0.5, pagesRoutes);
  addFramework(vendor.has("nuxt") ? "nuxt" : "vue", 0.9, vue);
  addFramework(
    svelte.some((p) => /routes\/.*\+page\.svelte$/.test(p)) || vendor.has("@sveltejs/kit")
      ? "sveltekit"
      : "svelte",
    0.9,
    svelte,
  );
  addFramework("astro", 0.9, astro);
  addFramework(vendor.has("@remix-run/react") ? "remix" : "react-router", 0.7, routes);
  if (framework.length === 0) {
    for (const name of ["react", "vue", "svelte", "preact", "solid-js", "@angular/core"]) {
      if (vendor.has(name))
        framework.push({
          value: name.replace("@angular/core", "angular"),
          confidence: 0.5,
          evidence: [`vendor package ${name}`],
        });
    }
  }

  const styling: Hint[] = [];
  const addStyling = (value: string, evidence: string[]) => {
    if (evidence.length > 0) styling.push({ value, confidence: 0.95, evidence: sample(evidence) });
  };
  // A preprocessor stylesheet is often missing from every map (its CSS was extracted), but the
  // code that imports it still says which preprocessor the build ran.
  const importing = (re: RegExp) =>
    sources.filter((s) => s.content && re.test(s.content)).map((s) => `${s.path} imports one`);
  addStyling("scss", [
    ...matching(/\.s[ac]ss$/),
    ...importing(/(?:\bimport\s*|\bfrom\s*|@import\s+)["'][^"'\n]+\.s[ac]ss["']/),
  ]);
  addStyling("less", [
    ...matching(/\.less$/),
    ...importing(/(?:\bimport\s*|\bfrom\s*|@import\s+)["'][^"'\n]+\.less["']/),
  ]);
  addStyling("css-modules", matching(/\.module\.(?:css|s[ac]ss|less)$/));
  const tailwind = sources
    .filter(
      (s) =>
        s.content && /@tailwind\s|@import\s+["']tailwindcss|from\s+["']tailwindcss/.test(s.content),
    )
    .map((s) => s.path);
  if (tailwind.length === 0 && vendor.has("tailwindcss"))
    tailwind.push("vendor package tailwindcss");
  addStyling("tailwind", tailwind);

  return {
    language,
    framework,
    styling,
    aliases: findAliases(sources),
    packageManager: packageManager ?? null,
  };
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|@import\s+)["']([^"']+)["']/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", ".svelte", ".css", ".scss"];

/**
 * Find import prefixes like `@/` or `~/` that resolve to a project folder: for `@/components/X`,
 * look for a source ending in `components/X` (plus an extension or `/index`) and take the folder
 * in front of it as the alias target.
 */
function findAliases(sources: HintSource[]): AliasHint[] {
  // Every segment suffix of every path, mapped to the folder in front of it, so each import
  // resolves with a few lookups instead of a scan over all paths.
  const suffixes = new Map<string, string>();
  for (const { path } of sources) {
    const segments = path.split("/");
    for (let i = segments.length - 1; i >= 0; i--) {
      const suffix = segments.slice(i).join("/");
      if (!suffixes.has(suffix)) suffixes.set(suffix, segments.slice(0, i).join("/"));
    }
  }
  const found = new Map<string, Map<string, string[]>>();
  for (const source of sources) {
    if (!source.content) continue;
    for (const match of source.content.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? "";
      const prefix = /^(@|~|#)\//.exec(specifier)?.[0];
      if (!prefix) continue;
      const rest = specifier.slice(prefix.length);
      const target = resolveAlias(suffixes, rest);
      if (target === undefined) continue;
      const byTarget = found.get(prefix) ?? new Map<string, string[]>();
      found.set(prefix, byTarget);
      const evidence = byTarget.get(target) ?? [];
      byTarget.set(target, evidence);
      evidence.push(`${source.path}: ${specifier}`);
    }
  }
  const aliases: AliasHint[] = [];
  for (const [prefix, byTarget] of found) {
    const ranked = [...byTarget.entries()].sort((a, b) => b[1].length - a[1].length);
    const [target, evidence] = ranked[0] ?? [];
    if (target === undefined || !evidence) continue;
    const total = ranked.reduce((sum, [, e]) => sum + e.length, 0);
    aliases.push({
      alias: `${prefix}*`,
      target: target === "" ? "*" : `${target}/*`,
      confidence: round(Math.min(0.95, 0.5 + 0.1 * evidence.length) * (evidence.length / total)),
      evidence: sample(evidence),
    });
  }
  return aliases;
}

function resolveAlias(suffixes: Map<string, string>, rest: string): string | undefined {
  for (const ext of EXTENSIONS) {
    for (const tail of [`${rest}${ext}`, `${rest}/index${ext}`]) {
      if (ext === "" && tail === rest && !/\.[a-z]+$/.test(rest)) continue;
      const target = suffixes.get(tail);
      if (target !== undefined) return target;
    }
  }
  return undefined;
}
