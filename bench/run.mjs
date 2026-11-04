// s2s fingerprint benchmark. Generates apps with a known answer key, builds them several ways
// (one held-out configuration the index never saw), matches them with the fingerprint collector
// alone, and scores the result. See docs/fingerprints.md.
//
//   node bench/run.mjs --index <file.sqlite> [--apps 30] [--seed 1] [--builds a,b] [--out file]
//                      [--compare baseline.json] [--fixtures] [--table]
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FingerprintIndex, matchBundles } from "@rosdal/s2s-core/fingerprint";
import { BUILDS, runBuild } from "./builds.mjs";
import { existingApp, generateApp } from "./generate.mjs";
import { aggregate, answerKey, sameMinor, scoreBuild } from "./score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    index: { type: "string" },
    apps: { type: "string", default: "30" },
    seed: { type: "string", default: "1" },
    builds: { type: "string", default: Object.keys(BUILDS).join(",") },
    out: { type: "string" },
    work: { type: "string", default: path.join(here, ".work") },
    "min-chars": { type: "string", default: "2000" },
    pool: { type: "string" },
    compare: { type: "string" },
    fixtures: { type: "boolean", default: false },
    // Reuse apps a previous run generated with the same seed, skipping their npm installs.
    reuse: { type: "boolean", default: false },
    table: { type: "string" },
  },
});

const log = (line) => process.stderr.write(`${line}\n`);

/** Metrics the CI gate watches; a drop of more than 2 points in any of them fails the run. */
const GATED = [
  ["medium", "precision"],
  ["medium", "recall"],
  ["low", "precision"],
  ["low", "recall"],
  ["exactVersion"],
  ["sameMinor"],
  ["vendorIoU"],
];
const get = (obj, keys) => keys.reduce((o, k) => (o == null ? o : o[k]), obj);

export function regressions(current, baseline, tolerance = 0.02) {
  const out = [];
  for (const scope of ["overall", "heldOut"]) {
    for (const keys of GATED) {
      const was = get(baseline[scope], keys);
      const now = get(current[scope], keys);
      if (typeof was === "number" && typeof now === "number" && was - now > tolerance)
        out.push(`${scope}.${keys.join(".")}: ${was} -> ${now}`);
    }
  }
  return out;
}

export function markdownTable(results) {
  const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
  const rows = [
    "| Build | Precision (medium+) | Recall (medium+) | Precision (all) | Recall (all) | Exact version | Same minor | Vendor IoU | ms/MB |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const row = (name, m) =>
    `| ${name} | ${pct(m.medium.precision)} | ${pct(m.medium.recall)} | ${pct(m.low.precision)} | ${pct(m.low.recall)} | ${pct(m.exactVersion)} | ${pct(m.sameMinor)} | ${pct(m.vendorIoU)} | ${m.msPerMB ?? "–"} |`;
  for (const [name, m] of Object.entries(results.byBuild))
    rows.push(row(name === "heldout" ? "heldout (never indexed)" : name, m));
  rows.push(row("**all**", results.overall));
  return rows.join("\n");
}

async function main() {
  if (values.table) {
    process.stdout.write(`${markdownTable(JSON.parse(await readFile(values.table, "utf8")))}\n`);
    return 0;
  }
  if (!values.index) throw new Error("--index <file.sqlite> is required");
  const index = FingerprintIndex.open(values.index);
  const indexed = new Map(
    [...index.packages.values()].map((p) => [p.name, p.versions.filter(Boolean)]),
  );
  const only = values.pool ? new Set(values.pool.split(",")) : undefined;
  const pool = [...indexed]
    .filter(([name, versions]) => versions.length > 0 && (!only || only.has(name)))
    .map(([name, versions]) => ({
      name,
      versions: versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v)),
    }))
    .filter((p) => p.versions.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const builds = values.builds.split(",");
  const minChars = Number(values["min-chars"]);
  const apps = Number(values.apps);
  const seed = Number(values.seed);
  log(
    `index ${values.index}: ${indexed.size} packages; pool ${pool.length}; ${apps} apps × ${builds.join(", ")}`,
  );

  const scores = Object.fromEntries(builds.map((b) => [b, []]));
  const failures = [];
  const details = [];
  for (let i = 0; i < apps; i++) {
    const appSeed = seed * 1000 + i;
    const dir = path.join(values.work, `app-${appSeed}`);
    let app;
    try {
      app =
        (values.reuse && (await existingApp(appSeed, dir))) ||
        (await generateApp({ seed: appSeed, pool, dir }));
    } catch (error) {
      failures.push({
        app: appSeed,
        stage: "generate",
        error: String(error.message ?? error).slice(0, 300),
      });
      log(`app ${appSeed}: generate failed: ${error.message}`);
      continue;
    }
    for (const build of builds) {
      try {
        const bundles = await runBuild(build, dir);
        const key = await answerKey(dir, bundles);
        const result = await matchBundles(
          bundles.map((b) => ({ id: b.file, url: path.basename(b.file), text: b.code })),
          [index],
        );
        const score = scoreBuild({ key, result, indexed, minChars });
        scores[build].push(score);
        details.push({
          app: appSeed,
          build,
          direct: app.direct,
          missed: score.levels.medium.missed,
          falsePositives: score.levels.low.falsePositives,
          versions: result.packages
            .filter((p) => key.packages.has(p.name))
            .map((p) => ({
              name: p.name,
              reported: p.version,
              truth: [...(key.packages.get(p.name)?.versions ?? [])],
              confident: p.confident,
              minorOk: sameMinor(p.version, key.packages.get(p.name)?.versions ?? []),
            })),
        });
        log(
          `app ${appSeed} ${build}: tp ${score.levels.medium.tp} fp ${score.levels.medium.fp} fn ${score.levels.medium.fn} ` +
            `| low fp ${score.levels.low.fp} | ${score.versions.exact}/${score.versions.versioned} exact | ${score.ms}ms`,
        );
      } catch (error) {
        failures.push({
          app: appSeed,
          stage: build,
          error: String(error.message ?? error).slice(0, 300),
        });
        log(`app ${appSeed} ${build}: failed: ${String(error.message ?? error).split("\n")[0]}`);
      }
    }
  }

  const results = {
    generated: new Date().toISOString().slice(0, 10),
    seed,
    apps,
    minChars,
    index: {
      corpusDate: index.meta.corpusDate,
      packages: indexed.size,
      versions: [...indexed.values()].reduce((n, v) => n + v.length, 0),
    },
    overall: aggregate(Object.values(scores).flat()),
    heldOut: scores.heldout ? aggregate(scores.heldout) : null,
    byBuild: Object.fromEntries(Object.entries(scores).map(([b, s]) => [b, aggregate(s)])),
    failures: failures.length,
  };
  if (values.fixtures) results.fixtures = await fixtureSpotChecks(index, indexed);
  index.close();

  if (values.out) {
    await writeFile(values.out, `${JSON.stringify(results, null, 2)}\n`);
    await writeFile(
      values.out.replace(/\.json$/, ".details.json"),
      `${JSON.stringify({ failures, details }, null, 2)}\n`,
    );
  }
  process.stdout.write(`${markdownTable(results)}\n`);
  if (values.compare) {
    const baseline = JSON.parse(await readFile(values.compare, "utf8"));
    const was = baseline.index?.packages ?? 0;
    if (Math.abs(was - results.index.packages) > Math.max(5, 0.1 * was)) {
      log(
        `Baseline was measured on an index of ${was} packages, this run on ${results.index.packages}; not comparable, so not gated. Commit this run's results as the new baseline.`,
      );
      return 0;
    }
    const dropped = regressions(results, baseline);
    if (dropped.length > 0) {
      log(`Benchmark regressed by more than 2 points:\n  ${dropped.join("\n  ")}`);
      return 1;
    }
    log("No metric dropped more than 2 points.");
  }
  return 0;
}

