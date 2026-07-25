export interface Field {
  name: string;
}

export interface HistResult {
  fields: Field[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

const HIST_MAX_ROWS = 200;
const HIST_MAX_ITEM_BYTES = 512 * 1024;

// Keep at most HIST_MAX_ROWS, then shrink further until the serialized payload
// fits the per-item byte budget; the flag lets the detail view say it truncated.
export function capResult(rows: Record<string, unknown>[], fields: Field[]): HistResult {
  const rowCount = rows.length;
  let kept = rows.slice(0, HIST_MAX_ROWS);
  let truncated = rows.length > kept.length;
  while (kept.length > 0 && JSON.stringify(kept).length > HIST_MAX_ITEM_BYTES) {
    kept = kept.slice(0, Math.floor(kept.length / 2));
    truncated = true;
  }
  return { fields, rows: kept, rowCount, truncated };
}

export function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
