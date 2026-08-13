// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig, passthroughImageService } from "astro/config";

// The design tokens live at the repo root (shared/tokens.css), one level above this
// Astro project; allow Vite's dev server to read outside the landing/ root.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  // Placeholder until the public repo/domain is settled. Set `base` here if the
  // site is served under a subpath (e.g. project GitHub Pages).
  site: "https://gatekeeper.github.io",
  // No build-time image optimization: assets are hand-tuned, so skip the native
  // sharp pipeline (which the workspace's allowBuilds gate would block anyway).
  image: { service: passthroughImageService() },
  vite: {
    server: { fs: { allow: [repoRoot] } },
  },
});
