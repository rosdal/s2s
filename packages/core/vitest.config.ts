import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "core",
    globalSetup: ["./test/helpers/global-setup.ts"],
    // Browser-driven capture tests launch Chrome; give them room on slow CI runners.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
