import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { libpgQueryWasm } from "./vite.libpg-query";

// A dev-only preview of the real plugin fed by fixtures (preview/). It deliberately loads
// neither vite.config.ts nor the Beekeeper Vite plugin, which installs itself into
// Beekeeper's plugin directory on dev start; the SDK is swapped for an in-page fake and the
// broker for an in-memory fetch, so nothing here reaches Beekeeper, port 9999 or ~/.gatekeeper.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("."),
  envDir: false,
  cacheDir: here("node_modules/.vite-preview"),
  define: {
    __GK_BUILD__: JSON.stringify({ version: "0.3.1", dev: { branch: "preview" } }),
  },
  plugins: [libpgQueryWasm()],
  resolve: {
    alias: [{ find: /^@beekeeperstudio\/plugin$/, replacement: here("preview/host.ts") }],
  },
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    open: false,
    // Native file events do not reach every sandboxed shell; polling keeps edits live.
    watch: { usePolling: true, interval: 300 },
  },
});
