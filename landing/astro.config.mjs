// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig, passthroughImageService } from "astro/config";

// The design tokens come from the @gatekeeper/shared workspace package, whose files sit
// outside landing/; allow Vite's dev server to read the repo root so the symlink resolves.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  // Canonical origin for absolute URLs (sitemap, SEO). Served at the domain root
  // on Vercel, so no `base` subpath is needed.
  site: "https://trygatekeeper.dev",
  // No build-time image optimization: assets are hand-tuned, so skip the native
  // sharp pipeline (which the workspace's allowBuilds gate would block anyway).
  image: { service: passthroughImageService() },
  vite: {
    server: { fs: { allow: [repoRoot] } },
  },
});
