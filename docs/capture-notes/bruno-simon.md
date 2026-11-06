# bruno-simon.com

Nov 6, 2026 · `s2s grab https://bruno-simon.com/ --viewports desktop` (source: [brunosimon/folio-2025](https://github.com/brunosimon/folio-2025), MIT)

**Result:** every stage completes and the untouched scaffold builds. Verify runs and reports a regression (exit 1): the rebuilt page throws at startup, so no scene renders.

- Detected as three r187 with GSAP and ScrollTrigger, Rapier, Howler, and the GLTF, Draco, KTX2 and UnrealBloom addons. The site also uses WebGPU code (three's WebGPU build), which detect reports as unsupported.
- The scene still reported itself through the devtools hook: 818 scene nodes per snapshot, 61 linked shader programs, 3 keyframes.
- Proxy assets: 22 models and 42 sounds replaced, the leak check passed; the Draco and Basis decoder paths (`/draco/`, `/basis/`) are served from the `three` package.
- 120 inlined library bindings were named after install: 50 from `three`, 18 from `three/webgpu`, 42 from `three/tsl`, and the rest from three's addons and gsap.

**What was missed**

- The untouched build took several Stage 4 fixes: the recovered copies of Vite's `__vitePreload` and `__vite__mapDeps` collided with the ones Vite injects, KTX2Loader code wrote module state that had become an import (`_zstd ||= …`), and Rolldown's runtime helpers were exported from a chunk that had been dropped as library code.
- A bundled Node dependency (`util`) expects the `process` global the site's bundler provided; the scaffold now defines the same browser shim in `index.html`. Past that, the rebuilt page throws `ConvertType$1 is not a constructor`, a three TSL internal the post-install naming couldn't resolve. Until it is fixed, verify finds no scene at any keyframe. Recovered code also calls `require("fs")` and `require("path")`; scaffold flags both for the agent.
- Shaders: three's `ShaderChunk` wasn't found (the WebGPU build ships TSL node code instead), so programs were written unfolded; WGSL and TSL are out of scope.
- The network never went quiet during the deterministic pass (sound streams), so keyframes may not repeat exactly.
- The site is driven by keyboard and pointer (a car you steer); the walk covers time steps only, as the page doesn't scroll.
