export type BundlerName =
  | "webpack"
  | "vite"
  | "rollup"
  | "esbuild"
  | "browserify"
  | "parcel"
  | "turbopack"
  | "unknown";

export interface BundlerSignal {
  bundler: Exclude<BundlerName, "unknown">;
  signal: string;
  /** Version the signal implies, such as "5" for webpack 5's chunk format. */
  version?: string;
}

interface Signature extends BundlerSignal {
  test: RegExp;
}

/**
 * Runtime shapes each bundler leaves in its output, minified or not. Order is priority: when a
 * chunk matches several (Vite bundles esbuild-style helpers, for one), the first bundler wins.
 */
const SIGNATURES: Signature[] = [
  { bundler: "turbopack", signal: "TURBOPACK global", test: /\bTURBOPACK\b/ },
  { bundler: "parcel", signal: "parcelRequire", test: /\bparcelRequire\w*/ },
  {
    bundler: "webpack",
    signal: "webpackChunk push array",
    version: "5",
    test: /\bwebpackChunk[\w$]*\s*=/,
  },
  {
    bundler: "webpack",
    signal: "webpackJsonp push array",
    version: "4",
    test: /\bwebpackJsonp[\w$]*\s*=/,
  },
  { bundler: "webpack", signal: "__webpack_require__", test: /\b__webpack_require__\b/ },
  {
    bundler: "webpack",
    signal: "webpack 4 module cache ({i,l,exports})",
    version: "4",
    test: /\{\s*i\s*:\s*[\w$]+\s*,\s*l\s*:\s*!1\s*,\s*exports\s*:\s*\{\s*\}\s*\}/,
  },
  {
    bundler: "webpack",
    signal: "webpack 5 runtime require",
    version: "5",
    test: /if\s*\(\s*void 0\s*!==\s*[\w$]+\s*\)\s*return\s+[\w$]+\.exports\s*;?\s*(?:var|const|let)\s+[\w$]+\s*=\s*[\w$]+\[[\w$]+\]\s*=\s*\{\s*(?:id\s*:\s*[\w$]+\s*,\s*(?:loaded\s*:\s*!1\s*,\s*)?)?exports\s*:\s*\{\s*\}\s*\}/,
  },
  { bundler: "vite", signal: "__vite__mapDeps", test: /\b__vite__mapDeps\b/ },
  { bundler: "vite", signal: "__vitePreload", test: /\b__vitePreload\b|vite:preloadError/ },
  {
    bundler: "vite",
    signal: "modulepreload polyfill",
    test: /\.supports\(\s*["'`]modulepreload["'`]\s*\)/,
  },
  {
    bundler: "browserify",
    signal: "browserify prelude",
    test: /"function"\s*==\s*typeof require\s*&&\s*require[\s\S]{0,400}MODULE_NOT_FOUND/,
  },
  {
    bundler: "esbuild",
    signal: "__commonJS / __esm / __toESM helpers",
    test: /\b__(?:commonJS|esm|toESM)\s*=/,
  },
  {
    bundler: "esbuild",
    signal: "minified __esm helper",
    test: /\(\s*[\w$]+\s*=\s*[\w$]+\(\s*[\w$]+\s*=\s*0\s*\)\s*\)/,
  },
  {
    bundler: "rollup",
    signal: "ESM chunk importing a hashed sibling chunk",
    test: /(?:^|[;}\n])\s*import\s*(?:\{[^}]*\}|[\w$]+|\*\s*as\s+[\w$]+)\s*from\s*["'`]\.\/[^"'`]+-[\w-]{6,}\.js["'`]/,
  },
  {
    bundler: "rollup",
    signal: "#region comments (Rolldown)",
    version: "rolldown",
    test: /^\/\/#region /m,
  },
];

export interface ChunkBundler {
  bundler: BundlerName;
  version: string | null;
  signals: BundlerSignal[];
}

/** Which bundler wrote one chunk, from the runtime signatures in its text. */
export function detectChunkBundler(code: string): ChunkBundler {
  const signals: BundlerSignal[] = [];
  for (const sig of SIGNATURES) {
    if (!sig.test.test(code)) continue;
    const { test: _, ...signal } = sig;
    signals.push(signal);
  }
  const first = signals[0];
  if (!first) return { bundler: "unknown", version: null, signals };
  const version = signals.find((s) => s.bundler === first.bundler && s.version)?.version ?? null;
  return { bundler: first.bundler, version, signals };
}

export interface BundlerReport {
  bundler: BundlerName;
  version: string | null;
  /** How sure the call is: every chunk agreeing is high, a lone weak signal is low. */
  confidence: "high" | "medium" | "low";
  chunks: { url: string; bundler: BundlerName; version: string | null; signals: string[] }[];
  /** Other bundlers seen in some chunks, such as a separately built widget. */
  others: BundlerName[];
}

/**
 * The site's bundler: the one behind the most first-party JS bytes. Chunks that show no
 * signature (a tiny lazy chunk, a plain script) do not vote.
 */
export function summarizeBundlers(
  chunks: { url: string; size: number; result: ChunkBundler }[],
): BundlerReport {
  // Vite's lazy chunks only show Rollup's shape; they are Vite's when any chunk says so.
  if (chunks.some((c) => c.result.bundler === "vite")) {
    chunks = chunks.map((c) =>
      c.result.bundler === "rollup" ? { ...c, result: { ...c.result, bundler: "vite" } } : c,
    );
  }
  const bytes = new Map<BundlerName, number>();
  for (const c of chunks) {
    if (c.result.bundler === "unknown") continue;
    bytes.set(c.result.bundler, (bytes.get(c.result.bundler) ?? 0) + Math.max(c.size, 1));
  }
  const ranked = [...bytes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const bundler = ranked[0]?.[0] ?? "unknown";
  const versions = chunks
    .filter((c) => c.result.bundler === bundler && c.result.version)
    .map((c) => c.result.version as string);
  const version = versions.sort()[0] ?? null;
  const voting = chunks.filter((c) => c.result.bundler !== "unknown");
  const agree = voting.filter((c) => c.result.bundler === bundler);
  const strongSignals = new Set(agree.flatMap((c) => c.result.signals.map((s) => s.signal)));
  const confidence: BundlerReport["confidence"] =
    bundler === "unknown"
      ? "low"
      : agree.length === voting.length && strongSignals.size >= 2
        ? "high"
        : "medium";
  return {
    bundler,
    version,
    confidence,
    chunks: chunks.map((c) => ({
      url: c.url,
      bundler: c.result.bundler,
      version: c.result.version,
      signals: c.result.signals.map((s) => s.signal),
    })),
    others: ranked.slice(1).map(([name]) => name),
  };
}

/** The npm package and version range a bundler implies, for `project/package.json`. */
export function bundlerPackage(
  report: Pick<BundlerReport, "bundler" | "version">,
): { name: string; range: string } | undefined {
  const major = report.version && /^\d+$/.test(report.version) ? `^${report.version}.0.0` : null;
  switch (report.bundler) {
    case "webpack":
      return { name: "webpack", range: major ?? "latest" };
    case "vite":
      return { name: "vite", range: "latest" };
    case "rollup":
      return report.version === "rolldown"
        ? { name: "rolldown", range: "latest" }
        : { name: "rollup", range: "latest" };
    case "esbuild":
      return { name: "esbuild", range: "latest" };
    case "browserify":
      return { name: "browserify", range: "latest" };
    case "parcel":
      return { name: "parcel", range: "latest" };
    default:
      // Turbopack ships inside Next.js, which Stage 3 already places.
      return undefined;
  }
}
