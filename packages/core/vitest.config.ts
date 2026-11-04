import { tmpdir } from "node:os";
import path from "node:path";
import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // A private cache, so a fingerprint index the developer pulled never changes test results.
    env: { S2S_CACHE_DIR: path.join(tmpdir(), "s2s-test-cache") },
    name: "core",
    // Browser-driven capture tests launch Chrome; give them room on slow CI runners.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
