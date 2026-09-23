import type { Column } from "@beekeeperstudio/plugin";
import {
  planRead,
  type ReadSnapshot,
  readMetadataSql,
  readSearchPathSql,
  resolveRead,
  searchPathVerified,
} from "./sql/read-analysis";
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
  // Runs one catalog-only query built by the dialect module, never the proposal itself.
  getMetadata?: (sql: string) => Promise<Record<string, unknown>[]>;
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
  private revision = 0;

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
    const revision = this.revision;
    const fallback = this.deps.defaultSchema();
    const perTable = await Promise.all(
      parsed.tables.map((t) => this.columnsFor(t.name, t.schema ?? fallback)),
    );
    if (gen !== this.deps.generation() || revision !== this.revision) {
      return undefined;
    }
    const allColumns = perTable.flatMap((columns) => columns ?? []).map((c) => c.name);
    const analysis = this.deps.getMetadata
      ? perTable.some((columns) => columns === null)
        ? { complete: false, reasons: ["Metadata unavailable"] }
        : await this.inspectRead(sql)
      : undefined;
    if (gen !== this.deps.generation() || revision !== this.revision) return undefined;
    const inspectedColumns = analysis?.complete
      ? (analysis.input?.dependencies.map((column) => column.column) ?? [])
      : allColumns;
    return {
      tables: parsed.tables.map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name)),
      pii: piiColumns(parsed, inspectedColumns),
      client: clientColumns(parsed, inspectedColumns),
      literals: sensitiveLiterals(sql, this.deps.dialect()),
      star: parsed.star,
      ...(this.deps.getMetadata ? { analysis } : {}),
    };
  }

  clearCache(): void {
    this.revision++;
    this.schemaCache.clear();
  }

  async inspectRead(
    sql: string,
    authorized: () => boolean = () => true,
  ): Promise<ReadSnapshot | undefined> {
    const plan = planRead(sql, this.deps.dialect());
    if (typeof plan === "string") return { complete: false, reasons: [plan] };
    if (!this.deps.getMetadata) return { complete: false, reasons: ["Metadata unavailable"] };
    const generation = this.deps.generation();
    const revision = this.revision;
    const current = () =>
      authorized() && generation === this.deps.generation() && revision === this.revision;
    try {
      if (!current()) return undefined;
      const path = await this.deps.getMetadata(readSearchPathSql());
      if (!current()) return undefined;
      if (!searchPathVerified(path))
        return {
          complete: false,
          reasons: ["PostgreSQL catalog must come first in the search path"],
        };
      const rows = await this.deps.getMetadata(readMetadataSql(plan));
      if (!current()) return undefined;
      return resolveRead(plan, rows);
    } catch {
      return current() ? { complete: false, reasons: ["Metadata unavailable"] } : undefined;
    }
  }

  private async columnsFor(table: string, schema: string | undefined): Promise<Column[] | null> {
    const key = `${schema ?? ""}.${table}`;
    const cached = this.schemaCache.get(key);
    if (cached) {
      return cached;
    }
    try {
      const generation = this.deps.generation();
      const revision = this.revision;
      const columns = await this.deps.getColumns(table, schema);
      if (generation === this.deps.generation() && revision === this.revision)
        this.schemaCache.set(key, columns);
      return columns;
    } catch {
      // Unknown table (e.g. a CTE name) or a transient host error: no annotation.
      return null;
    }
  }
}
