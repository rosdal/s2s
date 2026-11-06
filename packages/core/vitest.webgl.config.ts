import { tmpdir } from "node:os";
import path from "node:path";
import { defineProject } from "vitest/config";

/**
 * The WebGL end-to-end tests render in software and time the page against a frozen clock, so they
 * run on their own, one file at a time, after everything else (`pnpm test`).
 */
export default defineProject({
  test: {
    env: { S2S_CACHE_DIR: path.join(tmpdir(), "s2s-test-cache") },
    name: "core-webgl",
    include: ["test/webgl.test.ts", "test/webgl-session.test.ts"],
    fileParallelism: false,
    // On a busy machine a page can still start its animation clock one load step later; one
    // retry tells that apart from a real regression.
    retry: 1,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
