import { defineConfig } from "vitest/config";

// A standalone test config so vitest does not load the Beekeeper build plugin;
// the unit tests cover pure modules and run in a plain node environment.
export default defineConfig({
  define: {
    __GK_BUILD__: JSON.stringify({ version: "0.0.0" }),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
  },
});
