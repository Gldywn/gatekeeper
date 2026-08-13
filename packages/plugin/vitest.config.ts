import { defineConfig } from "vitest/config";

// A standalone test config so vitest does not load the Beekeeper build plugin;
// the unit tests cover pure modules and run in a plain node environment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
