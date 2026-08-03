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

// A hard ceiling on held rows independent of the byte budget, so one pathological
// result can never make the pager math or a stringify pass run away.
const HIST_MAX_ROWS = 100_000;

// Keep at most HIST_MAX_ROWS, then halve until the serialized payload fits the byte
// budget; the flag lets the detail view say it truncated. budgetBytes defaults open so
// callers that do not bound bytes (tests) still cap by the row ceiling.
export function capResult(
  rows: Record<string, unknown>[],
  fields: Field[],
  budgetBytes = Number.MAX_SAFE_INTEGER,
): HistResult {
  const rowCount = rows.length;
  let kept = rows.slice(0, HIST_MAX_ROWS);
  let truncated = rows.length > kept.length;
  let bytes = JSON.stringify(kept).length;
  while (kept.length > 0 && bytes > budgetBytes) {
    kept = kept.slice(0, Math.floor(kept.length / 2));
    bytes = JSON.stringify(kept).length;
    truncated = true;
  }
  return { fields, rows: kept, rowCount, truncated, bytes };
}
