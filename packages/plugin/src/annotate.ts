import type { Column, TableIndex } from "@beekeeperstudio/plugin";
import {
  checkLoad,
  type Facts,
  LARGE_ROWS,
  type LoadResult,
  loadStatsSql,
  MAX_RELATIONS,
  parseLoadStats,
  planLoad,
  relKey,
  type StatRow,
} from "./sql/load";
import { analyzeOutput, outputSchema } from "./sql/output";
import {
  planRead,
  type ReadSnapshot,
  readMetadataSql,
  readSearchPathSql,
  resolveRead,
  searchPathVerified,
} from "./sql/read-analysis";
import { analyzeSql, formatRef, type SchemaContext, type TableRef } from "./sql/schema";

const refKey = (ref: TableRef) => `${ref.schema ?? ""}.${ref.name}`;

// Live views into the owning app's state, read on demand so the annotator never
// holds a stale dialect, schema, or connection generation across an await.
interface SchemaAnnotatorDeps {
  getColumns: (table: string, schema?: string) => Promise<Column[]>;
  // Runs one catalog-only query built by the dialect module, never the proposal itself.
  getMetadata?: (sql: string) => Promise<Record<string, unknown>[]>;
  // Beekeeper 5.5 and later; absent or failing means the index list is unknown.
  getIndexes?: (table: string, schema?: string) => Promise<TableIndex[]>;
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

  // Null when the SQL will not parse, undefined when a connection switch invalidated the fetch.
  // Host-side only: no table or column name from here ever reaches the broker.
  async schemaFor(sql: string): Promise<SchemaContext | null | undefined> {
    const dialect = this.deps.dialect();
    const parsed = analyzeSql(sql, dialect);
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
    // A host that lists no column for a table it cannot see leaves that table's star unknown.
    const live = new Map(
      parsed.tables.map((t, i) => {
        const columns = perTable[i];
        return [refKey(t), columns?.length ? columns.map((c) => c.name) : null];
      }),
    );
    const output = analyzeOutput(sql, dialect, (ref) => live.get(refKey(ref)) ?? null);
    return outputSchema(parsed.tables.map(formatRef), output);
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
    const getMetadata = this.deps.getMetadata;
    if (!getMetadata) return { complete: false, reasons: ["Metadata unavailable"] };
    const generation = this.deps.generation();
    const revision = this.revision;
    const current = () =>
      authorized() && generation === this.deps.generation() && revision === this.revision;
    // Only a host rejection means the query failed. Building the catalog SQL or validating
    // its rows can fail too, and those stay "Metadata unavailable".
    const query = async (text: string) => {
      try {
        return await getMetadata(text);
      } catch {
        return null;
      }
    };
    const failed = { complete: false, reasons: ["Metadata query failed"] };
    try {
      if (!current()) return undefined;
      const path = await query(readSearchPathSql());
      if (!current()) return undefined;
      if (!path) return failed;
      if (!searchPathVerified(path))
        return {
          complete: false,
          reasons: ["PostgreSQL catalog must come first in the search path"],
        };
      const rows = await query(readMetadataSql(plan));
      if (!current()) return undefined;
      if (!rows) return failed;
      return resolveRead(plan, rows);
    } catch {
      return current() ? { complete: false, reasons: ["Metadata unavailable"] } : undefined;
    }
  }

  // Undefined when the answer went stale. authorized() is checked before every host call:
  // the SDK cannot cancel a call already sent, so none may start after a decision or switch.
  async inspectLoad(
    sql: string,
    authorized: () => boolean = () => true,
  ): Promise<LoadResult | undefined> {
    const dialect = this.deps.dialect();
    const plan = planLoad(sql, dialect);
    if (!plan.relations.length) return checkLoad(plan, new Map());
    if (plan.relations.length > MAX_RELATIONS) return checkLoad(plan, "skipped");
    const generation = this.deps.generation();
    const revision = this.revision;
    const current = () =>
      authorized() && generation === this.deps.generation() && revision === this.revision;
    const pg = dialect === "postgresql";
    let stats: StatRow[] | null = null;
    if (pg) {
      if (!this.deps.getMetadata) return checkLoad(plan, "unavailable");
      try {
        if (!current()) return undefined;
        const path = await this.deps.getMetadata(readSearchPathSql());
        if (!current()) return undefined;
        if (searchPathVerified(path))
          stats = parseLoadStats(
            plan.relations,
            await this.deps.getMetadata(loadStatsSql(plan.relations)),
          );
      } catch {
        stats = null;
      }
      if (!current()) return undefined;
      if (!stats) return checkLoad(plan, "unavailable");
    }
    const facts: Facts = new Map();
    await Promise.all(
      plan.relations.map(async (rel, i) => {
        const stat = stats?.[i];
        const schema = stat?.schema ?? rel.schema ?? this.deps.defaultSchema();
        // Only a large relation is ever judged on its indexes.
        const indexes =
          stat?.rows != null && stat.rows >= LARGE_ROWS && current()
            ? await this.indexesFor(rel.table, schema)
            : null;
        const columns = current() ? await this.columnsFor(rel.table, schema) : null;
        facts.set(relKey(rel), {
          rows: stat?.rows ?? null,
          kind: stat?.kind,
          rls: stat?.rls ?? null,
          indexed: indexes && new Set(indexes.flatMap((ix) => ix.columns.map((c) => c.name))),
          leading:
            indexes &&
            new Set(indexes.flatMap((ix) => (ix.columns[0] ? [ix.columns[0].name] : []))),
          unique:
            indexes
              ?.filter((ix) => ix.unique || ix.primary)
              .map((ix) => ix.columns.map((c) => c.name)) ?? null,
          columns: columns?.map((c) => c.name) ?? null,
        });
      }),
    );
    if (!current()) return undefined;
    return checkLoad(plan, facts);
  }

  private async indexesFor(
    table: string,
    schema: string | undefined,
  ): Promise<TableIndex[] | null> {
    if (!this.deps.getIndexes) return null;
    try {
      return await this.deps.getIndexes(table, schema);
    } catch {
      return null;
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
