import { loadModule, type ParseResult, parseSync, type ScanToken, scanSync } from "libpg-query";

// PostgreSQL's grammar ships as WASM and compiles once, asynchronously; every parse after that
// is synchronous, so callers in rendering stay synchronous too. Until it loads, a parse throws.
// Given the bytes, every instance, reloads after a WASM exception included, is built from them.
export async function loadPgParser(wasm?: Uint8Array): Promise<boolean> {
  try {
    await loadModule(wasm ? { wasm } : undefined);
    return true;
  } catch {
    return false;
  }
}

// libpg_query's scanner token for a string constant: plain, E'', N'' (its quote part) or dollar.
const SCONST = 261;

export interface PgText {
  tree: ParseResult;
  tokens: ScanToken[];
}

// "ambiguous" when the text may not mean what the parser reads: C stops at a NUL, and with the
// server's standard_conforming_strings off (the parser assumes on) a backslash-quote moves
// statement ends. Null when PostgreSQL's grammar rejects the text.
export function readPg(sql: string): PgText | "ambiguous" | null {
  if (sql.includes("\0")) return "ambiguous";
  try {
    const tokens = scanSync(sql).tokens;
    if (tokens.some((t) => ordinaryString(t) && t.text.includes("\\'"))) return "ambiguous";
    return { tree: parseSync(sql), tokens };
  } catch {
    return null;
  }
}

// A string constant as written between its delimiters, escapes kept, so it still matches the
// query text; null when no string token starts at that byte offset.
export function writtenString(tokens: ScanToken[], location: number): string | null {
  const text = tokens.find((t) => t.start === location && t.tokenType === SCONST)?.text;
  if (text === undefined) return null;
  if (text.startsWith("$")) {
    // The tag is whatever the scanner accepted, non-ASCII letters included: take it as written.
    const tag = text.slice(0, text.indexOf("$", 1) + 1);
    return text.slice(tag.length, -tag.length);
  }
  return text.replace(/^[eE]/, "").slice(1, -1);
}

// An ordinary string holding a backslash: its value depends on the server's
// standard_conforming_strings, which the parser does not know.
export function ordinaryBackslash(tokens: ScanToken[]): boolean {
  return tokens.some((t) => ordinaryString(t) && t.text.includes("\\"));
}

function ordinaryString(token: ScanToken): boolean {
  return token.tokenType === SCONST && !/^[eE$]/.test(token.text);
}
