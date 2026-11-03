import type { MergedPackage, RegistryCheck } from "./merge.js";
import {
  isXRange,
  type PackageInfo,
  parseVersion,
  type Registry,
  RegistryError,
  resolveVersion,
} from "./registry.js";

export const DEFAULT_POPULARITY_FLOOR = 1_000;

export interface CheckOptions {
  /** `null` when offline: nothing is fetched and no evidence is dropped. */
  registry: Registry | null;
  /** Weekly downloads a name known only from site text must reach. */
  popularityFloor: number;
  /** The `Last-Modified` date to resolve versions against, per package. */
  cutoffOf: (pkg: MergedPackage) => Date | null;
  warn: (message: string) => void;
}

/**
 * Check every candidate against the npm registry: it must exist, its version must be published,
 * and a name that only the site's own text gave must pass the popularity floor. Packages without
 * a version get the newest one published before the bundle's `Last-Modified` date. Afterwards,
 * packages another detected package depends on are marked transitive.
 */
export async function checkPackages(
  packages: MergedPackage[],
  options: CheckOptions,
): Promise<void> {
  const infos = new Map<string, PackageInfo>();
  let unreachable = false;
  for (const pkg of packages) {
    if (!options.registry || unreachable) {
      pkg.registry = skipped(
        unreachable ? "registry unreachable" : "offline",
        pkg.trusted ? null : "named only by site text; cannot verify offline",
      );
      continue;
    }
    try {
      const info = await options.registry.packageInfo(pkg.name);
      if (!info) {
        pkg.registry = failed("no such package on npm", false, null);
        continue;
      }
      infos.set(pkg.name, info);
      const versionOk = resolve(pkg, info, options.cutoffOf(pkg));
      let downloads: number | null = null;
      if (!pkg.trusted) {
        downloads = await options.registry.weeklyDownloads(pkg.name);
        if ((downloads ?? 0) < options.popularityFloor) {
          pkg.registry = failed(
            `named only by site text and below the popularity floor (${downloads ?? 0} < ${options.popularityFloor} weekly downloads)`,
            true,
            versionOk,
            downloads,
          );
          continue;
        }
      }
      pkg.registry = versionOk
        ? {
            status: "passed",
            reason: null,
            exists: true,
            versionPublished: true,
            weeklyDownloads: downloads,
          }
        : failed(`version ${pkg.version ?? "?"} is not published`, true, false, downloads);
    } catch (error) {
      if (!(error instanceof RegistryError) || options.registry.aborted) throw error;
      options.warn(`${error.message}; skipping the remaining registry checks.`);
      unreachable = true;
      pkg.registry = skipped(
        "registry unreachable",
        pkg.trusted ? null : "named only by site text; cannot verify",
      );
    }
  }

  // A failed check outweighs any amount of text evidence: the name or version cannot be trusted.
  for (const pkg of packages) if (pkg.registry?.status === "failed") pkg.confidence = "low";

  // A package another detected package depends on (at its chosen version) is transitive.
  const names = new Set(packages.map((p) => p.name));
  for (const pkg of packages) {
    const info = infos.get(pkg.name);
    const deps = pkg.version ? info?.versions[pkg.version]?.dependencies : undefined;
    for (const dep of deps ?? []) {
      if (!names.has(dep) || dep === pkg.name) continue;
      const target = packages.find((p) => p.name === dep);
      if (target && !target.transitiveOf.includes(pkg.name)) target.transitiveOf.push(pkg.name);
    }
  }
  for (const pkg of packages) {
    for (const parent of pkg.parents) {
      if (names.has(parent) && !pkg.transitiveOf.includes(parent)) pkg.transitiveOf.push(parent);
    }
    pkg.transitiveOf.sort();
  }
}

/** Settle `pkg.version` against the registry. Returns false when no published version fits. */
function resolve(pkg: MergedPackage, info: PackageInfo, cutoff: Date | null): boolean {
  // Try the evidence's versions best first; a planted or mistyped one falls through to the next.
  for (const candidate of pkg.versions) {
    if (parseVersion(candidate.version) && candidate.version in info.versions) {
      if (candidate.version !== pkg.version) pkg.versionSource = "evidence";
      pkg.version = candidate.version;
      return true;
    }
    if (isXRange(candidate.version)) {
      const resolved = resolveVersion(info, cutoff, candidate.version);
      if (resolved) {
        pkg.version = resolved;
        pkg.versionSource = "range";
        return true;
      }
    }
  }
  if (pkg.version && pkg.versionSource === "implied") return pkg.version in info.versions;
  if (pkg.versions.length > 0) return false;
  const resolved = resolveVersion(info, cutoff);
  if (!resolved) return false;
  pkg.version = resolved;
  pkg.versionSource = "inferred";
  return true;
}

function skipped(reason: string, failure: string | null): RegistryCheck {
  return {
    status: failure ? "failed" : "skipped",
    reason: failure ? `${reason}: ${failure}` : reason,
    exists: null,
    versionPublished: null,
    weeklyDownloads: null,
  };
}

function failed(
  reason: string,
  exists: boolean,
  versionPublished: boolean | null,
  weeklyDownloads: number | null = null,
): RegistryCheck {
  return { status: "failed", reason, exists, versionPublished, weeklyDownloads };
}
