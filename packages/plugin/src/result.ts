export interface Field {
  name: string;
}

export interface HistResult {
  fields: Field[];
  rows: Record<string, unknown>[];
  /** Rows the query returned. null when only an Audit Trail entry is left and it recorded none. */
  rowCount: number | null;
  /** Rows a write changed. Absent means the host did not report it, never zero. */
  affectedRows?: number;
  truncated: boolean;
}

// The column order shared by the grid and every export: the declared field order when
// present, else the keys of the first row, so all surfaces agree on layout.
export function resultColumns(result: HistResult): string[] {
  if (result.fields.length) {
    return result.fields.map((f) => f.name);
  }
  return Object.keys(result.rows[0] ?? {});
}

// What the agent is sent, and so what the history keeps: a bulk read must never flood the
// agent context, the LLM provider or the broker's body, which also carries the sealed copy.
export const RESULT_MAX_ROWS = 10_000;
export const RESULT_MAX_BYTES = 8 * 1024 * 1024;

const utf8 = new TextEncoder();

// Measured in UTF-8 bytes over the whole result, the size the broker and the kept copy hold.
// Fields too large on their own leave only the counts; the true row count always survives.
export function capResult(
  rows: Record<string, unknown>[],
  fields: Field[],
  budgetBytes = RESULT_MAX_BYTES,
  maxRows = RESULT_MAX_ROWS,
  affectedRows?: number,
): HistResult {
  const shape = (kept: Record<string, unknown>[], f: Field[], truncated: boolean): HistResult => ({
    fields: f,
    rows: kept,
    rowCount: rows.length,
    truncated,
    ...(affectedRows === undefined ? {} : { affectedRows }),
  });
  const fits = (r: HistResult) => utf8.encode(JSON.stringify(r)).length <= budgetBytes;
  let result = shape(rows.slice(0, maxRows), fields, rows.length > maxRows);
  while (result.rows.length > 0 && !fits(result)) {
    result = shape(result.rows.slice(0, Math.floor(result.rows.length / 2)), fields, true);
  }
  return fits(result) ? result : shape([], [], true);
}
