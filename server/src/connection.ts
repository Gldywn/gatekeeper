export interface ConnectionSnapshot {
  connectionName: string;
  databaseType: string;
  databaseName: string;
  schema: string | null;
  readOnly: boolean;
  capturedAt: number;
}

// Unit separator: header-safe (0x1F ≤ 0xFF, unlike the glyph U+241F a browser
// fetch rejects) and won't occur inside a name, engine, or database.
export const SCOPE_SEP = "\u001f";

// Two connections sharing a display name but pointing at different engines/databases
// must never share state, so scoping joins name + engine + database (plain and
// debuggable, never a hash). Kept byte-identical to plugin/src/net/scope.ts.
export function connectionScopeKey(c: {
  connectionName: string;
  databaseType: string;
  databaseName: string;
}): string {
  return [c.connectionName, c.databaseType, c.databaseName].join(SCOPE_SEP);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The non-sensitive connection context the plugin shares with the agent. It
// never carries host, user, or credentials, and is informational only: any
// holder of the broker token can set it, so it must not drive authorization.
export function sanitizeConnection(
  input: Record<string, unknown>,
  capturedAt: number,
): ConnectionSnapshot {
  return {
    connectionName: str(input.connectionName),
    databaseType: str(input.databaseType),
    databaseName: str(input.databaseName),
    schema: input.schema == null ? null : str(input.schema),
    readOnly: input.readOnly === true,
    capturedAt,
  };
}
