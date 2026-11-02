---
"@rosdal/s2s": minor
---

Add `s2s maps` (Stage 2). It reads the source maps in a capture and writes the original sources to `recovered/sourcemap/`, with bundler internals under `_virtual/` and `node_modules` sources under `_vendor/`. Minified chunks whose maps carry names but no sources get their bindings renamed, scope-safely, into `recovered/renamed/`. It also writes package evidence with exact versions from pnpm and Yarn paths, project hints (language, framework, styling, path aliases, package manager), file boundaries for later unbundling, and a coverage report of how much first-party JS and CSS is now explained.
