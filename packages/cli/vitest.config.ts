import { defineProject } from "vitest/config";

export default defineProject({
  // Resolve @rosdal/s2s-core to its TypeScript sources, so tests don't need a core build.
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    name: "cli",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
