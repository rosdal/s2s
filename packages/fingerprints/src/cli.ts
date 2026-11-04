import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { constants, createZstdCompress } from "node:zlib";
import { FingerprintIndex, IndexWriter, sizeReport } from "@rosdal/s2s-core/fingerprint";
import {
  type Allowlist,
  type Candidate,
  type CorpusLock,
  type Denylist,
  fetchCandidates,
  lockCorpus,
  lockToVersions,
} from "./corpus.js";
import { ingest, listResults } from "./ingest.js";
import { runBuilds } from "./pool.js";
import { shard } from "./shard.js";

const USAGE = `s2s-fingerprints <command> [options]

  candidates [--corpus <dir>]                    rank candidate packages (writes candidates.json)
  lock [--corpus <dir>] [--limit 1000] [--max-versions n]
                                                 resolve versions into corpus.lock.json
  build [--corpus <dir>] [--cache <dir>] [--shard i/n] [--skip-index <file>]
        [--concurrency n] [--packages a,b]       fingerprint package versions (resumable)
  merge --out <file> [--cache <dir>] [--base <file>] [--corpus-date YYYY-MM-DD] [--packages a,b]
                                                 add build results to an index
  report --index <file> [--top 30]               per-package size report
  pack --index <file> --out <dir>                zstd-compress and write a SHA-256 file
`;

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      corpus: { type: "string", default: "packages/fingerprints/corpus" },
      cache: { type: "string", default: ".fingerprint-cache" },
      limit: { type: "string", default: "1000" },
      "max-versions": { type: "string" },
      shard: { type: "string" },
      "skip-index": { type: "string" },
      concurrency: { type: "string" },
      packages: { type: "string" },
      out: { type: "string" },
      base: { type: "string" },
      index: { type: "string" },
      top: { type: "string", default: "30" },
      "corpus-date": { type: "string" },
    },
  });
  const corpus = values.corpus;
  const cache = path.resolve(values.cache);
  const log = (line: string) => process.stderr.write(`${line}\n`);

  switch (command) {
    case "candidates": {
      const allow = await readJson<Allowlist>(path.join(corpus, "allowlist.json"));
      const deny = await readJson<Denylist>(path.join(corpus, "denylist.json"));
      const candidates = await fetchCandidates({ allow, deny });
      await writeFile(
        path.join(corpus, "candidates.json"),
        `${JSON.stringify(candidates, null, 1)}\n`,
      );
      log(`${candidates.length} candidates`);
      return 0;
    }
    case "lock": {
      const candidates = await readJson<Candidate[]>(path.join(corpus, "candidates.json"));
      const lock = await lockCorpus({
        candidates,
        cacheDir: cache,
        limit: Number(values.limit),
        ...(values["max-versions"] ? { maxVersions: Number(values["max-versions"]) } : {}),
        onProgress: log,
      });
      // One package per line: compact, and a weekly refresh diffs line by line.
      const body = lock.packages.map((p) => JSON.stringify(p)).join(",\n");
      await writeFile(
        path.join(corpus, "corpus.lock.json"),
        `{"generated":${JSON.stringify(lock.generated)},"rule":${JSON.stringify(lock.rule)},"packages":[\n${body}\n]}\n`,
      );
      const count = lock.packages.reduce((n, p) => n + p.versions.length, 0);
      log(`${lock.packages.length} packages, ${count} versions`);
      return 0;
    }
    case "build": {
      const lock = await readJson<CorpusLock>(path.join(corpus, "corpus.lock.json"));
      let versions = lockToVersions(lock);
      if (values.packages) {
        const only = new Set(values.packages.split(","));
        versions = versions.filter((v) => only.has(v.name));
      }
      if (values["skip-index"]) {
        // Incremental: only versions the previous index does not have yet.
        const index = FingerprintIndex.open(values["skip-index"]);
        const known = new Set(
          [...index.packages.values()].flatMap((p) => p.versions.map((v) => `${p.name}@${v}`)),
        );
        index.close();
        versions = versions.filter((v) => !known.has(`${v.name}@${v.version}`));
      }
      if (values.shard) {
        const [i, n] = values.shard.split("/").map(Number) as [number, number];
        versions = shard(versions, i, n);
      }
      log(`building ${versions.length} versions`);
      const started = Date.now();
      const summaries = await runBuilds(versions, {
        cacheDir: cache,
        ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
        onResult: (s, done, total) => {
          const skipped = s.entries.filter((e) => e.status === "skipped");
          const reasons = [...new Set(skipped.map((e) => e.reason))].join(",");
          log(
            `[${done}/${total}] ${s.name}@${s.version} ${s.cached ? "cached" : `${s.ms}ms`} ${s.functionCount} fns` +
              (skipped.length ? ` (${skipped.length} entries skipped: ${reasons})` : "") +
              (s.error ? ` ERROR ${s.error}` : ""),
          );
        },
      });
      const failed = summaries.filter((s) => s.error);
      log(`done in ${Math.round((Date.now() - started) / 1000)}s; ${failed.length} failed`);
      return 0;
    }
    case "merge": {
      if (!values.out) throw new Error("--out is required");
      const out = values.out;
      await mkdir(path.dirname(path.resolve(out)), { recursive: true });
      if (values.base) await copyFile(values.base, out);
      const writer = new IndexWriter(out);
      const results = await listResults(cache);
      if (values.packages) {
        const only = new Set(values.packages.split(","));
        for (const name of [...results.keys()]) if (!only.has(name)) results.delete(name);
      }
      const summary = await ingest(writer, results, {
        corpusDate: values["corpus-date"] ?? new Date().toISOString().slice(0, 10),
      });
      writer.close({ vacuum: true });
      log(
        `added ${summary.versionsAdded} versions of ${summary.packages} packages; ${summary.failed.length} failed builds left out`,
      );
      for (const f of summary.failed.slice(0, 20))
        log(`  failed ${f.name}@${f.version}: ${f.error}`);
      return 0;
    }
    case "report": {
      if (!values.index) throw new Error("--index is required");
      const report = sizeReport(values.index);
      const total = report.reduce((n, r) => n + r.postingBytes, 0) || 1;
      process.stdout.write("package\tversions\tfunctions\tstrings\tbytes\tshare\n");
      for (const r of report.slice(0, Number(values.top)))
        process.stdout.write(
          `${r.name}\t${r.versions}\t${r.functions}\t${r.strings}\t${r.postingBytes}\t${((100 * r.postingBytes) / total).toFixed(1)}%\n`,
        );
      log(`${report.length} packages, ${(await stat(values.index)).size} bytes on disk`);
      return 0;
    }
    case "pack": {
      if (!values.index || !values.out) throw new Error("--index and --out are required");
      await mkdir(values.out, { recursive: true });
      const target = path.join(values.out, `${path.basename(values.index)}.zst`);
      await pipeline(
        createReadStream(values.index),
        createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 19 } }),
        createWriteStream(target),
      );
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
      const digest = hash.digest("hex");
      await writeFile(`${target}.sha256`, `${digest}  ${path.basename(target)}\n`);
      log(`${target}: ${(await stat(target)).size} bytes, sha256 ${digest}`);
      return 0;
    }
    default:
      process.stdout.write(USAGE);
      return command ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${(error as Error).stack ?? error}\n`);
    process.exitCode = 1;
  },
);
