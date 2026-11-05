# bruno-simon.com

Nov 5, 2026 · `s2s grab https://bruno-simon.com/ --viewports desktop` (source: [brunosimon/folio-2025](https://github.com/brunosimon/folio-2025), MIT)

**Result:** capture, maps, detect, unbundle and scaffold complete; the untouched build fails, so verify stops at exit 2.

- Detected as three r187 with GSAP and ScrollTrigger, Rapier, Howler, and the GLTF, Draco, KTX2 and UnrealBloom addons. The site also uses WebGPU code (three's WebGPU build), which detect reports as unsupported.
- The scene still reported itself through the devtools hook: 818 scene nodes per snapshot, 61 linked shader programs, 3 keyframes.
- Proxy assets: 22 models and 42 sounds replaced, the leak check passed; the Draco and Basis decoder paths (`/draco/`, `/basis/`) are served from the `three` package.
- 121 inlined library bindings were named after install.

**What was missed**

- The untouched build: two recovered parts both declare `__vitePreload`, and a binding inside three's inlined code (`Vector3$1`) is redeclared. Both come from Stage 4 splitting a Vite bundle, not from the WebGL stages.
- Shaders: three's `ShaderChunk` wasn't found (the WebGPU build ships TSL node code instead), so programs were written unfolded; WGSL and TSL are out of scope.
- The network never went quiet during the deterministic pass (sound streams), so keyframes may not repeat exactly.
- The site is driven by keyboard and pointer (a car you steer); the walk covers time steps only, as the page doesn't scroll.
- Recovered code calls `require("fs")` and `require("path")` from a bundled dependency; scaffold added them to `package.json` with a warning for the agent to remove.
