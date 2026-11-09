---
"@rosdal/s2s": patch
---

Recover sites that use `@dimforge/rapier3d`, the build that imports its `.wasm` as a module. `s2s db build` fingerprints such packages instead of skipping them, and a rebuilt version now replaces the one an earlier run wrote. Patch releases with identical code report their range (`0.19.x`) instead of no version. The scaffold adds `vite-plugin-wasm` when a dependency needs it.
