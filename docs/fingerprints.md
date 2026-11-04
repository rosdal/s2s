# Fingerprint matching

`s2s detect` recognizes npm packages inside minified bundles even when nothing else gives them away: no source maps, no license banners, no version strings. It does this with an index of AST fingerprints of about 1,000 packages that ship to browsers, across their recent versions.

This page covers how matching works, how to get and refresh the index, how to request a package, and how to run the benchmark.

## Using it

```sh
s2s db pull        # download the newest index (a `fingerprints-YYYY-MM-DD` GitHub release)
s2s db status      # version, age, size and package count
s2s detect <dir>   # uses the index automatically when it is present
s2s detect <dir> --explain framer-motion   # shows fingerprint evidence next to the rest
```

The index lives in `~/.cache/s2s/fingerprints/` (or under `$S2S_CACHE_DIR` / `$XDG_CACHE_HOME/s2s`). `s2s detect` warns and suggests `s2s db pull` when the index is missing or more than 30 days old. A missing index never fails a run. Fingerprints are just one evidence source, and the other collectors still work without it.

For private or niche packages, build a local overlay. The matcher reads it next to the shared index:

```sh
s2s db build lodash@4.17.21            # name, name@version or name@range (4.x, ^4.1.0, ~1.2.3)
s2s db build @acme/ui                  # no range: the corpus rule (see below)
s2s db build --from-tarball acme-ui-2.3.0.tgz
```

The overlay is `local-overlay.sqlite` in the same folder. `s2s db pull` never touches it.

## How matching works

### What gets indexed

- **Corpus.** The corpus has three parts:
  - the top packages by weekly downloads that have a browser or ESM entry and no Node-only imports;
  - every package on the allowlist (`packages/fingerprints/corpus/allowlist.json`), which covers the React, Vue, Svelte, Preact and Radix/shadcn ecosystems plus the CommonJS browser libraries that npm search cannot classify (lodash, jquery, moment and others);
  - the denylist (`denylist.json`), which removes CLIs, build tools and types-only packages.

  Versions follow one rule: every stable release from the last three years, plus the newest release of each older major. `corpus.lock.json` pins every package@version with its tarball integrity.
- **Fetching.** Tarballs come straight from the registry and are checked against their integrity before use. Nothing is installed and no install scripts run.
- **Entries.** Each package is indexed through its main entry plus up to 20 subpath exports (`date-fns/format`, `zustand/middleware`), with wildcard subpaths expanded against the package's files. Dependencies and peer dependencies stay external, so a package's hashes cover only its own code. Entries that import Node built-ins are skipped and logged.
- **Variants.** Each entry is minified four ways, because the minifier is the main reason naive matching fails:

  | Variant         | Stands in for                         |
  | --------------- | ------------------------------------- |
  | `esbuild`       | esbuild and Vite before 8             |
  | `terser`        | webpack, older Vite and Rollup setups |
  | `oxc-es2020`    | Vite 8 and Rolldown                   |
  | `terser-es2015` | sites that build for old browsers     |

### Normalization and hashing

The builder and the matcher share one normalizer (`packages/core/src/fingerprint/normalize.ts`). It parses with oxc and fingerprints every function of at least 8 AST nodes: declarations, expressions, arrows, methods and class bodies. Each function becomes a token stream:

- identifiers are replaced by the order in which they first appear, so `function(e,t)` and `function(n,r)` agree; built-ins and host globals (`Object`, `document`, `Promise`) keep their names;
- property names and string values are kept, since minifiers do not change them;
- numbers and booleans are canonicalized (`!0` is `true`, `1e3` is `1000`, `void 0` is `undefined`);
- the control-flow rewrites minifiers apply are undone: `a&&b()` is `if(a)b()`, `return a?b:c` is `if(a)return b;return c`, sequences become statements, `===` becomes `==`, flipped comparisons are put back, `typeof x>"u"` is `typeof x=="undefined"`, blocks are flattened and `for(;x;)` is `while(x)`;
- a nested function contributes only its own hash to its parent, so each node is visited once.

Past 1,500 levels of nesting, a subtree becomes a single token, so pathological code costs its own detail and never crashes the run. oxc's parser has its own limit somewhere past 10,000 levels; no real bundle we have seen comes close.

The token stream is hashed with xxHash64. Collisions are not avoided. Scoring deals with them.

String literals of 12 or more characters that appear in only one package, such as error messages, are a second signal. They survive any minifier, and any version in which the message did not change.

### Where the minifiers still disagree

The golden test (`packages/fingerprints/test/builder.test.ts`) minifies a small library with every variant and records how much the hashes agree in a snapshot. These differences remain after normalization:

- terser inlines single-use constants and arrays into their use (`const k=1024` disappears), so the function's token stream changes;
- oxc drops `new` from built-in error constructors (`throw TypeError(…)`) and rewrites `Math.pow(a,b)` as `a**b`;
- the ES2015 target lowers syntax (optional chaining, object spread, class fields, async functions) into helper calls, so those functions only match the ES2015 variant;
- terser and esbuild split or join `var` declarations and move them into `for` initializers in different ways.

The agreement between pairs of variants is 50–80% in the golden test, and about 65% on real packages. That is why every variant is indexed on its own: the union covers 98% of the held-out terser setting on the libraries we measured.

### The index

The index is a SQLite file with these tables:

- `packages` and `versions`;
- `hashes`, with one row per function hash and a compact posting list of (package, version bitset);
- `strings`, the same for distinctive strings;
- `meta`, which records the schema version, normalizer version, corpus date and builder version.

