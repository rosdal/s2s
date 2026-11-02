function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface CdnPackageHit {
  name: string;
  /** Exact version or range from the URL; `null` when the URL is unversioned (latest). */
  version: string | null;
  cdn: "jsdelivr" | "unpkg" | "cdnjs" | "esm.sh" | "skypack";
  /** `cdnjs` library names are not always npm names. */
  registry: "npm" | "cdnjs";
  /** File path inside the package, if the URL names one. */
  file: string | null;
}

// `name@version` or `@scope/name@version`, followed by an optional `/path`.
const NPM_SPEC = /^((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?(\/.*)?$/;

function npmSpec(spec: string, cdn: CdnPackageHit["cdn"]): CdnPackageHit | undefined {
  const match = NPM_SPEC.exec(spec);
  if (!match?.[1]) return undefined;
  const name = decode(match[1]);
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return undefined;
  const file = match[3] && match[3] !== "/" ? match[3] : null;
  return {
    name,
    version: match[2] ? decode(match[2]) : null,
    cdn,
    registry: "npm",
    file,
  };
}

/**
 * Read package names and versions out of public CDN URLs: jsdelivr (`/npm/` and `/combine/`),
 * unpkg, cdnjs, esm.sh and skypack. Returns every package the URL names (combine URLs name
 * several), or an empty list.
 */
export function parseCdnUrl(input: string): CdnPackageHit[] {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return [];
  }
  const host = url.hostname;
  const path = url.pathname;

  if (host === "cdn.jsdelivr.net" || host === "fastly.jsdelivr.net") {
    if (path.startsWith("/npm/")) {
      const hit = npmSpec(path.slice(5), "jsdelivr");
      return hit ? [hit] : [];
    }
    if (path.startsWith("/combine/")) {
      return path
        .slice(9)
        .split(",")
        .filter((part) => part.startsWith("npm/"))
        .flatMap((part) => npmSpec(part.slice(4), "jsdelivr") ?? []);
    }
    return [];
  }

  if (host === "unpkg.com") {
    const hit = npmSpec(path.slice(1), "unpkg");
    return hit ? [hit] : [];
  }

  if (host === "cdnjs.cloudflare.com") {
    const match = /^\/ajax\/libs\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!match?.[1] || !match[2]) return [];
    return [
      {
        name: match[1],
        version: match[2],
        cdn: "cdnjs",
        registry: "cdnjs",
        file: match[3] ?? null,
      },
    ];
  }

  if (host === "esm.sh") {
    // Optional build prefixes: /v135/, /stable/, /gh/ (not npm).
    const rest = path.replace(/^\/(?:v\d+|stable)\//, "/").slice(1);
    if (rest.startsWith("gh/") || rest === "") return [];
    const spec = rest.startsWith("*") ? rest.slice(1) : rest;
    const hit = npmSpec(spec, "esm.sh");
    return hit ? [hit] : [];
  }

  if (host === "cdn.skypack.dev") {
    // Pinned URLs look like /-/name@1.2.3-hash/dist=es2020,mode=imports/optimized/name.js
    const pinned = /^\/-\/((?:@[^/]+\/)?[^/@]+)@([^/]+?)-[A-Za-z0-9]{20}(\/.*)?$/.exec(path);
    if (pinned?.[1] && pinned[2]) {
      return [
        {
          name: pinned[1],
          version: pinned[2],
          cdn: "skypack",
          registry: "npm",
          file: pinned[3] ?? null,
        },
      ];
    }
    if (path.startsWith("/-/") || path.startsWith("/new/") || path.startsWith("/error/")) {
      return [];
    }
    const hit = npmSpec(path.slice(1), "skypack");
    return hit ? [hit] : [];
  }

  return [];
}

export interface CdnPackageEntry {
  name: string;
  version: string | null;
  registry: "npm" | "cdnjs";
  cdns: string[];
  urls: string[];
}

/** Group hits from many URLs by package name and version. */
export function collectCdnPackages(urls: Iterable<string>): CdnPackageEntry[] {
  const byKey = new Map<string, CdnPackageEntry>();
  for (const url of urls) {
    for (const hit of parseCdnUrl(url)) {
      const key = `${hit.registry}:${hit.name}@${hit.version ?? ""}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          name: hit.name,
          version: hit.version,
          registry: hit.registry,
          cdns: [],
          urls: [],
        };
        byKey.set(key, entry);
      }
      if (!entry.cdns.includes(hit.cdn)) entry.cdns.push(hit.cdn);
      if (!entry.urls.includes(url)) entry.urls.push(url);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.name === b.name
      ? String(a.version).localeCompare(String(b.version))
      : a.name.localeCompare(b.name),
  );
}
