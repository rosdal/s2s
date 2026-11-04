import { compareVersions, parseVersion } from "../detect/registry.js";
import { bitIndices, type FingerprintIndex, type HashKind, MAX_SHARING } from "./db.js";
import { loadHasher } from "./hash.js";
import { type CodePrints, fingerprintCodeSync } from "./normalize.js";

/** A package needs at least this many distinct matched functions to count as present. */
export const MIN_FUNCTIONS = 5;
/**
 * And an IDF-weighted score of at least this much. A function found in one package only weighs
 * 1; one shared by `df` of `N` packages weighs `ln(1 + N/df) / ln(1 + N)`, so the threshold
 * reads as "unique functions" whatever the index size.
 */
export const MIN_SCORE = 4;
/** A distinctive string is weaker than a function: it may sit in first-party code too. */
const STRING_WEIGHT = 0.5;
/** Matched functions this close together (in characters) are one vendor range. */
const CLUSTER_GAP = 1024;
/** A vendor range needs at least this many matched functions, so one stray hit drops no code. */
const MIN_CLUSTER_FUNCTIONS = 2;

export interface MatchBundle {
  /** Body hash or any id unique among the bundles. */
  id: string;
  url: string;
  text: string;
}

export interface MatchRange {
  /** UTF-16 offsets into the bundle text; `end` is exclusive. */
  start: number;
  end: number;
  functions: number;
}

export interface BundleMatch {
  id: string;
  url: string;
  functions: number;
  strings: number;
  ranges: MatchRange[];
  /** UTF-16 offset of the first matched function. */
  first: number;
}

export interface PackageMatch {
  name: string;
  score: number;
  /** Distinct matched function hashes this package was credited with. */
  functions: number;
  strings: number;
  /** Distinct function hashes the index holds for the package. */
  indexed: number;
  /** An exact version, an x-range (`4.17.x`, `4.x`), or null when no hash tells versions apart. */
  version: string | null;
  /** The versions that best explain the matched hashes, oldest first. */
  candidates: string[];
  /** Exact, or narrowed to one minor. */
  confident: boolean;
  bundles: BundleMatch[];
}

export interface MatchStats {
  bundles: number;
  chars: number;
  functions: number;
  matchedFunctions: number;
  strings: number;
  matchedStrings: number;
  parseErrors: number;
  ms: number;
}

export interface MatchResult {
  packages: PackageMatch[];
  stats: MatchStats;
}

/** Package name → its versions found in one hash's postings. */
type Owners = Map<string, Set<string>>;

/** Postings from every index merged by package name, so an overlay adds to the shared index. */
function lookupAll(
  indexes: FingerprintIndex[],
  kind: HashKind,
  hashes: bigint[],
): Map<bigint, Owners> {
  const out = new Map<bigint, Owners>();
  for (const index of indexes) {
    for (const [hash, postings] of index.lookup(kind, hashes)) {
      const owners = out.get(hash) ?? new Map<string, Set<string>>();
      for (const p of postings) {
        const pkg = index.packages.get(p.packageId);
        if (!pkg) continue;
        const set = owners.get(pkg.name) ?? new Set<string>();
        for (const idx of bitIndices(p.versions)) {
          const version = pkg.versions[idx];
          if (version) set.add(version);
        }
        owners.set(pkg.name, set);
      }
      out.set(hash, owners);
    }
  }
  return out;
}

/** Every version each package has in any of the indexes. */
function versionUniverse(
  indexes: FingerprintIndex[],
): Map<string, { versions: Set<string>; indexed: number }> {
  const out = new Map<string, { versions: Set<string>; indexed: number }>();
  for (const index of indexes)
    for (const pkg of index.packages.values()) {
      const known = out.get(pkg.name) ?? { versions: new Set<string>(), indexed: 0 };
      for (const v of pkg.versions) if (v) known.versions.add(v);
      known.indexed = Math.max(known.indexed, pkg.functions);
      out.set(pkg.name, known);
    }
  return out;
}

/**
 * Match bundles against one or more indexes (the shared one and a local overlay). Presence is the
 * IDF-weighted count of matched functions, credited greedily so a hash shared by two packages
 * counts once, for the one that explains more. The version is the set of versions that contain
 * the most matched hashes, reported as a range when several tie.
 */
