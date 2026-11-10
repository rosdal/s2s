---
"@rosdal/s2s": patch
---

Fix the rebuilt bruno-simon.com at startup. A chunk the site only loads with `import()` whose exports are nearly all one package's (Rapier's wasm-bindgen chunk) is now imported from that package whole, instead of keeping its unmatched glue as site code. Vite's preload wrapper around `import()` is dropped, so the rebuild no longer requests the capture's chunk files. The scaffold no longer binds a site's own unminified function to a library export that only looks loosely like it (`toGrid` as three's `oscTriangle`) or only shares its name (a TSL `random` as gsap's), which compiled `NaN` into shaders. Capture also fetches the page's icons and web manifest, which the browser requests on its own.
