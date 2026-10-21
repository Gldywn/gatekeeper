import { type CellComponent, type ColumnDefinition, TabulatorFull } from "tabulator-tables";
import { formatCount } from "../html";
import { type HistResult, resultColumns } from "../result";
import { classifyColumn } from "../sql/schema";

// Values are sampled, not fully scanned, to decide a column's alignment/sorter: enough
// to classify without walking 100k held rows.
const NUMERIC_SAMPLE = 40;
// Only clipped-enough strings earn a hover tooltip, so short cells stay quiet.
const TOOLTIP_MIN_CHARS = 40;
const PAGE_SIZES = [10, 25, 50, 100];

// Display only: sorting, resize and reorder are read-only affordances. The caller sizes it to
// the pane that scrolls it, so the column headers stay in view once the pane reaches the grid.
export function mountResultGrid(
  host: HTMLElement,
  result: HistResult,
  maxHeight: number,
  // The result bar: Tabulator's pager mounts in `pager`, the position is written to `count`.
  bar?: { pager: HTMLElement; count: HTMLElement },
): TabulatorFull {
  const names = resultColumns(result);
  const table = new TabulatorFull(host, {
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
    paginationSizeSelector: PAGE_SIZES,
    // In the bar, Tabulator drops its own counter (Page.js mounts it only without
    // paginationElement), so the position is written below from the page it loaded.
    ...(bar
      ? {
          paginationElement: bar.pager,
          paginationButtonCount: 3,
          // Arrows keep the bar on one line; the buttons keep their full titles for readers.
          langs: {
            default: {
              pagination: { first: "«", prev: "‹", next: "›", last: "»", page_size: "Rows" },
            },
          },
        }
      : { paginationCounter: "rows" }),
    columnDefaults: {
      formatter: (cell) => renderValue(cell.getValue()),
      tooltip: cellTooltip,
      resizable: true,
      minWidth: 80,
    },
  });
  if (bar) {
    const total = result.rows.length;
    const position = () => {
      const size = Number(table.getPageSize()) || total;
      const page = Number(table.getPage()) || 1;
      const from = total ? (page - 1) * size + 1 : 0;
      const to = Math.min(page * size, total);
      // A last page of one row reads "11 of 11", not "11–11 of 11".
      const span = from === to ? formatCount(to) : `${formatCount(from)}–${formatCount(to)}`;
      bar.count.textContent = `${span} of ${formatCount(total)}`;
      // One page needs no page buttons; the size choice stays while a smaller size would page.
      bar.pager.toggleAttribute("data-single", total <= size);
      bar.pager.hidden = total <= PAGE_SIZES[0];
    };
    table.on("tableBuilt", position);
    table.on("pageLoaded", position);
  }
  return table;
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
