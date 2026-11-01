import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts", "showcase/test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 120_000 },
});
