import { type Evidence, type Signal, STRENGTH_RANK, type Strength } from "./evidence.js";
import { compareVersions, isXRange, parseVersion } from "./registry.js";

export type Confidence = "high" | "medium" | "low";
export const CONFIDENCE_RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

export type VersionSource =
  /** Read from evidence. */
  | "evidence"
  /** Copied from the package that implies this one (react-dom's version for react). */
  | "implied"
  /** Newest version published before the bundle's `Last-Modified` date. */
  | "inferred"
  /** An x-range from evidence, narrowed by the registry to one version. */
  | "range"
  /** No version could be found (offline, or the registry had none). */
  | "unresolved";

export interface VersionCandidate {
  version: string;
  strength: Strength;
  bytes: number;
  pages: string[];
  evidence: string[];
}

export interface RegistryCheck {
  status: "passed" | "failed" | "skipped";
  reason: string | null;
  exists: boolean | null;
  versionPublished: boolean | null;
  weeklyDownloads: number | null;
}

export interface MergedPackage {
  name: string;
  version: string | null;
  versionSource: VersionSource;
  confidence: Confidence;
  strongest: Strength;
  signals: Signal[];
  /** At least one piece of evidence named the package from structure, not from site text. */
  trusted: boolean;
  /** Every piece of evidence marks it a build tool. */
  dev: boolean;
  evidence: string[];
  /** Every version seen, best first; more than one means the signals disagree. */
  versions: VersionCandidate[];
  /** Versions incompatible with the chosen one. */
  disagreements: string[];
  bytes: number;
  pages: string[];
  impliedBy: string[];
  /** Detected packages that depend on this one, so it comes in through them. */
  transitiveOf: string[];
  /** From nested source-map paths (`node_modules/a/node_modules/b`). */
  parents: string[];
  registry: RegistryCheck | null;
}

/** Packages that ship with another one: finding the key means the values are there too. */
export const IMPLIES: Record<string, string[]> = {
  "react-dom": ["react"],
  next: ["react", "react-dom"],
  // drei is built on fiber and needs it installed beside it.
  "@react-three/drei": ["@react-three/fiber"],
};

/** Packages released in lockstep, so the implier's version is the implied one's too. */
const LOCKSTEP = new Set(["react-dom>react"]);

function compatible(a: string, b: string): boolean {
  if (a === b) return true;
  if (isXRange(a)) return b.startsWith(a.slice(0, -1));
  if (isXRange(b)) return a.startsWith(b.slice(0, -1));
  return false;
}

function confidenceOf(items: Evidence[]): Confidence {
  if (items.some((e) => e.strength === "exact")) return "high";
  const strongSignals = new Set(items.filter((e) => e.strength === "strong").map((e) => e.signal));
  if (strongSignals.size >= 2) return "high";
  if (strongSignals.size === 1) return "medium";
  return "low";
}

/**
 * Group evidence by package and score each group. The version comes from the strongest signal;
 * among equally strong versions, the one covering the most bytes wins, and the rest are listed.
 */
export function mergeEvidence(evidence: Evidence[]): MergedPackage[] {
  const groups = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const list = groups.get(item.package) ?? [];
    list.push(item);
    groups.set(item.package, list);
  }

  const merged = new Map<string, MergedPackage>();
  for (const [name, items] of groups) {
    const byVersion = new Map<string, VersionCandidate>();
    for (const item of items) {
      if (!item.version) continue;
      const candidate = byVersion.get(item.version) ?? {
        version: item.version,
        strength: item.strength,
        bytes: 0,
        pages: [],
        evidence: [],
      };
      if (STRENGTH_RANK[item.strength] > STRENGTH_RANK[candidate.strength])
        candidate.strength = item.strength;
      candidate.bytes += item.bytes;
      for (const page of item.pages)
        if (!candidate.pages.includes(page)) candidate.pages.push(page);
      candidate.evidence.push(item.id);
      byVersion.set(item.version, candidate);
    }
    const versions = [...byVersion.values()].sort(
      (a, b) =>
        STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength] ||
        // An exact version beats an x-range of the same strength.
        Number(isXRange(a.version)) - Number(isXRange(b.version)) ||
        b.bytes - a.bytes ||
        compareVersions(b.version, a.version),
    );
    const chosen = versions[0]?.version ?? null;
    const strongest = items.reduce<Strength>(
      (best, e) => (STRENGTH_RANK[e.strength] > STRENGTH_RANK[best] ? e.strength : best),
      "name-only",
    );
    merged.set(name, {
      name,
      version: chosen,
      versionSource: chosen ? "evidence" : "unresolved",
      confidence: confidenceOf(items),
      strongest,
      signals: [...new Set(items.map((e) => e.signal))].sort(),
      trusted: items.some((e) => e.trusted),
      dev: items.every((e) => e.dev),
      evidence: items.map((e) => e.id),
      versions,
      disagreements: chosen
        ? versions.map((v) => v.version).filter((v) => !compatible(v, chosen))
        : [],
      bytes: items.reduce((n, e) => n + e.bytes, 0),
      pages: [...new Set(items.flatMap((e) => e.pages))].sort(),
      impliedBy: [],
      transitiveOf: [],
      parents: [...new Set(items.flatMap((e) => e.parents))].sort(),
      registry: null,
    });
  }

  // Implied packages: react-dom brings react, next brings both.
  for (const implier of [...merged.values()]) {
    for (const name of IMPLIES[implier.name] ?? []) {
      const lockstep = LOCKSTEP.has(`${implier.name}>${name}`);
      const known = merged.get(name);
      if (known) {
        if (!known.impliedBy.includes(implier.name)) known.impliedBy.push(implier.name);
        if (CONFIDENCE_RANK[implier.confidence] > CONFIDENCE_RANK[known.confidence])
          known.confidence = implier.confidence;
        if (!known.version && lockstep && implier.version && parseVersion(implier.version)) {
          known.version = implier.version;
          known.versionSource = "implied";
        }
        continue;
      }
      const version =
        lockstep && implier.version && parseVersion(implier.version) ? implier.version : null;
      merged.set(name, {
        name,
        version,
        versionSource: version ? "implied" : "unresolved",
        confidence: implier.confidence,
        strongest: "name-only",
        signals: [],
        trusted: implier.trusted,
        dev: false,
        evidence: [],
        versions: [],
        disagreements: [],
        bytes: 0,
        pages: implier.pages,
        impliedBy: [implier.name],
        transitiveOf: [],
        parents: [],
        registry: null,
      });
    }
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
