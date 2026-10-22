import { loadPgParser } from "./sql/pg/parse";

// As main.ts does before the app starts: the PostgreSQL grammar is WASM and loads once.
if (!(await loadPgParser())) throw new Error("PostgreSQL parser failed to load");
