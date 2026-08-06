// The database's structural skeleton the plugin optionally shares with agents: tables,
// columns, types, keys — never a row, a default expression, a view/function body, or a
// comment. Any token holder can post it, so sanitize defensively and cap the size.

export interface SchemaColumn {
  name: string;
  type: string;
  primaryKey: boolean;
}

export interface SchemaForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface SchemaTable {
  schema: string | null;
  name: string;
  columns: SchemaColumn[];
  foreignKeys: SchemaForeignKey[];
}

export interface SchemaSnapshot {
  connectionName: string;
  // false when the human has schema access turned off; the tables are then empty and the
  // MCP tool reports it as unavailable rather than serving a stale structure.
  access: boolean;
  tables: SchemaTable[];
  capturedAt: number;
}

const MAX_TABLES = 5000;
const MAX_COLUMNS = 1000;
const MAX_FKS = 1000;
const MAX_STR = 512;

function str(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_STR) : "";
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function column(input: unknown): SchemaColumn {
  const c = (input ?? {}) as Record<string, unknown>;
  return {
    name: str(c.name),
    type: str(c.type),
    primaryKey: c.primaryKey === true,
  };
}

function foreignKey(input: unknown): SchemaForeignKey {
  const f = (input ?? {}) as Record<string, unknown>;
  return { column: str(f.column), refTable: str(f.refTable), refColumn: str(f.refColumn) };
}

function table(input: unknown): SchemaTable {
  const t = (input ?? {}) as Record<string, unknown>;
  return {
    schema: t.schema == null ? null : str(t.schema),
    name: str(t.name),
    columns: arr(t.columns).slice(0, MAX_COLUMNS).map(column),
    foreignKeys: arr(t.foreignKeys).slice(0, MAX_FKS).map(foreignKey),
  };
}

export function sanitizeSchema(input: Record<string, unknown>, capturedAt: number): SchemaSnapshot {
  const access = input.access === true;
  return {
    connectionName: str(input.connectionName),
    access,
    tables: access ? arr(input.tables).slice(0, MAX_TABLES).map(table) : [],
    capturedAt,
  };
}
