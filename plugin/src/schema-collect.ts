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
  access: boolean;
  tables: CollectedTable[];
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

export async function collectSchema(connectionName: string): Promise<CollectedSchema> {
  const schemas = await safe(() => getSchemas(), [] as string[]);
  // A single undefined pass covers engines with no schema concept (SQLite, MySQL).
  const passes: (string | undefined)[] = schemas.length > 0 ? schemas : [undefined];
  const tables: CollectedTable[] = [];
  for (const schema of passes) {
    const list = await safe(() => getTables(schema), []);
    for (const t of list) {
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
  return { connectionName, access: true, tables };
}
