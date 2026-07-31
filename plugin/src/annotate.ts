import type { Column } from "@beekeeperstudio/plugin";
import {
  analyzeSql,
  clientColumns,
  piiColumns,
  type SchemaContext,
  sensitiveLiterals,
} from "./sql/schema";

// Live views into the owning app's state, read on demand so the annotator never
// holds a stale dialect, schema, or connection generation across an await.
interface SchemaAnnotatorDeps {
  getColumns: (table: string, schema?: string) => Promise<Column[]>;
  dialect: () => string;
  defaultSchema: () => string | undefined;
  generation: () => number;
}

// Owns the host-side schema annotation. Reads (never owns) the connection
// generation via the injected getter, so a mid-fetch connection switch can
// invalidate a column fetch that now belongs to a different database.
export class SchemaAnnotator {
  // Columns per "schema.table", populated on demand for the approval-card schema
  // annotation; cleared on a tablesChanged notification and on connection switch.
  private readonly schemaCache = new Map<string, Column[]>();
  private readonly deps: SchemaAnnotatorDeps;

  constructor(deps: SchemaAnnotatorDeps) {
    this.deps = deps;
  }

  // The tables and sensitive columns a query touches. Returns null when the SQL will
  // not parse, or undefined when a connection switch invalidated the column fetch
  // mid-flight. Host-side only: nothing here ever reaches the broker.
  async schemaFor(sql: string): Promise<SchemaContext | null | undefined> {
    const parsed = analyzeSql(sql, this.deps.dialect());
    if (!parsed) {
      return null;
    }
    const gen = this.deps.generation();
    const fallback = this.deps.defaultSchema();
    const perTable = await Promise.all(
      parsed.tables.map((t) => this.columnsFor(t.name, t.schema ?? fallback)),
    );
    if (gen !== this.deps.generation()) {
      return undefined;
    }
    const allColumns = perTable.flat().map((c) => c.name);
    return {
      tables: parsed.tables.map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name)),
      pii: piiColumns(parsed, allColumns),
      client: clientColumns(parsed, allColumns),
      literals: sensitiveLiterals(sql, this.deps.dialect()),
      star: parsed.star,
    };
  }

  clearCache(): void {
    this.schemaCache.clear();
  }

  private async columnsFor(table: string, schema: string | undefined): Promise<Column[]> {
    const key = `${schema ?? ""}.${table}`;
    const cached = this.schemaCache.get(key);
    if (cached) {
      return cached;
    }
    try {
      const columns = await this.deps.getColumns(table, schema);
      this.schemaCache.set(key, columns);
      return columns;
    } catch {
      // Unknown table (e.g. a CTE name) or a transient host error: no annotation.
      return [];
    }
  }
}
