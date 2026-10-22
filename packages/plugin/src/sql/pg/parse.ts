import { loadModule, type ParseResult, parseSync, type ScanToken, scanSync } from "libpg-query";

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

// libpg_query's scanner token for a string constant: plain, E'', N'' (its quote part) or dollar.
const SCONST = 261;

// "ambiguous" when the text may not mean what the parser reads: C stops at a NUL, and with the
// server's standard_conforming_strings off (the parser assumes on) a backslash-quote moves
// statement ends. Null when PostgreSQL's grammar rejects the text.
export function parsePg(sql: string): ParseResult | "ambiguous" | null {
  if (sql.includes("\0")) return "ambiguous";
  try {
    if (scanSync(sql).tokens.some((t) => ordinaryString(t) && t.text.includes("\\'")))
      return "ambiguous";
    return parseSync(sql);
  } catch {
    return null;
  }
}

function ordinaryString(token: ScanToken): boolean {
  return token.tokenType === SCONST && !/^[eE$]/.test(token.text);
}
