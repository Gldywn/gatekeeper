import { loadPgParser } from "./sql/pg/parse";
import { wasmBytes } from "./sql/pg/wasm";

// As main.ts does before the app starts, through the same hook, so tests load what Beekeeper loads.
if (!(await loadPgParser(wasmBytes))) throw new Error("PostgreSQL parser failed to load");
