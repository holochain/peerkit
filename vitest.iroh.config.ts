import { defineConfig } from "vitest/config";

// Runs only the tests that need the native iroh binding, in a dedicated CI job
// (see the `iroh` job in .github/workflows/test.yml). The main matrix uses
// vitest.config.ts, which excludes this package.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    projects: ["packages/transport-iroh-nodejs"],
  },
});
