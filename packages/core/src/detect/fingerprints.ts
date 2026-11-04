import type { FingerprintIndex } from "../fingerprint/db.js";
import { type MatchStats, matchBundles, type PackageMatch } from "../fingerprint/match.js";
import { fingerprintDir, openIndexes } from "../fingerprint/store.js";
import type { DetectContext } from "./context.js";
import { ByteIndex, type EvidenceInput, excerptOf } from "./evidence.js";

export interface FingerprintOptions {
  /** Folder holding the shared index and the local overlay; defaults to the s2s cache. */
  dir?: string;
  /** Already-open indexes, used instead of `dir` (tests, the benchmark). */
  indexes?: FingerprintIndex[];
}

/** A stretch of one bundle the matcher attributes to a package. String indices. */
export interface FingerprintRange {
  package: string;
  start: number;
  end: number;
  /** Id of the evidence item the range came from. */
  evidence: string;
}

export interface FingerprintCollection {
  items: EvidenceInput[];
  /** Ranges by body hash. */
  ranges: Map<string, FingerprintRange[]>;
  /** What `analysis/evidence/fingerprints.json` records beyond the evidence. */
  report: {
    index: { date: string | null; files: string[]; packages: number } | null;
    stats: MatchStats | null;
    matches: Omit<PackageMatch, "bundles">[];
  };
  warnings: string[];
}

/**
 * The AST fingerprint collector: match every JS body against the fingerprint index and turn each
 * package found into one piece of evidence per bundle it was found in. A confident version is
 * `strong` evidence; presence without one is `weak`.
 */
export async function collectFingerprints(
  ctx: DetectContext,
  options: FingerprintOptions = {},
): Promise<FingerprintCollection> {
  const empty: FingerprintCollection = {
    items: [],
    ranges: new Map(),
    report: { index: null, stats: null, matches: [] },
    warnings: [],
  };
  let indexes = options.indexes;
  let opened: FingerprintIndex[] = [];
  let date: string | null = null;
  if (!indexes) {
    const result = await openIndexes(options.dir ?? fingerprintDir());
    empty.warnings.push(...result.warnings);
    indexes = opened = result.indexes;
    date = result.date;
  }
  if (indexes.length === 0) return empty;

  try {
    const bundles: { id: string; url: string; text: string }[] = [];
    for (const asset of ctx.assets) {
      if (asset.kind !== "js") continue;
      const text = await ctx.text(asset.hash);
      if (text) bundles.push({ id: asset.hash, url: asset.urls[0] ?? "", text });
    }
    const result = await matchBundles(bundles, indexes);
    const items: EvidenceInput[] = [];
    const ranges = new Map<string, FingerprintRange[]>();
    const texts = new Map(bundles.map((b) => [b.id, b.text]));
    for (const match of result.packages) {
      for (const bundle of match.bundles) {
        const asset = ctx.assets.find((a) => a.hash === bundle.id);
        const text = texts.get(bundle.id) ?? "";
        const bytes = new ByteIndex(text);
        const id = `fingerprints:${items.length}`;
        const covered = bundle.ranges.reduce(
          (n, r) => n + Buffer.byteLength(text.slice(r.start, r.end)),
          0,
        );
        const at = bundle.ranges[0]?.start ?? bundle.first;
        items.push({
          package: match.name,
          version: match.version,
          signal: "fingerprint",
          strength: match.confident ? "strong" : "weak",
          trusted: true,
          location: {
            file: bundle.url,
            bodyHash: bundle.id,
            offset: bytes.bytes(at),
            length: bundle.ranges[0]
              ? Buffer.byteLength(text.slice(bundle.ranges[0].start, bundle.ranges[0].end))
              : null,
          },
          bytes: covered,
          pages: asset?.pages ?? [],
          excerpt: excerptOf(
            `${bundle.functions} of ${match.indexed} indexed functions` +
              (bundle.strings ? `, ${bundle.strings} distinctive strings` : "") +
              ` match ${match.name}@${match.version ?? "?"}` +
              (match.candidates.length > 1 ? ` (${match.candidates.length} versions tie)` : "") +
              `, score ${match.score}`,
          ),
        });
        const list = ranges.get(bundle.id) ?? [];
        for (const r of bundle.ranges)
          list.push({ package: match.name, start: r.start, end: r.end, evidence: id });
        ranges.set(bundle.id, list);
      }
    }
    const counts = indexes.reduce((n, i) => n + i.packages.size, 0);
    return {
      items,
      ranges,
      report: {
        index: { date, files: indexes.map((i) => i.path), packages: counts },
        stats: result.stats,
        matches: result.packages.map(({ bundles: _bundles, ...rest }) => rest),
      },
      warnings: empty.warnings,
    };
  } finally {
    for (const index of opened) index.close();
  }
}
