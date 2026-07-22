import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    // transport-iroh-nodejs needs the native binding; it runs via
    // vitest.iroh.config.ts in a dedicated CI job, not the main TS matrix.
    projects: ["packages/*", "!packages/transport-iroh-nodejs"],
  },
});
