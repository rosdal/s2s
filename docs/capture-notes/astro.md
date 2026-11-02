# astro.build

Nov 2, 2026 · `s2s capture https://astro.build/` (defaults: desktop + mobile, depth 0)

**Result:** complete in 66 s. 110 requests, 1.4 MB stored, 20 JS/CSS files, all loaded by the page itself. Discovery found every reference already captured, so it fetched nothing new. No source maps: the nine blind `.map` probes all returned 404. The probe reported Astro (no `astro-island` elements on this page) and Preact.

**What was missed**

- Most of the time went to the interaction phase: the page is long (9 desktop and 14 mobile scroll steps) and lazy-loads many images, and each step waits for the network to go quiet. 73 of the 110 requests were media.
- One background image named only in CSS-in-JS (`/assets/bg-grid.png`) was never requested, since nothing on the page used it at the captured viewports.
- The Astro version: astro.build doesn't set a `generator` meta tag, so the probe has a name but no version.

No consent banner appeared.
