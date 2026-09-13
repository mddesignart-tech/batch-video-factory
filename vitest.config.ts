import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // SQLite is a single file with a single writer. Running the suite in one
    // process keeps the database tests deterministic, and the end-to-end test
    // shells out to FFmpeg, so it needs a generous timeout.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
