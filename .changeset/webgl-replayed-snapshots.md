---
"@rosdal/s2s": patch
---

WebGL scene snapshots are repeatable between capture and verify. The capture's deterministic pass still loads the live site once, to record every response, then takes its snapshots from a replay of that recording, as verify does. On the live network, the order in which responses arrived within a clock step changed what ran between them, and with it verify's seeded `Math.random` sequence. Model proxies also keep the original's vertex layout: an interleaved proxy of a non-interleaved model made three create extra `InterleavedBuffer`s, each taking a UUID from the same sequence.
