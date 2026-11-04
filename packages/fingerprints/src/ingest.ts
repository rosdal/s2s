import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fromHex, type IndexWriter } from "@rosdal/s2s-core/fingerprint";
import { BUILDER_VERSION, type VersionResult } from "./build.js";

export interface IngestSummary {
  packages: number;
  versionsAdded: number;
  /** Versions whose build failed outright (network, unpack); rebuilt on the next run. */
  failed: { name: string; version: string; error: string }[];
}

/** Result files in `<cacheDir>/results`, grouped by package name. */
export async function listResults(cacheDir: string): Promise<Map<string, string[]>> {
  const dir = path.join(cacheDir, "results");
  const out = new Map<string, string[]>();
  for (const file of (await readdir(dir).catch(() => [] as string[])).filter((n) =>
    n.endsWith(".json"),
  )) {
    const stem = file.slice(0, -".json".length);
    // `+` cannot appear in an npm name, so it safely stands in for the scope's `/`.
    const name = stem.slice(0, stem.lastIndexOf("@")).replace("+", "/");
    out.set(name, [...(out.get(name) ?? []), path.join(dir, file)]);
  }
  return out;
}

/**
 * Add build results to an index. A version whose build failed outright is left out so the next
 * run retries it; a version whose entries were all skipped (Node-only code) is added empty, so
 * it is not rebuilt every week.
 */
export async function ingest(
  writer: IndexWriter,
  results: Map<string, string[]>,
  meta: { corpusDate?: string } = {},
): Promise<IngestSummary> {
  const summary: IngestSummary = { packages: 0, versionsAdded: 0, failed: [] };
  // One package in memory at a time: the full corpus's results do not fit at once.
  for (const [name, files] of [...results].sort(([a], [b]) => a.localeCompare(b))) {
    const versions: VersionResult[] = [];
    for (const file of files)
      versions.push(JSON.parse(await readFile(file, "utf8")) as VersionResult);
    const usable = versions.filter((v) => {
      if (v.error) summary.failed.push({ name, version: v.version, error: v.error });
      return !v.error;
    });
    const added = writer.addPackage(
      name,
      usable.map((v) => ({
        name,
        version: v.version,
        functions: v.functions.map(fromHex),
        strings: v.strings.map(fromHex),
        dependencies: v.dependencies ?? [],
      })),
    );
    if (added > 0) summary.packages++;
    summary.versionsAdded += added;
  }
  writer.setMeta({
    builder_version: BUILDER_VERSION,
    ...(meta.corpusDate ? { corpus_date: meta.corpusDate } : {}),
  });
  return summary;
}
