import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { provider: "v8" },
    include: [
      "packages/**/*.test.ts",
      "integrations/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    testTimeout: 15_000,
  },
});
