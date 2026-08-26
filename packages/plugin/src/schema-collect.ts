import {
  getColumns,
  getOutgoingKeys,
  getPrimaryKeys,
  getSchemas,
  getTables,
} from "@beekeeperstudio/plugin";

// The structural payload posted to the broker for the get_schema tool: tables, columns,
// types, primary and foreign keys — sourced from the host SDK, never raw SQL, never a row.

interface CollectedColumn {
  name: string;
  type: string;
  primaryKey: boolean;
}
interface CollectedForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}
interface CollectedTable {
  schema: string | null;
  name: string;
  columns: CollectedColumn[];
  foreignKeys: CollectedForeignKey[];
}
export interface CollectedSchema {
  connectionName: string;
  // The composite connection scope (name + engine + database); the server serves the schema
  // only when it still matches the live connection, so a switch never leaks the wrong db.
  scope: string;
  access: boolean;
  tables: CollectedTable[];
  // Named so the agent knows the catalogs exist and were omitted, rather than concluding
  // the database has none.
  excludedSchemas: string[];
}

// Excluded by name, not by keeping only `public`: an allow-list would also drop real user
// schemas such as PostGIS `topology` or Supabase `auth`. A trivial Postgres database
// reports 209 catalog tables against 5 of its own.
function isSystemSchema(schema: string, databaseType: string): boolean {
  const s = schema.toLowerCase();
  if (s === "information_schema") {
    return true;
  }
  switch (databaseType) {
    case "mysql":
    case "mariadb":
      return s === "mysql" || s === "performance_schema" || s === "sys";
    case "sqlserver":
      return s === "sys";
    case "sqlite":
    case "bigquery":
    case "snowflake":
      return false;
    default:
      // Postgres reserves the `pg_` prefix, so this cannot swallow a user schema, and it
      // covers pg_toast and the per-session pg_temp_N.
      return s.startsWith("pg_");
  }
}

// SQLite has no schemas; its internal tables carry the reserved `sqlite_` prefix instead.
function isSystemTable(name: string, databaseType: string): boolean {
  return databaseType === "sqlite" && name.toLowerCase().startsWith("sqlite_");
}

// Some engines/drivers don't implement every introspection call; treat any failure as an
// empty result rather than aborting the whole collection.
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function joinCols(value: string | string[]): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

export async function collectSchema(
  connectionName: string,
  scope: string,
  databaseType: string,
): Promise<CollectedSchema> {
  const schemas = await safe(() => getSchemas(), [] as string[]);
  const excludedSchemas = schemas.filter((s) => isSystemSchema(s, databaseType));
  const kept = schemas.filter((s) => !isSystemSchema(s, databaseType));
  // A single undefined pass covers engines with no schema concept (SQLite, MySQL).
  const passes: (string | undefined)[] = kept.length > 0 ? kept : [undefined];
  const tables: CollectedTable[] = [];
  for (const schema of passes) {
    const list = await safe(() => getTables(schema), []);
    for (const t of list) {
      if (isSystemTable(t.name, databaseType) || isSystemSchema(t.schema ?? "", databaseType)) {
        continue;
      }
      const tableSchema = t.schema ?? schema;
      const [cols, pks, fks] = await Promise.all([
        safe(() => getColumns(t.name, tableSchema), []),
        safe(() => getPrimaryKeys(t.name, tableSchema), []),
        safe(() => getOutgoingKeys(t.name, tableSchema), []),
      ]);
      const pk = new Set(pks.map((p) => p.columnName));
      tables.push({
        schema: tableSchema ?? null,
        name: t.name,
        columns: cols.map((c) => ({ name: c.name, type: c.type, primaryKey: pk.has(c.name) })),
        foreignKeys: fks.map((f) => ({
          column: joinCols(f.fromColumn),
          refTable: f.toSchema ? `${f.toSchema}.${f.toTable}` : f.toTable,
          refColumn: joinCols(f.toColumn),
        })),
      });
    }
  }
  return { connectionName, scope, access: true, tables, excludedSchemas };
}