/**
 * Real-site spot checks: the fixture sites from earlier todos ship known package.json files.
 * Each built fixture is matched like a captured site, and scored against its dependencies.
 */
async function fixtureSpotChecks(index, indexed) {
  const root = path.join(here, "..", "fixtures");
  const out = [];
  for (const name of (await readdir(root)).sort()) {
    const dir = path.join(root, name);
    const manifest = path.join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const deps = Object.keys(JSON.parse(await readFile(manifest, "utf8")).dependencies ?? {});
    const key = deps.filter((d) => indexed.has(d));
    if (key.length === 0) continue;
    const files = [];
    for (const sub of ["dist", "out", "build", ".next/static"]) {
      const base = path.join(dir, sub);
      if (!existsSync(base)) continue;
      for (const f of await readdir(base, { recursive: true }))
        if (f.endsWith(".js")) files.push(path.join(base, f));
    }
    if (files.length === 0) continue;
    const bundles = [];
    for (const file of files)
      bundles.push({ id: file, url: file, text: await readFile(file, "utf8") });
    const result = await matchBundles(bundles, [index]);
    // Anything installed for the fixture counts as a right answer, transitive packages too;
    // pnpm keeps them in the workspace root's store.
    const store = [
      ...(await readdir(path.join(dir, "node_modules", ".pnpm")).catch(() => [])),
      ...(await readdir(path.join(root, "..", "node_modules", ".pnpm")).catch(() => [])),
    ];
    const installed = new Set(
      store.map((d) => d.replace(/@[^@_]+(?:_.*)?$/, "").replace(/\+/g, "/")),
    );
    for (const d of deps) installed.add(d);
    const versionOf = async (dep) => {
      try {
        return JSON.parse(
          await readFile(path.join(dir, "node_modules", dep, "package.json"), "utf8"),
        ).version;
      } catch {
        return null;
      }
    };
    const found = result.packages.map((p) => p.name);
    out.push({
      fixture: name,
      key: await Promise.all(key.map(async (k) => ({ name: k, version: await versionOf(k) }))),
      found: await Promise.all(
        result.packages.map(async (p) => ({
          name: p.name,
          version: p.version,
          confident: p.confident,
          correct: installed.has(p.name),
          truth: await versionOf(p.name),
          minorOk: sameMinor(p.version, [await versionOf(p.name)].filter(Boolean)),
        })),
      ),
      missed: key.filter((k) => !found.includes(k)),
    });
  }
  return out;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  },
);
