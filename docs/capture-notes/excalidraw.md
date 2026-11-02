# excalidraw.com

Nov 2, 2026 · `s2s capture https://excalidraw.com/` (defaults: desktop + mobile, depth 0)

**Result:** complete in 19 s. 188 requests, 22.6 MB stored. Discovery fetched 71 chunks the page never loaded (all through the generic string reader), and 71 source maps came in through `sourceMappingURL` comments. The runtime probe saw a React root and Vite markers.

**What was missed**

- Non-JS/CSS assets named only in code: about 230 font files (`Assistant-*.woff2`, the per-script Excalifont subsets), 59 locale files (`locales/*.json`) and `woff2.wasm`. Discovery only looks for `.js`, `.mjs` and `.css`, so these stay out until a later stage needs them.
- The service worker (`sw.js`) was fetched as a script but never ran, because capture blocks service workers. Anything the worker would precache is only captured when the page asks for it.
- The React version: React is bundled without a global or the devtools hook, so the probe only reports that a React root exists. Stage 3 has to recover the version from the bundle.
- Two generic references were false positives (`index.js`, `assets/scripts/buildWasm.js` from build-time strings); they 404 and are logged as failed in `discovery.json`.

No consent banner appeared.
