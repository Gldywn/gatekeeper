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

// The detail grid pages over the held (already capped) rows, never a re-query, so
// this is pure array math shared by the renderer and the overlay's page controls.
export const HIST_PAGE_SIZE = 50;

// Clamp an out-of-range page to the last valid one, then return that page's slice
// alongside the resolved page index and total page count.
export function pageSlice<T>(
  rows: T[],
  page: number,
  pageSize = HIST_PAGE_SIZE,
): { rows: T[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const clamped = Math.min(Math.max(0, Math.trunc(page)), pageCount - 1);
  const start = clamped * pageSize;
  return { rows: rows.slice(start, start + pageSize), page: clamped, pageCount };
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
