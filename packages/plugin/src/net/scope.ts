// Unit separator: header-safe (0x1F ≤ 0xFF, so fetch accepts it in a header value,
// unlike the glyph U+241F) and won't occur inside a name, engine, or database.
export const SCOPE_SEP = "\u001f";

// Two connections sharing a display name but pointing at different engines/databases
// must never share state, so scoping joins name + engine + database (plain and
// debuggable, never a hash). Kept byte-identical to server/src/connection.ts.
export function connectionScopeKey(c: {
  connectionName: string;
  databaseType: string;
  databaseName: string;
}): string {
  return [c.connectionName, c.databaseType, c.databaseName].join(SCOPE_SEP);
}
