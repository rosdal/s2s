---
"@rosdal/s2s": patch
---

Detection no longer guesses a version whose peer ranges reject the peers the site really has: `jotai-scope` steps back from 0.12.2 to 0.8.3 when the bundle pins `jotai` 2.11.0, so a pnpm scaffold of Excalidraw installs and builds. A failed build now shows the lines that report the failure instead of the first 50 lines of output.