export async function matchBundles(
  bundles: MatchBundle[],
  indexes: FingerprintIndex[],
): Promise<MatchResult> {
  await loadHasher();
  const started = performance.now();
  const prints = new Map<string, CodePrints>();
  const stats: MatchStats = {
    bundles: bundles.length,
    chars: 0,
    functions: 0,
    matchedFunctions: 0,
    strings: 0,
    matchedStrings: 0,
    parseErrors: 0,
    ms: 0,
  };
  const functionHashes = new Set<bigint>();
  const stringHashes = new Set<bigint>();
  for (const bundle of bundles) {
    const p = fingerprintCodeSync(bundle.text, "bundle.js");
    prints.set(bundle.id, p);
    stats.chars += bundle.text.length;
    if (p.error) stats.parseErrors++;
    for (const f of p.functions) functionHashes.add(f.hash);
    for (const s of p.strings) stringHashes.add(s.hash);
  }
  stats.functions = functionHashes.size;
  stats.strings = stringHashes.size;

  const universe = versionUniverse(indexes);
  const total = universe.size;
  const fnOwners = lookupAll(indexes, "function", [...functionHashes]);
  const strOwners = lookupAll(indexes, "string", [...stringHashes]);
  // Code a package shares with one of its own dependencies is the dependency's: a prebuilt
  // bundle (`vue/dist/vue.esm-browser.js`) or code that later moved into its own package
  // (framer-motion into motion-dom) must not claim the dependency's functions.
  const depsOf = new Map<string, Set<string>>();
  for (const index of indexes)
    for (const pkg of index.packages.values()) {
      const set = depsOf.get(pkg.name) ?? new Set<string>();
      for (const d of pkg.dependencies) set.add(d);
      depsOf.set(pkg.name, set);
    }
  for (const owners of [...fnOwners.values(), ...strOwners.values()]) {
    if (owners.size < 2) continue;
    const names = [...owners.keys()];
    const drop = names.filter((name) =>
      names.some((other) => other !== name && depsOf.get(name)?.has(other)),
    );
    // Packages that depend on each other cancel out; then nobody is dropped.
    if (drop.length < names.length) for (const name of drop) owners.delete(name);
  }
  // An overlay can push a hash over the sharing limit; the merged view applies it again.
  for (const [hash, owners] of fnOwners) if (owners.size > MAX_SHARING) fnOwners.delete(hash);
  for (const [hash, owners] of strOwners) if (owners.size > 1) strOwners.delete(hash);
  stats.matchedFunctions = fnOwners.size;
  stats.matchedStrings = strOwners.size;

  const weight = (df: number) => (total <= 1 ? 1 : Math.log(1 + total / df) / Math.log(1 + total));

  // Candidate packages and the hashes that point at them.
  const byPackage = new Map<string, { functions: Set<bigint>; strings: Set<bigint> }>();
  const entry = (name: string) => {
    let e = byPackage.get(name);
    if (!e) {
      e = { functions: new Set(), strings: new Set() };
      byPackage.set(name, e);
    }
    return e;
  };
  for (const [hash, owners] of fnOwners)
    for (const name of owners.keys()) entry(name).functions.add(hash);
  for (const [hash, owners] of strOwners)
    for (const name of owners.keys()) entry(name).strings.add(hash);

  // Greedy credit: repeatedly take the package with the best score over unclaimed hashes.
  const claimed = new Set<bigint>();
  const accepted: { name: string; score: number; functions: Set<bigint>; strings: Set<bigint> }[] =
    [];
  const remaining = new Set(
    [...byPackage.keys()].filter((n) => (byPackage.get(n)?.functions.size ?? 0) >= MIN_FUNCTIONS),
  );
  const effective = (name: string) => {
    const e = byPackage.get(name) as { functions: Set<bigint>; strings: Set<bigint> };
    let score = 0;
    let count = 0;
    for (const hash of e.functions) {
      if (claimed.has(hash)) continue;
      score += weight(fnOwners.get(hash)?.size ?? 1);
      count++;
    }
    score += e.strings.size * STRING_WEIGHT;
    return { score, count };
  };
  while (remaining.size > 0) {
    let best: { name: string; score: number; count: number } | undefined;
    for (const name of remaining) {
      const { score, count } = effective(name);
      if (
        !best ||
        score > best.score ||
        (score === best.score && name.localeCompare(best.name) < 0)
      )
        best = { name, score, count };
    }
    if (!best) break;
    remaining.delete(best.name);
    if (best.count < MIN_FUNCTIONS || best.score < MIN_SCORE) continue;
    const e = byPackage.get(best.name) as { functions: Set<bigint>; strings: Set<bigint> };
    const mine = new Set([...e.functions].filter((h) => !claimed.has(h)));
    for (const h of mine) claimed.add(h);
    accepted.push({ name: best.name, score: best.score, functions: mine, strings: e.strings });
  }

  const packages: PackageMatch[] = [];
  for (const a of accepted) {
    const e = byPackage.get(a.name) as { functions: Set<bigint>; strings: Set<bigint> };
    const all = universe.get(a.name)?.versions ?? new Set<string>();
    const { version, candidates, confident } = chooseVersion(
      a.name,
      all,
      // Every matched hash speaks to the version, shared ones included.
      [
        ...[...e.functions].map((h) => ({
          owners: fnOwners.get(h),
          w: weight(fnOwners.get(h)?.size ?? 1),
        })),
        ...[...e.strings].map((h) => ({ owners: strOwners.get(h), w: STRING_WEIGHT })),
      ],
    );
    packages.push({
      name: a.name,
      score: Math.round(a.score * 100) / 100,
      functions: a.functions.size,
      strings: a.strings.size,
      indexed: universe.get(a.name)?.indexed ?? 0,
      version,
      candidates,
      confident,
      bundles: bundleMatches(bundles, prints, a.functions, a.strings, accepted, a.name),
    });
  }
  packages.sort((x, y) => x.name.localeCompare(y.name));
  stats.ms = Math.round(performance.now() - started);
  return { packages, stats };
}

