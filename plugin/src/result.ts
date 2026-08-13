export interface Field {
  name: string;
}

export interface HistResult {
  fields: Field[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  // Serialized size of the held rows, cached so the history budget never re-stringifies.
  bytes?: number;
}

// The column order shared by the grid and every export: the declared field order when
// present, else the keys of the first row, so all surfaces agree on layout.
export function resultColumns(result: HistResult): string[] {
  if (result.fields.length) {
    return result.fields.map((f) => f.name);
  }
  return Object.keys(result.rows[0] ?? {});
}

// A hard ceiling on held rows independent of the byte budget, so one pathological
// result can never make the pager math or a stringify pass run away.
const HIST_MAX_ROWS = 100_000;

// Keep at most maxRows, then halve until the serialized payload fits the byte budget;
// the flag lets the detail view say it truncated. maxRows lets the agent-bound path cap
// tighter than local history, so a bulk read never floods the agent context.
export function capResult(
  rows: Record<string, unknown>[],
  fields: Field[],
  budgetBytes = Number.MAX_SAFE_INTEGER,
  maxRows = HIST_MAX_ROWS,
): HistResult {
  const rowCount = rows.length;
  let kept = rows.slice(0, maxRows);
  let truncated = rows.length > kept.length;
  let bytes = JSON.stringify(kept).length;
  while (kept.length > 0 && bytes > budgetBytes) {
    kept = kept.slice(0, Math.floor(kept.length / 2));
    bytes = JSON.stringify(kept).length;
    truncated = true;
  }
  return { fields, rows: kept, rowCount, truncated, bytes };
}
