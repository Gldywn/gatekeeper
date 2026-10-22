import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import bks from "@beekeeperstudio/vite-plugin";
import { defineConfig } from "vite";
import { buildIdentity } from "../../scripts/build-identity.mjs";

const pluginDir = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

export default defineConfig({
  define: {
    __GK_BUILD__: JSON.stringify(
      buildIdentity(pluginDir, version, process.env.GATEKEEPER_RELEASE_TAG),
    ),
  },
  plugins: [
    // The Beekeeper Studio plugin handles bundling the HTML entrypoints into dist/.
    bks({
      entrypoints: [
        {
          input: "index.html",
          output: "dist/index.html",
        },
      ],
    }),
    {
      // libpg-query's Emscripten loader fetches libpg-query.wasm next to the page at runtime (a
      // bundled module has no currentScript to resolve from), a URL Vite cannot see to emit.
      name: "gatekeeper:libpg-query-wasm",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "libpg-query.wasm",
          source: readFileSync(
            new URL("./node_modules/libpg-query/wasm/libpg-query.wasm", import.meta.url),
          ),
        });
      },
    },
  ],
});
