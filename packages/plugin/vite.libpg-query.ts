import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const wasm = () =>
  readFileSync(new URL("./node_modules/libpg-query/wasm/libpg-query.wasm", import.meta.url));

// libpg-query's Emscripten loader fetches libpg-query.wasm next to the page at runtime (a bundled
// module has no currentScript to resolve from), a URL Vite can neither see nor emit on its own.
// Shared by the plugin build and the fixture preview; it imports neither of their configs.
export function libpgQueryWasm(): Plugin {
  return {
    name: "gatekeeper:libpg-query-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.split("?")[0].endsWith("/libpg-query.wasm")) return next();
        res.setHeader("Content-Type", "application/wasm");
        res.end(wasm());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "libpg-query.wasm", source: wasm() });
    },
  };
}
