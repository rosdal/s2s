# docusaurus.io

Nov 2, 2026 · `s2s capture https://docusaurus.io/ --depth 1 --max-pages 3` (desktop + mobile)

**Result:** complete in 2 min 53 s. Three pages (home, the 3.10 release post, docs), 2,332 requests. The webpack reader pulled 1,766 chunks out of the runtime's chunk-filename map: Docusaurus emits one chunk per route and per content file, so this is nearly the whole site's client code, though the session visited three pages. The runtime probe saw a React root.

The first run took 5 min 15 s and 4,155 requests, because every one of about 2,000 blind `<file>.map` probes returned 404. Capture now stops blind probing on an origin after 25 misses in a row with no hit (maps named by a comment or header are still fetched). The second run skipped 1,823 probes and found the same 1,766 chunks.

**What was missed**

- Route data: about 200 `@generated/.../*.json` files that hold per-route props. They are loaded through the same chunk map but are JSON, and discovery only fetches `.js`, `.mjs` and `.css`.
- KaTeX fonts (`/katex/fonts/*`) and about 1,200 image paths named in content chunks, none used on the three pages captured.
- 75 generic string references were build-machine paths (`/opt/build/repo/...`, `src/css/custom.css`, `docusaurus.config.js`) that 404. They are logged as failed in `discovery.json`; the 141 remaining 404s are those (some tried at more than one candidate URL) plus the 25 blind map probes.
- The React version: no global or devtools hook, so Stage 3 has to read it from the bundle.

No consent banner appeared.
