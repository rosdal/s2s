import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { compareVersions } from "@rosdal/s2s-core/fingerprint";
import type { CorpusVersion } from "./build.js";
import type { Fetch } from "./tarball.js";

export const REGISTRY = "https://registry.npmjs.org";

export interface Allowlist {
  /** Packages indexed whatever their downloads. */
  packages: string[];
  /** Scopes whose packages are all candidates (`@radix-ui`). */
  scopes: string[];
}

export interface Denylist {
  packages: string[];
  /** Regular expressions matched against the package name. */
  patterns: string[];
}

/** Weekly downloads a scoped package needs to be indexed through its scope. */
export const SCOPE_FLOOR = 1000;

export interface Candidate {
  name: string;
  weekly: number;
  source: "search" | "allowlist" | "scope";
}

export interface LockedPackage {
  name: string;
  weekly: number;
  versions: { version: string; integrity: string; tarball?: string }[];
}

export interface CorpusLock {
  generated: string;
  rule: string;
  packages: LockedPackage[];
}

/** Keyword searches whose results are mostly code that runs in a browser. */
export const SEARCH_QUERIES = [
  "keywords:react",
  "keywords:vue",
  "keywords:svelte",
  "keywords:preact",
  "keywords:browser",
  "keywords:dom",
  "keywords:frontend",
  "keywords:ui",
  "keywords:component",
  "keywords:animation",
  "keywords:css-in-js",
  "keywords:state-management",
  "keywords:chart",
  "keywords:date",
  "keywords:utility",
  "keywords:util",
  "keywords:functional",
  "keywords:http",
  "keywords:fetch",
  "keywords:validation",
  "keywords:i18n",
  "keywords:router",
  "keywords:form",
  "keywords:markdown",
  "keywords:editor",
  "keywords:map",
  "keywords:3d",
  "keywords:canvas",
  "keywords:svg",
  "keywords:icons",
  "keywords:polyfill",
  "keywords:esm",
];

const STANDARD_TARBALL = (name: string, version: string) =>
  `${REGISTRY}/${name}/-/${name.split("/").pop()}-${version}.tgz`;

export function tarballUrl(name: string, v: { version: string; tarball?: string }): string {
  return v.tarball ?? STANDARD_TARBALL(name, v.version);
}

export function lockToVersions(lock: CorpusLock): CorpusVersion[] {
  return lock.packages.flatMap((p) =>
    p.versions.map((v) => ({
      name: p.name,
      version: v.version,
      integrity: v.integrity,
      tarball: tarballUrl(p.name, v),
    })),
  );
}

export function isDenied(name: string, deny: Denylist): boolean {
  return deny.packages.includes(name) || deny.patterns.some((p) => new RegExp(p).test(name));
}

interface SearchResult {
  objects: { downloads?: { weekly?: number }; package: { name: string } }[];
  total: number;
}

