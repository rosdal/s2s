---
"@rosdal/s2s": patch
---

Capture stores the real body of a response the page read with `.blob()`, such as an image three.js loads through `ImageBitmapLoader`. Chromium reports those bodies as empty, so capture now fetches them again. Model proxies keep the original's vertex count, so code that draws `Math.random()` per vertex stays in step with verify's seeded sequence.
