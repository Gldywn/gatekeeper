import { engineFor } from "./engine";
import { analyzeSql } from "./inspect";
import {
  type Columns,
  clientColumns,
  formatRef,
  piiColumns,
  type QueryOutput,
  type SchemaContext,
} from "./schema";

// What leaves the database for the agent, as opposed to everything the statement mentions:
// the reviewer's flags read this, while Auto mode keeps judging the whole query
// (`analyzeSql`, `sensitiveLiterals`), filters included.
export function analyzeOutput(
  sql: string,
  databaseType: string,
  columns?: Columns,
): QueryOutput | null {
  return engineFor(databaseType).output(sql, columns);
}

// The reviewer's annotation: the statement's tables, and the person and client data among the
// names of what it returns. Output that does not parse counts as untraced.
export function outputSchema(tables: string[], output: QueryOutput | null): SchemaContext {
  const names = output?.names ?? [];
  return {
    tables,
    pii: piiColumns(names),
    client: clientColumns(names),
    complete: output?.complete ?? false,
  };
}

// What the statement text alone shows: no table columns, so a SELECT * stays untraced here.
// The Audit Trail reads this instead of querying the database it audits.
export function textSchema(sql: string, databaseType: string): SchemaContext | null {
  const parsed = analyzeSql(sql, databaseType);
  return parsed
    ? outputSchema(parsed.tables.map(formatRef), analyzeOutput(sql, databaseType))
    : null;
}