/** npm search, paged; each hit carries its weekly downloads. */
async function search(
  doFetch: Fetch,
  text: string,
  pages: number,
): Promise<{ name: string; weekly: number }[]> {
  const out: { name: string; weekly: number }[] = [];
  for (let page = 0; page < pages; page++) {
    const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(text)}&size=250&from=${page * 250}`;
    const res = await retry(() => doFetch(url));
    if (!res.ok) break;
    const body = (await res.json()) as SearchResult;
    for (const o of body.objects)
      out.push({ name: o.package.name, weekly: o.downloads?.weekly ?? 0 });
    if (body.objects.length < 250) break;
  }
  return out;
}

async function retry(fn: () => Promise<Response>, attempts = 4): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const res = await fn();
      if (res.status !== 429 && res.status < 500) return res;
      if (i >= attempts) return res;
    } catch (error) {
      if (i >= attempts) throw error;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
}

/** Candidates: the search hits and the allowlist, ranked by weekly downloads, denylist applied. */
export async function fetchCandidates(options: {
  allow: Allowlist;
  deny: Denylist;
  fetch?: Fetch;
  pagesPerQuery?: number;
}): Promise<Candidate[]> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const found = new Map<string, Candidate>();
  const add = (name: string, weekly: number, source: Candidate["source"]) => {
    const known = found.get(name);
    if (!known) found.set(name, { name, weekly, source });
    else {
      known.weekly = Math.max(known.weekly, weekly);
      if (source !== "search") known.source = source;
    }
  };
  for (const query of SEARCH_QUERIES)
    for (const hit of await search(doFetch, query, options.pagesPerQuery ?? 4))
      add(hit.name, hit.weekly, "search");
  const weeklyOf = async (name: string) => {
    const res = await retry(() =>
      doFetch(`https://api.npmjs.org/downloads/point/last-week/${name}`),
    );
    return res.ok ? (((await res.json()) as { downloads?: number }).downloads ?? 0) : 0;
  };
  // npm search does not filter by scope reliably; the registry's org listing does.
  for (const scope of options.allow.scopes) {
    const res = await retry(() => doFetch(`${REGISTRY}/-/org/${scope.replace(/^@/, "")}/package`));
    const names = res.ok ? Object.keys((await res.json()) as Record<string, string>) : [];
    for (const name of names.filter((n) => n.startsWith(`${scope}/`)).sort()) {
      const known = found.get(name);
      const weekly = known ? known.weekly : await weeklyOf(name);
      // Abandoned packages of a scope (old prereleases, renamed ones) are not worth a place.
      if (weekly >= SCOPE_FLOOR) add(name, weekly, "scope");
    }
  }
  for (const name of options.allow.packages) {
    if (found.has(name)) {
      (found.get(name) as Candidate).source = "allowlist";
      continue;
    }
    add(name, await weeklyOf(name), "allowlist");
  }
  return [...found.values()]
    .filter((c) => !isDenied(c.name, options.deny))
    .sort((a, b) => b.weekly - a.weekly || a.name.localeCompare(b.name));
}

interface PackumentVersion {
  version: string;
  deprecated?: string;
  dist?: { tarball?: string; integrity?: string; shasum?: string };
  browser?: unknown;
  module?: string;
  exports?: unknown;
  type?: string;
  main?: string;
  bin?: unknown;
  types?: string;
  typings?: string;
}

export interface Packument {
  name: string;
  "dist-tags"?: { latest?: string };
  versions: Record<string, PackumentVersion>;
  time?: Record<string, string>;
}

