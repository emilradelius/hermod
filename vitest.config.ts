import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Hook and CLI tests spawn real node processes in temporary git repositories.
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
