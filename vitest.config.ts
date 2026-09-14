import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      ["schemas", "shared", "github", "sandbox", "models", "agents", "workflow"].map((name) => [
        `@sherpa/${name}`,
        fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
      ]),
    ),
  },
  test: { include: ["packages/**/*.test.ts", "tests/**/*.test.ts"], testTimeout: 20000 },
});
