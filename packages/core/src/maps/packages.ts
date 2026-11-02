export type PackageLayout = "pnpm" | "yarn-pnp" | "node_modules";

export interface VendorPackage {
  name: string;
  /** Exact version when the path carries it (pnpm store, Yarn cache), otherwise `null`. */
  version: string | null;
  /** The package this one is nested under (`node_modules/a/node_modules/b` gives `a`). */
  parent: string | null;
  layout: PackageLayout;
}

const STORE_VERSION = /^(?<name>@[^@/]+\+[^@/]+|[^@/]+)@(?<version>[^_(]+)/;
// `<name>-npm-<version>-<checksum>[-<cache key>].zip`; the checksums are hex.
const YARN_ARCHIVE = /^(?<flat>.+?)-npm-(?<version>.+?)(?:-[0-9a-f]{8,})+(?:\.zip)?$/;

/**
 * Read the package a vendor source belongs to from its path. Handles npm and Yarn classic
 * (`node_modules/<name>`), pnpm (`node_modules/.pnpm/<name>@<version>/node_modules/<name>`),
 * Yarn PnP (`.yarn/cache/<name>-npm-<version>-<hash>.zip/node_modules/<name>`) and nesting.
 */
export function parseVendorPath(path: string): VendorPackage | undefined {
  const segments = path.split("/");
  const chain: string[] = [];
  let layout: PackageLayout = "node_modules";
  let store: { name: string; version: string } | undefined;
  let storeOwner: number | undefined;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const next = segments[i + 1];
    if (segment === ".yarn" && (next === "cache" || next === "unplugged")) {
      const archive = segments[i + 2];
      const match = archive ? YARN_ARCHIVE.exec(archive) : null;
      if (match?.groups) {
        layout = "yarn-pnp";
        store = { name: match.groups.flat ?? "", version: match.groups.version ?? "" };
        storeOwner = chain.length;
      }
      i += 2;
      continue;
    }
    if (segment !== "node_modules" || next === undefined) continue;
    if (next === ".pnpm") {
      const dir = segments[i + 2];
      const match = dir ? STORE_VERSION.exec(dir) : null;
      if (match?.groups) {
        layout = "pnpm";
        store = {
          name: (match.groups.name ?? "").replace("+", "/"),
          version: match.groups.version ?? "",
        };
        storeOwner = chain.length;
      }
      i += 2;
      continue;
    }
    // Tool caches (`.vite`, `.cache`) are not packages.
    if (next.startsWith(".")) return undefined;
    if (next.startsWith("@")) {
      const scoped = segments[i + 2];
      if (!scoped || i + 3 >= segments.length) return undefined;
      chain.push(`${next}/${scoped}`);
      i += 2;
    } else {
      if (i + 2 >= segments.length) return undefined;
      chain.push(next);
      i += 1;
    }
  }

  const name = chain.at(-1);
  if (!name) return undefined;
  let version: string | null = null;
  // The store folder versions the first package after it, and only if the names agree.
  if (store && storeOwner === chain.length - 1) {
    const flat = layout === "yarn-pnp" ? name.replace("/", "-") : name;
    if (store.name === flat) version = store.version;
  }
  return { name, version, parent: chain.at(-2) ?? null, layout };
}

export interface PackageManagerHint {
  value: "pnpm" | "yarn" | "npm";
  confidence: number;
  evidence: string[];
}

/** Guess the package manager from the vendor path shapes seen; `undefined` when there were none. */
export function detectPackageManager(
  packages: { layout: PackageLayout; path: string }[],
): PackageManagerHint | undefined {
  if (packages.length === 0) return undefined;
  const pick = (layout: PackageLayout) =>
    packages
      .filter((p) => p.layout === layout)
      .map((p) => p.path)
      .slice(0, 3);
  if (packages.some((p) => p.layout === "pnpm"))
    return { value: "pnpm", confidence: 0.95, evidence: pick("pnpm") };
  if (packages.some((p) => p.layout === "yarn-pnp"))
    return { value: "yarn", confidence: 0.95, evidence: pick("yarn-pnp") };
  // npm and Yarn classic lay out node_modules the same way, so this is only a default.
  return { value: "npm", confidence: 0.4, evidence: pick("node_modules") };
}
