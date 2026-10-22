import { loadModule } from "libpg-query";

// PostgreSQL's grammar ships as WASM and compiles once, asynchronously; every parse after that
// is synchronous, so the gate stays callable from rendering. Until it loads, a PostgreSQL parse
// throws and the gate takes its fallback, exactly as for any statement it cannot read.
export async function loadPgParser(): Promise<boolean> {
  try {
    await loadModule();
    return true;
  } catch {
    return false;
  }
}
