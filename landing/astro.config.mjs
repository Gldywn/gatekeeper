// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig, passthroughImageService } from "astro/config";

// The design tokens come from the @gatekeeper/shared workspace package, whose files sit
// outside landing/; allow Vite's dev server to read the repo root so the symlink resolves.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
// The plugin replay (src/pages/plugin-demo.astro) runs the real plugin against an in-memory
// Beekeeper SDK. It reports the release the landing announces, shaped as a release build's.
const ANNOUNCED = "1.0.0";

export default defineConfig({
  // Canonical origin for absolute URLs (sitemap, SEO). Served at the domain root
  // on Vercel, so no `base` subpath is needed.
  site: "https://trygatekeeper.dev",
  // No build-time image optimization: assets are hand-tuned, so skip the native
  // sharp pipeline (which the workspace's allowBuilds gate would block anyway).
  image: { service: passthroughImageService() },
  // Off so the dev server shows what ships: the toolbar would also draw inside the replay frame.
  devToolbar: { enabled: false },
  vite: {
    // The plugin inlines PostgreSQL's grammar (packages/plugin/src/sql/pg/wasm.ts), as its own
    // Vite config allows.
    assetsInclude: ["**/*.wasm"],
    server: { fs: { allow: [repoRoot] } },
    define: { __GK_BUILD__: JSON.stringify({ version: ANNOUNCED }) },
    resolve: {
      alias: [
        {
          find: /^@beekeeperstudio\/plugin$/,
          replacement: fileURLToPath(new URL("./src/demo/host.ts", import.meta.url)),
        },
      ],
    },
  },
});
