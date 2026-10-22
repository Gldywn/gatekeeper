import { loadModule } from "libpg-query";

// PostgreSQL's grammar ships as WASM and compiles once, asynchronously; every parse after that
// is synchronous, so callers in rendering stay synchronous too. Until it loads, a parse throws.
export async function loadPgParser(): Promise<boolean> {
  try {
    await loadModule();
    return true;
  } catch {
    return false;
  }
}
