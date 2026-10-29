import wasm from "libpg-query/wasm/libpg-query.wasm?inline";

// Beekeeper serves plugin pages from a scheme that cannot fetch the plugin's own files, so the
// grammar travels inside the bundle. Needs Vite; the server's evals load the file from disk.
const bytes = Uint8Array.from(atob(wasm.slice(wasm.indexOf(",") + 1)), (c) => c.charCodeAt(0));

// A new instance on every call: libpg-query reloads through this hook after a WASM exception.
export const instantiateWasm = async (imports: WebAssembly.Imports) =>
  (await WebAssembly.instantiate(bytes, imports)).instance;
