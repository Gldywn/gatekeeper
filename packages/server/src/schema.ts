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
  // The plugin could not read this table's columns, or a cap cut them: an empty or short
  // column list then means "not collected", never "has none".
  incomplete?: true;
}

export interface SchemaSnapshot {
  connectionName: string;
  // The composite connection scope (name + engine + database) the schema was captured for;
  // the tool serves it only while this still matches the live connection.
  scope: string;
  // false when the human has schema access turned off; the tables are then empty and the
  // MCP tool reports it as unavailable rather than serving a stale structure.
  access: boolean;
  tables: SchemaTable[];
  // Engine catalogs the plugin left out, named so the agent reads an omission rather than
  // an absence.
  excludedSchemas: string[];
  // Liveness: bumped by every plugin heartbeat, so it says the plugin is open, not how old
  // the structure is.
  capturedAt: number;
  // When the plugin last posted a collected structure. Absent on snapshots stored by an
  // older server, which then reads as unknown.
  collectedAt?: number;
  // false when a table or column listing failed, or a cap cut tables, columns, keys or a
  // name; null when an older plugin did not say. Keys are best effort either way.
  complete?: boolean | null;
}

const MAX_TABLES = 5000;
const MAX_EXCLUDED = 100;
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
  const columns = arr(t.columns);
  const foreignKeys = arr(t.foreignKeys);
  // A cut type (a long MySQL enum list) or name would read as the real one.
  const cut = (v: unknown) => typeof v === "string" && v.length > MAX_STR;
  const incomplete =
    t.incomplete === true ||
    columns.length > MAX_COLUMNS ||
    foreignKeys.length > MAX_FKS ||
    cut(t.name) ||
    cut(t.schema) ||
    columns.some((c) => {
      const col = (c ?? {}) as Record<string, unknown>;
      return cut(col.name) || cut(col.type);
    });
  return {
    schema: t.schema == null ? null : str(t.schema),
    name: str(t.name),
    columns: columns.slice(0, MAX_COLUMNS).map(column),
    foreignKeys: foreignKeys.slice(0, MAX_FKS).map(foreignKey),
    ...(incomplete ? { incomplete: true as const } : {}),
  };
}

export function sanitizeSchema(input: Record<string, unknown>, capturedAt: number): SchemaSnapshot {
  const access = input.access === true;
  const raw = arr(input.tables);
  const tables = access ? raw.slice(0, MAX_TABLES).map(table) : [];
  const gaps = raw.length > MAX_TABLES || tables.some((t) => t.incomplete);
  const reported = typeof input.complete === "boolean" ? input.complete : null;
  return {
    connectionName: str(input.connectionName),
    scope: str(input.scope),
    access,
    tables,
    excludedSchemas: access
      ? arr(input.excludedSchemas)
          .slice(0, MAX_EXCLUDED)
          .map(str)
          .filter((s) => s.length > 0)
      : [],
    capturedAt,
    collectedAt: capturedAt,
    complete: gaps ? false : reported,
  };
}
