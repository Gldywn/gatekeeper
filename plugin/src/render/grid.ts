import { type CellComponent, type ColumnDefinition, TabulatorFull } from "tabulator-tables";
import { type HistResult, resultColumns } from "../result";
import { classifyColumn } from "../sql/schema";

// Values are sampled, not fully scanned, to decide a column's alignment/sorter: enough
// to classify without walking 100k held rows.
const NUMERIC_SAMPLE = 40;
// Only clipped-enough strings earn a hover tooltip, so short cells stay quiet.
const TOOLTIP_MIN_CHARS = 40;

// Mount Tabulator on the detail overlay's grid host, fed the already-capped rows
// (capResult stays the source of truth for the memory cap and the truncation footer).
// Display only: no editing, sorting/resize/reorder are read-only affordances.
export function mountResultGrid(host: HTMLElement, result: HistResult): TabulatorFull {
  const names = resultColumns(result);
  // Size the grid to the space left below its host so the detail popup never overflows the
  // viewport (only the tableholder scrolls); read from the host's live position, so a long
  // or short query above it simply gives the grid less or more room.
  const maxHeight = Math.max(
    240,
    Math.floor(window.innerHeight - host.getBoundingClientRect().top - 80),
  );
  return new TabulatorFull(host, {
    data: result.rows,
    columns: names.map((name) => columnDef(name, result.rows)),
    // fitColumns fills the overlay width so there's no dead gutter; many columns keep
    // their minWidth and scroll horizontally rather than squashing unreadably.
    layout: "fitColumns",
    maxHeight,
    movableColumns: true,
    // Treat a column name literally; a dotted DB column must not be read as a nested path.
    nestedFieldSeparator: false,
    // Client-side paging with the sizes the reviewer had before virtualization replaced it.
    pagination: true,
    paginationSize: 50,
    paginationSizeSelector: [10, 25, 50, 100],
    paginationCounter: "rows",
    columnDefaults: {
      formatter: (cell) => renderValue(cell.getValue()),
      tooltip: cellTooltip,
      resizable: true,
      minWidth: 80,
    },
  });
}

function columnDef(name: string, rows: Record<string, unknown>[]): ColumnDefinition {
  const numeric = isNumericColumn(name, rows);
  // The pii/client accent rides the same cssClass that Tabulator applies to header and
  // cells, so a sensitive column reads at a glance in the result as it does in the flags.
  const classes = [classifyColumn(name), numeric ? "gk-col-num" : null].filter(Boolean).join(" ");
  return {
    title: name,
    field: name,
    hozAlign: numeric ? "right" : "left",
    headerHozAlign: numeric ? "right" : "left",
    sorter: numeric ? "number" : "string",
    cssClass: classes || undefined,
  };
}

// A column is numeric only when every non-null sampled value is a number, so a mixed or
// string column keeps left alignment and lexical sort.
function isNumericColumn(field: string, rows: Record<string, unknown>[]): boolean {
  let seen = 0;
  for (const row of rows) {
    const v = row[field];
    if (v === null || v === undefined) {
      continue;
    }
    if (typeof v !== "number") {
      return false;
    }
    if (++seen >= NUMERIC_SAMPLE) {
      break;
    }
  }
  return seen > 0;
}

// Type-aware cell: a DOM node (never innerHTML) so DB values can never inject markup.
function renderValue(value: unknown): HTMLElement {
  if (value === null || value === undefined) {
    // A real SQL null: a muted chip, deliberately distinct from the string "NULL".
    return span("gk-null", "NULL");
  }
  if (typeof value === "number") {
    return span("gk-num", String(value));
  }
  if (typeof value === "boolean") {
    return span(value ? "gk-bool is-true" : "gk-bool is-false", String(value));
  }
  if (typeof value === "object") {
    // Compact one-line preview; the full pretty-printed JSON expands in the tooltip.
    return span("gk-json", JSON.stringify(value) ?? "null");
  }
  return span("gk-text", String(value));
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

// The hover expansion: pretty-printed JSON for objects/arrays, the full string for a
// clipped long value, nothing for short primitives (false hides the tooltip).
function cellTooltip(_event: Event, cell: CellComponent): HTMLElement | string | boolean {
  const value = cell.getValue();
  if (value && typeof value === "object") {
    const pre = document.createElement("pre");
    pre.className = "gk-json-pop";
    pre.textContent = JSON.stringify(value, null, 2);
    return pre;
  }
  if (typeof value === "string" && value.length > TOOLTIP_MIN_CHARS) {
    return value;
  }
  // Empty string = no tooltip; returning the boolean false surfaced a stray "false".
  return "";
}
