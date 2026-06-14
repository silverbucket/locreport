import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests clone/analyze and can be slow.
    testTimeout: 60_000,
  },
});
