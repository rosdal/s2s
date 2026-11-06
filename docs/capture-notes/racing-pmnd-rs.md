# racing.pmnd.rs

Nov 6, 2026 · `s2s grab https://racing.pmnd.rs/ --viewports desktop` (source: [pmndrs/racing-game](https://github.com/pmndrs/racing-game))

**Result:** every stage completes and the untouched scaffold builds. Verify runs and reports a regression (exit 1): the rebuilt page throws at startup, so no scene renders.

- Detected as three r139 through React Three Fiber, with drei, cannon-es and the GLTF, Draco, meshopt, RGBE and OrbitControls addons. The repo uses `@react-three/fiber`, `@react-three/drei` and `@react-three/cannon`, so the packages match. `three` installs at 0.139.2, from the page's own `__THREE__`. The fingerprint index only has 0.159 and later, and on its own it picked 0.159.
- The WebGL pass took 3 keyframes (the page doesn't scroll): 111 scene nodes per snapshot, 15 linked shader programs.
- Proxy assets: 3 models, 4 sounds and 1 environment map replaced; the leak check passed. Two Draco decoder files were tagged and are served from the `three` package.

**What was missed**

- The untouched build took several Stage 4 fixes. Library code the index missed wrote to bindings that had become imports (react-dom's event priorities, drei's `useGLTF.clear = …`). three-stdlib imports constants three 0.139 had already removed (`GammaEncoding`), which the site's bundler left `undefined`; the scaffold now shims them the same way.
- At runtime the rebuilt page now mounts React and renders, then throws `tE is not a function` inside R3F's `<Canvas>`. The fingerprint index has `@react-three/fiber` only from 8.15 on, and the site ships an 8.0 build, so most of fiber stays inline as site code and clashes with the installed copy. Until fiber 8.0 is fingerprinted, verify finds no scene at any keyframe. Fixes on the way here:
  - pnpm had installed fiber 9 (built for React 19) as drei's peer. Detection now treats drei as implying fiber, the fiber signature matches 8.x's error text, and the scaffold pins fiber and `react-reconciler` to the project's React.
  - React's CommonJS module record (`var H = { exports: {} }`) was kept empty once React's code was dropped; Stage 4 now points such records at the package.
  - Post-install naming now covers:
    - aliases of merged namespaces (`{ ...react-dom, ...react-dom/client }`);
    - bindings filed under the wrong library (three's `LoadingManager` under react-dom);
    - CommonJS packages (`react-reconciler`);
    - bindings imported from another chunk;
    - functions told apart by their statics (`useGLTF.preload`);
    - member reads (`EK.createRoot`, `Gf.exports.jsx`).
    It also copies small internal helpers no package exports (supabase's `resolveFetch`).
- Shaders: three's `ShaderChunk` wasn't found in the r139 bundle, so the 15 programs were written unfolded, and none matched a literal in the recovered modules (the custom shaders sit in drei and three-stdlib code that was dropped as vendor).
- The network never went quiet during the deterministic pass (the game streams audio), so the keyframes may not repeat exactly.
- Driving is keyboard input; the keyframe walk only covers time and scroll, so the race itself is never captured.