function chooseVersion(
  name: string,
  all: Set<string>,
  hits: { owners: Owners | undefined; w: number }[],
): { version: string | null; candidates: string[]; confident: boolean } {
  const scores = new Map<string, number>();
  for (const v of all) scores.set(v, 0);
  for (const { owners, w } of hits) {
    const versions = owners?.get(name);
    if (!versions || versions.size === all.size) continue;
    for (const v of versions) scores.set(v, (scores.get(v) ?? 0) + w);
  }
  const best = Math.max(0, ...scores.values());
  if (best === 0) {
    // Nothing tells versions apart. With one version indexed (a local overlay pinned to a
    // release), that version is the answer; otherwise there is no version to report.
    const only = all.size === 1 && hits.some((h) => h.owners?.has(name)) ? [...all] : [];
    return only.length === 1
      ? { version: only[0] as string, candidates: only, confident: true }
      : { version: null, candidates: [], confident: false };
  }
  const candidates = [...scores]
    .filter(([, s]) => s >= best - 1e-9)
    .map(([v]) => v)
    .sort(compareVersions);
  return { ...describeVersions(candidates), candidates };
}

/** One version, or the narrowest x-range (`4.17.x`, `4.x`) covering all of them. */
export function describeVersions(versions: string[]): {
  version: string | null;
  confident: boolean;
} {
  if (versions.length === 1) return { version: versions[0] ?? null, confident: true };
  const parsed = versions.map(parseVersion);
  if (parsed.length === 0 || parsed.some((p) => !p)) return { version: null, confident: false };
  const first = parsed[0] as NonNullable<(typeof parsed)[number]>;
  if (parsed.every((p) => p?.major === first.major && p.minor === first.minor))
    return { version: `${first.major}.${first.minor}.x`, confident: true };
  if (parsed.every((p) => p?.major === first.major))
    return { version: `${first.major}.x`, confident: false };
  return { version: null, confident: false };
}

function bundleMatches(
  bundles: MatchBundle[],
  prints: Map<string, CodePrints>,
  functions: Set<bigint>,
  strings: Set<bigint>,
  accepted: { name: string; functions: Set<bigint> }[],
  name: string,
): BundleMatch[] {
  const out: BundleMatch[] = [];
  for (const bundle of bundles) {
    const p = prints.get(bundle.id);
    if (!p) continue;
    const mine = p.functions.filter((f) => functions.has(f.hash));
    const myStrings = p.strings.filter((s) => strings.has(s.hash));
    if (mine.length === 0 && myStrings.length === 0) continue;
    // Other packages' functions bound a cluster: vendor code of two packages never merges.
    const others = p.functions
      .filter(
        (f) =>
          !functions.has(f.hash) &&
          accepted.some((a) => a.name !== name && a.functions.has(f.hash)),
      )
      .map((f) => f.start)
      .sort((a, b) => a - b);
    out.push({
      id: bundle.id,
      url: bundle.url,
      functions: new Set(mine.map((f) => f.hash)).size,
      strings: new Set(myStrings.map((s) => s.hash)).size,
      ranges: cluster(outermost(mine), others),
      first: Math.min(...mine.map((f) => f.start), ...myStrings.map((s) => s.start)),
    });
  }
  return out;
}

/** Drop spans nested inside another span. */
function outermost(spans: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: { start: number; end: number }[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.end <= last.end) continue;
    out.push({ start: s.start, end: s.end });
  }
  return out;
}

function cluster(spans: { start: number; end: number }[], others: number[]): MatchRange[] {
  const out: MatchRange[] = [];
  let open: MatchRange | undefined;
  for (const s of spans) {
    const blocked = open && others.some((o) => o >= (open as MatchRange).end && o < s.start);
    if (open && !blocked && s.start - open.end <= CLUSTER_GAP) {
      open.end = Math.max(open.end, s.end);
      open.functions++;
      continue;
    }
    if (open) out.push(open);
    open = { start: s.start, end: s.end, functions: 1 };
  }
  if (open) out.push(open);
  return out.filter((r) => r.functions >= MIN_CLUSTER_FUNCTIONS);
}
