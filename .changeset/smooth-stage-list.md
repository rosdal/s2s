---
"@rosdal/s2s": patch
---

The live stage list no longer flashes or freezes. Each frame is repainted in one write instead of clearing the block first, the cursor is hidden while it draws, and unbundle and maps give the spinner a turn between bundles, with unbundle showing how many chunks it has split.
