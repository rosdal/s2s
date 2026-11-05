# racing.pmnd.rs

Nov 5, 2026 · `s2s grab https://racing.pmnd.rs/ --viewports desktop` (source: [pmndrs/racing-game](https://github.com/pmndrs/racing-game))

**Result:** capture, maps, detect, unbundle and scaffold complete; the untouched build fails, so verify stops at exit 2.

- Detected as three r139 through React Three Fiber, with drei, cannon-es and the GLTF, Draco, meshopt, RGBE and OrbitControls addons. The repo uses `@react-three/fiber`, `@react-three/drei` and `@react-three/cannon`, so the packages match.
- The WebGL pass took 3 keyframes (the page doesn't scroll): 111 scene nodes per snapshot, 15 linked shader programs.
- Proxy assets: 3 models, 4 sounds and 1 environment map replaced; the leak check passed. Two Draco decoder files were tagged and are served from the `three` package.

**What was missed**

- The untouched build: a react-dom fragment the fingerprint index missed assigns to the imported namespace (`fg.ContinuousEventPriority = 4`). That is Stage 4's vendor rewrite, not WebGL-specific.
- Shaders: three's `ShaderChunk` wasn't found in the r139 bundle, so the 15 programs were written unfolded, and none matched a literal in the recovered modules (the custom shaders sit in drei and three-stdlib code that was dropped as vendor).
- The network never went quiet during the deterministic pass (the game streams audio), so the keyframes may not repeat exactly.
- Driving is keyboard input; the keyframe walk only covers time and scroll, so the race itself is never captured.
