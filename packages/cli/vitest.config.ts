import { tmpdir } from "node:os";
import path from "node:path";
import { defineProject } from "vitest/config";

export default defineProject({
  // Resolve @rosdal/s2s-core to its TypeScript sources, so tests don't need a core build.
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    // A private cache, so a fingerprint index the developer pulled never changes test results.
    env: { S2S_CACHE_DIR: path.join(tmpdir(), "s2s-test-cache") },
    name: "cli",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