Most functions do not change between versions, so one row per hash with a few bytes per package keeps the file small. A hash shared by more than 20 packages is dropped and recorded in `dropped`. Those are shared helpers (tslib, Babel runtime), so dropping them removes noise. An index built with a different normalizer or schema is refused, not misread.

### Scoring

- **Shared code.** Packages copy each other's code. A prebuilt bundle carries its dependencies (`vue/dist/*`, `plotly.js-dist-min` with all of d3), code moves between packages across releases (framer-motion into motion-dom), and small packages inline pieces of big ones (`aos` carries `lodash.debounce`). Three rules decide who a shared hash belongs to:
  1. code a package shares with one of its declared dependencies belongs to the dependency;
  2. otherwise it belongs to the package with the largest matched share of its own indexed functions, so a d3 module that is half present beats a bundle that is 1% present;
  3. after scoring, a package is dropped when at least 40% of its matched functions are also owned by smaller accepted packages. Such a package is a bundle that vendors them, not something the site depends on.
- **Presence.** A package is present when its matched functions add up to an IDF-weighted score of at least 4 and at least 5 distinct functions matched. A function found only in that package weighs 1. One shared by `df` of `N` packages weighs `ln(1 + N/df) / ln(1 + N)`. Hashes still shared after the rules above are credited greedily: the package that explains the most takes them, so `lodash` and `lodash-es` do not both claim the same functions. Tree-shaking removes most of a package, so presence never depends on what share of a package matched. It depends on the specificity of what did match. Share only breaks ties between owners of the same code.
- **Version.** Only the hashes that tell versions apart vote. Each version scores the weight of the matched hashes it contains, and the versions with the best score win. A single winner is reported as an exact version. Ties within one minor are reported as `4.17.x`, which counts as confident. Ties across minors are reported as `4.x`, and ties across majors give no version.
- **Evidence.** A confident version is `strong` evidence, which makes medium confidence on its own. Presence alone is `weak`, which puts the package up for review. Both are written to `analysis/evidence/fingerprints.json` with the match statistics.
- **Vendor ranges.** Matched functions within 1 KB of each other, with no other package's function between them, form a range. A range needs at least two matched functions. Ranges go into `vendor-ranges.json` with the method `fingerprint`. That method ranks below source maps, CDN files, modules and banners, so it only adds bytes nothing else claimed.

## Requesting a package

Open an issue with the package name and a site that ships it. If the package qualifies (it ships browser code, has no Node-only imports and is not a build tool), it goes on the allowlist and is in the next weekly build. Until then, `s2s db build <name>` puts it in your local overlay.

## How the index is built

`.github/workflows/fingerprints.yml` runs every Monday and on demand:

1. **Plan.** Refresh the candidates and `corpus.lock.json`, and download the previous release.
2. **Build.** Split the corpus across a job matrix. Each job builds only the package versions the previous release lacks, and keeps each package whole within one shard. Results are cached per package@version, and minify work is cached by bundle content, so a rerun resumes where it stopped.
3. **Merge.** Add the results to the previous index, print the size report, compress with zstd, check the download stays under 100 MB, and attach the index, its SHA-256 and the corpus lock to a `fingerprints-YYYY-MM-DD` release.

If GitHub's runner time limits get in the way, run the workflow with `runner` set to a self-hosted label.

Plan on about 2 GB of memory per build worker. The largest packages (three.js with its addons and WebGPU entries) peak at 1.2 GB in the worker, plus esbuild's own process. The default is one worker per CPU minus one; lower it with `--concurrency` on machines with less memory than that.

To build locally:

```sh
pnpm --filter @rosdal/s2s-fingerprints run build
node packages/fingerprints/dist/cli.js candidates            # rank candidates
node packages/fingerprints/dist/cli.js lock --limit 1000     # resolve versions
node packages/fingerprints/dist/cli.js build --packages react,react-dom --concurrency 8
node packages/fingerprints/dist/cli.js merge --out fingerprints.sqlite
node packages/fingerprints/dist/cli.js report --index fingerprints.sqlite
```

## The benchmark

The benchmark (`bench/`) generates apps whose answer key is known, then builds them with settings the index never saw. The numbers therefore measure generalization, not memory.

1. **Generate.** A seeded generator picks 3–10 indexed packages at random versions, imports a random subset of their exports, and adds first-party modules so vendor ranges have edges to find.
2. **Build.** Each app is built with webpack + terser, Vite, Rolldown + oxc-minify, and esbuild. A **held-out** configuration (terser with top-level mangling and 3 compress passes) never appears among the index variants.
3. **Match.** The fingerprint matcher alone runs on the output.
4. **Score.** The answer key comes from each build's source maps: every byte mapped into `node_modules` is vendor code, and the package and version it maps to were really bundled. The benchmark reports:
   - package precision and recall at medium confidence and above, and over all matches;
   - exact-version and same-minor accuracy;
   - vendor-range overlap with the true vendor bytes (IoU);
   - match time per MB.

   A package counts toward recall when the index holds it and at least 2,000 characters of it were bundled. Smaller amounts fall under the five-function floor by design.

```sh
pnpm build
node bench/run.mjs --index ~/.cache/s2s/fingerprints/fingerprints-YYYY-MM-DD.sqlite --apps 30 --out bench/results.json
node bench/run.mjs --table bench/results.json        # the README table
node bench/run.mjs --index … --fixtures               # adds real-site spot checks from fixtures/
```

`bench/results.json` is committed. Pull requests run a small subset against an index of a few light packages, compared with `bench/results-ci.json`. The nightly run uses the published index. Both fail when a metric drops more than 2 points.