/** A full packument (with publish times), cached gzipped on disk for a day. */
export async function fetchPackument(
  name: string,
  cacheDir: string,
  doFetch: Fetch,
): Promise<Packument | undefined> {
  const file = path.join(cacheDir, "packuments", `${name.replace("/", "+")}.json.gz`);
  try {
    const cached = JSON.parse(gunzipSync(await readFile(file)).toString("utf8")) as {
      at: number;
      doc: Packument;
    };
    if (Date.now() - cached.at < 86_400_000) return cached.doc;
  } catch {
    // Not cached.
  }
  const res = await retry(() => doFetch(`${REGISTRY}/${name.replace("/", "%2f")}`));
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GET ${name} returned ${res.status}`);
  const full = (await res.json()) as Packument;
  // Keep only what the corpus needs; full packuments of busy packages run to many megabytes.
  const doc: Packument = {
    name: full.name,
    versions: {},
    ...(full.time ? { time: full.time } : {}),
  };
  if (full["dist-tags"]) doc["dist-tags"] = full["dist-tags"];
  for (const [v, meta] of Object.entries(full.versions ?? {})) {
    const keep: PackumentVersion = { version: v };
    for (const key of [
      "deprecated",
      "browser",
      "module",
      "exports",
      "type",
      "main",
      "bin",
      "types",
      "typings",
    ] as const)
      if (meta[key] !== undefined) (keep as unknown as Record<string, unknown>)[key] = meta[key];
    if (meta.dist)
      keep.dist = Object.fromEntries(
        Object.entries(meta.dist).filter(([k]) => ["tarball", "integrity", "shasum"].includes(k)),
      );
    doc.versions[v] = keep;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, gzipSync(JSON.stringify({ at: Date.now(), doc })));
  return doc;
}

/**
 * True when a version looks like browser code: a `browser`, `module` or ESM `exports` entry, or
 * `type: module`. Types-only packages and CLIs without a library entry are not.
 */
export function shipsBrowserCode(v: PackumentVersion): boolean {
  const typesOnly = !v.main && !v.module && !v.exports && !v.browser && (v.types || v.typings);
  if (typesOnly) return false;
  if (v.browser || v.module || v.type === "module") return true;
  const conditions = JSON.stringify(v.exports ?? null);
  // A plain CommonJS `main` is as likely a Node module as a browser one; the browser libraries
  // that ship that way (lodash, jquery, moment) are on the allowlist instead.
  // An ESM entry counts unless the package also splits off a Node build without a browser one.
  if (/"browser"/.test(conditions)) return true;
  return /"(?:import|module)"/.test(conditions) && !/"node"/.test(conditions);
}

const DAY = 86_400_000;

/**
 * The corpus rule: every stable version published in the last three years, plus the newest
 * stable release of each older major. Prereleases are left out.
 */
export function selectVersions(doc: Packument, now: Date, years = 3): string[] {
  const cutoff = now.getTime() - years * 365 * DAY;
  const stable = Object.keys(doc.versions).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const published = (v: string) => Date.parse(doc.time?.[v] ?? "") || 0;
  const recent = stable.filter((v) => published(v) >= cutoff);
  const newestPerMajor = new Map<number, string>();
  for (const v of stable) {
    const major = Number(v.split(".")[0]);
    const known = newestPerMajor.get(major);
    if (!known || compareVersions(v, known) > 0) newestPerMajor.set(major, v);
  }
  const old = [...newestPerMajor.values()].filter((v) => published(v) < cutoff);
  return [...new Set([...recent, ...old])].sort(compareVersions);
}

/** Resolve candidates into `corpus.lock.json`: up to `limit` browser packages, their versions and integrity. */
export async function lockCorpus(options: {
  candidates: Candidate[];
  cacheDir: string;
  limit: number;
  now?: Date;
  /** Cap per package, newest kept; for small local pilots. The published corpus uses no cap. */
  maxVersions?: number;
  fetch?: Fetch;
  onProgress?: (message: string) => void;
}): Promise<CorpusLock> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? new Date();
  const packages: LockedPackage[] = [];
  // Allowlisted ecosystems are always in; search hits fill the remaining places by downloads.
  const queue = [
    ...options.candidates.filter((c) => c.source !== "search"),
    ...options.candidates.filter((c) => c.source === "search"),
  ];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length > 0 && packages.length < options.limit) {
      const candidate = queue.shift() as Candidate;
      let doc: Packument | undefined;
      try {
        doc = await fetchPackument(candidate.name, options.cacheDir, doFetch);
      } catch (error) {
        options.onProgress?.(`skip ${candidate.name}: ${(error as Error).message}`);
        continue;
      }
      const latest = doc?.versions[doc["dist-tags"]?.latest ?? ""];
      if (!doc || !latest) continue;
      if (candidate.source === "search" && !shipsBrowserCode(latest)) {
        options.onProgress?.(`skip ${candidate.name}: no browser entry`);
        continue;
      }
      let versions = selectVersions(doc, now);
      if (options.maxVersions) versions = versions.slice(-options.maxVersions);
      const locked = versions.flatMap((version) => {
        const dist = doc.versions[version]?.dist;
        // Very old versions carry only a SHA-1 shasum; it is turned into an SRI string.
        const integrity =
          dist?.integrity ??
          (dist?.shasum ? `sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}` : undefined);
        if (!dist || !integrity) return [];
        const entry: LockedPackage["versions"][number] = { version, integrity };
        if (dist.tarball && dist.tarball !== STANDARD_TARBALL(doc.name, version))
          entry.tarball = dist.tarball;
        return [entry];
      });
      if (locked.length === 0) continue;
      if (packages.length < options.limit)
        packages.push({ name: doc.name, weekly: candidate.weekly, versions: locked });
      options.onProgress?.(
        `${packages.length}/${options.limit} ${doc.name} (${locked.length} versions)`,
      );
    }
  });
  await Promise.all(workers);
  packages.sort((a, b) => b.weekly - a.weekly || a.name.localeCompare(b.name));
  return {
    generated: now.toISOString().slice(0, 10),
    rule: "stable versions from the last 3 years plus the newest release of each older major",
    packages,
  };
}
