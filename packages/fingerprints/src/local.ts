import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheRoot, fingerprintDir, IndexWriter, OVERLAY_FILE } from "@rosdal/s2s-core/fingerprint";
import { buildVersion, type CorpusVersion, type VersionResult } from "./build.js";
import { fetchPackument, selectVersions, tarballUrl, withTimeout } from "./corpus.js";
import { type Fetch, unpackTarball } from "./tarball.js";

export interface LocalBuildOptions {
  /** `name`, `name@version` or `name@range` (`4.x`, `^4.17.0`, `~1.2.0`, `*`). */
  specs?: string[];
  /** Local `.tgz` files, for private packages that are not on the registry. */
  tarballs?: string[];
  /** The overlay to write; defaults to `local-overlay.sqlite` in the fingerprint folder. */
  out?: string;
  cacheDir?: string;
  fetch?: Fetch;
  onProgress?: (message: string) => void;
}

export interface LocalBuildResult {
  out: string;
  versions: {
    name: string;
    version: string;
    functions: number;
    skipped: number;
    error: string | null;
  }[];
}

/** Does `version` satisfy a simple range: exact, x-range, caret, tilde or `*`. */
export function satisfies(version: string, range: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [ma, mi, pa] = version.split(".").map(Number) as [number, number, number];
  const r = range.trim();
  if (r === "" || r === "*" || r === "x" || r === "latest") return true;
  const x = /^(\d+)(?:\.(\d+|x))?(?:\.(x))?$/.exec(r);
  if (x) return ma === Number(x[1]) && (x[2] === undefined || x[2] === "x" || mi === Number(x[2]));
  const m = /^([~^])?(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (!m) return false;
  const [b0, b1, b2] = [Number(m[2]), Number(m[3]), Number(m[4])];
  const atLeast = ma > b0 || (ma === b0 && (mi > b1 || (mi === b1 && pa >= b2)));
  if (!m[1]) return ma === b0 && mi === b1 && pa === b2;
  if (m[1] === "~") return atLeast && ma === b0 && mi === b1;
  return (
    atLeast &&
    (b0 > 0 ? ma === b0 : b1 > 0 ? ma === 0 && mi === b1 : ma === 0 && mi === 0 && pa === b2)
  );
}

function splitSpec(spec: string): { name: string; range: string | null } {
  const at = spec.lastIndexOf("@");
  return at > 0
    ? { name: spec.slice(0, at), range: spec.slice(at + 1) }
    : { name: spec, range: null };
}

/**
 * `s2s db build`: fingerprint packages into a local overlay that the matcher reads next to the
 * shared index. Registry packages follow the corpus rule unless a version or range is given.
 */
export async function buildLocal(options: LocalBuildOptions): Promise<LocalBuildResult> {
  const out = options.out ?? path.join(fingerprintDir(), OVERLAY_FILE);
  const cacheDir = options.cacheDir ?? path.join(cacheRoot(), "fingerprint-build");
  const doFetch: Fetch = withTimeout(options.fetch ?? ((url, init) => fetch(url, init)));
  const progress = options.onProgress ?? (() => {});
  const results: VersionResult[] = [];

  for (const spec of options.specs ?? []) {
    const { name, range } = splitSpec(spec);
    const doc = await fetchPackument(name, cacheDir, doFetch);
    if (!doc) throw new Error(`${name} is not on the npm registry.`);
    const versions =
      range === null
        ? selectVersions(doc, new Date())
        : Object.keys(doc.versions).filter((v) =>
            satisfies(v, range === "latest" ? (doc["dist-tags"]?.latest ?? "") : range),
          );
    if (versions.length === 0) throw new Error(`No version of ${name} matches ${range}.`);
    for (const version of versions) {
      const dist = doc.versions[version]?.dist;
      if (!dist?.integrity) continue;
      const entry: CorpusVersion = {
        name,
        version,
        integrity: dist.integrity,
        tarball: tarballUrl(name, { version, ...(dist.tarball ? { tarball: dist.tarball } : {}) }),
      };
      progress(`building ${name}@${version}`);
      results.push(await buildVersion(entry, { cacheDir, fetch: doFetch }));
    }
  }

  for (const file of options.tarballs ?? []) {
    const bytes = new Uint8Array(await readFile(file));
    const dir = await mkdtemp(path.join(tmpdir(), "s2s-tgz-"));
    let pkg: { name?: string; version?: string };
    try {
      await unpackTarball(bytes, dir);
      pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (!pkg.name || !pkg.version) throw new Error(`${file} has no package.json name and version.`);
    progress(`building ${pkg.name}@${pkg.version} from ${path.basename(file)}`);
    results.push(
      await buildVersion(
        { name: pkg.name, version: pkg.version, integrity: "", tarball: "" },
        { cacheDir, tarballBytes: bytes },
      ),
    );
  }

  await mkdir(path.dirname(out), { recursive: true });
  const writer = new IndexWriter(out);
  try {
    const byName = new Map<string, VersionResult[]>();
    for (const r of results) if (!r.error) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
    for (const [name, list] of byName)
      writer.addPackage(
        name,
        list.map((r) => ({
          name,
          version: r.version,
          functions: r.functions.map((h) => BigInt(`0x${h}`)),
          strings: r.strings.map((h) => BigInt(`0x${h}`)),
          dependencies: r.dependencies,
        })),
      );
    writer.setMeta({ corpus_date: new Date().toISOString().slice(0, 10), overlay: "true" });
  } finally {
    writer.close();
  }
  return {
    out,
    versions: results.map((r) => ({
      name: r.name,
      version: r.version,
      functions: r.functions.length,
      skipped: r.entries.filter((e) => e.status === "skipped").length,
      error: r.error,
    })),
  };
}
