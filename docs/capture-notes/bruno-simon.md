# bruno-simon.com

Nov 6, 2026 · `s2s grab https://bruno-simon.com/ --viewports desktop` (source: [brunosimon/folio-2025](https://github.com/brunosimon/folio-2025), MIT)

**Result:** every stage completes and the untouched scaffold builds. Verify still fails (exit 1): the rebuilt page throws at startup, so no scene renders. Remaining work is tracked in [#23](https://github.com/rosdal/s2s/issues/23).

- Detected as three r187 with GSAP, tweakpane and its essentials and camerakit plugins, seedrandom, Howler and plotly, plus the GLTF, Draco, KTX2 and UnrealBloom addons. The site renders through three's WebGPU build and TSL; the bundle carries two copies of TSL.
- The scene still reported itself through the devtools hook: 818 scene nodes per snapshot, 61 linked shader programs, 3 keyframes.
- Proxy assets: 22 models and 42 sounds replaced, the leak check passed; the Draco and Basis decoder paths (`/draco/`, `/basis/`) are served from the `three` package.
- With the local fingerprint overlay below, Stage 4 drops 77% of the bundle as library code.

**What was missed**

- Fingerprints: the shared index stops at three 0.181 and has no tweakpane or seedrandom. These runs used a local overlay: `s2s db build "three@0.187.0" "tweakpane@4.x" "@tweakpane/plugin-essentials@0.2.x" "@tweakpane/plugin-camerakit@0.3.x" "seedrandom@3.x"`.
- The last startup error was `Cannot access 'u' before initialization` in the `buffer` polyfill: the un-es6-class rule turned a hoisted `function u` into a class. A guard for that is in place but hasn't been run against this site yet.
- Shaders: three's `ShaderChunk` wasn't found (the WebGPU build ships TSL node code instead), so programs were written unfolded; WGSL and TSL are out of scope.
- The network never went quiet during the deterministic pass (sound streams), so keyframes may not repeat exactly.
- The site is driven by keyboard and pointer (a car you steer); the walk covers time steps only, as the page doesn't scroll.
