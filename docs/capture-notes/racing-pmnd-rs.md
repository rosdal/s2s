# racing.pmnd.rs

Nov 6, 2026 · `s2s grab https://racing.pmnd.rs/ --viewports desktop` (source: [pmndrs/racing-game](https://github.com/pmndrs/racing-game))

**Result:** every stage completes, the untouched scaffold builds and verify passes (exit 0). The page check shows 0.00% pixel difference, DOM similarity 0.997 and no new console errors. The WebGL scene check, in proxy mode, matches all 3 keyframes.

- Detected as three r139 through React Three Fiber 8.0.12, with drei, `@pmndrs/cannon-worker-api` 2.x and the GLTF, Draco, meshopt, RGBE and OrbitControls addons. `three` installs at 0.139.2, from the page's own `__THREE__`.
- The WebGL pass took 3 keyframes (the page doesn't scroll). The page renders two scenes, both named `Scene` (the track and the minimap); verify pairs them by the nodes they share.
- Proxy assets: 3 models, 4 sounds and 1 environment map replaced; the leak check passed. Two Draco decoder files are served from the `three` package.

**What it took**

- Fingerprints: the shared index has `@react-three/fiber` only from 8.15 and no cannon packages. This run used a local overlay: `s2s db build "@react-three/fiber@8.0.x" "@react-three/cannon@6.x" "@pmndrs/cannon-worker-api@1.x" "@pmndrs/cannon-worker-api@2.x"`. Without it, most of fiber stays inline and clashes with the installed copy. These versions should go into the shared corpus.
- Physics steps in cannon's Web Worker, off the frozen clock, so verify ignores the poses of the bodies it moves at every keyframe (main-thread physics such as Rapier still counts at t0). Their names, hierarchy and presence are still compared.
- Library code that Stage 4 kept or filed under the wrong package was named after install. That took:
  - CommonJS module records;
  - merged and aliased namespaces;
  - bindings imported from another chunk;
  - functions told apart by their statics (`useGLTF.preload`), their structure, or their order (`addEffect`);
  - member reads (`EK.createRoot`, `Gf.exports.jsx`).
    It also copies small internal helpers and singletons that no package exports (supabase's `resolveFetch`, cannon's context).

**What was missed**

- Shaders: three's `ShaderChunk` wasn't found in the r139 bundle, so the 15 programs were written unfolded, and none matched a literal in the recovered modules (the custom shaders sit in drei and three-stdlib code that was dropped as vendor).
- The network never went quiet during the deterministic pass (the game streams audio); verify notes it but still matched every keyframe.
- Driving is keyboard input; the keyframe walk only covers time and scroll, so the race itself is never captured.
