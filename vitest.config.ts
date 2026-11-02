import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
    passWithNoTests: true,
    // Builds any missing fixture site once, before every project's tests.
    globalSetup: ["packages/core/test/helpers/global-setup.ts"],
  },
});
