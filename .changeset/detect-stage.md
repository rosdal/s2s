---
"@rosdal/s2s": minor
---

Add `s2s detect` (Stage 3). It merges every cheap package signal in a capture (CDN URLs, source-map paths, license banners, webpack `.LICENSE.txt` files, version strings matched against signature files, runtime versions and framework markers) into one scored list in `analysis/packages.json`, with the evidence behind each match. Candidates are checked against the npm registry; a name that only the site's own text gives must exist and pass a popularity floor, or it goes to `analysis/packages-review.json`. It writes `project/package.json` with exact pins, marks vendor byte ranges per bundle in `analysis/vendor-ranges.json`, and with `--install` runs pnpm, npm, yarn or bun with install scripts disabled. `--explain <pkg>` prints the evidence for one package, and `--offline` skips only the registry checks. Capture now also fetches the `*.LICENSE.txt` files webpack bundles point at.
