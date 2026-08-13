import { csvFormulaGuard, csvQuote } from "../csv";
import { type HistResult, resultColumns } from "../result";

// A cell rendered as plain text for CSV/Markdown: a SQL null (or a missing key) blanks
// out, booleans and numbers stringify at full precision, an object/array inlines as
// compact JSON, and a string passes through for the caller's per-format escaping.
function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

// The formula guard rides only string-sourced cells, so a negative number stays -5 (not
// '-5) and a JSON-inlined object is never mistaken for a formula.
function csvCell(value: unknown): string {
  const text = cellText(value);
  return csvQuote(typeof value === "string" ? csvFormulaGuard(text) : text);
}

// Held rows as an RFC-4180 CSV, BOM-led and CRLF-terminated to match the audit export so
// Excel decodes it as UTF-8. Column order follows resultColumns() (shared with the grid).
export function resultCsv(result: HistResult): string {
  const cols = resultColumns(result);
  const header = cols.map((name) => csvQuote(csvFormulaGuard(name))).join(",");
  const rows = result.rows.map((row) => cols.map((name) => csvCell(row[name])).join(","));
  const body = [header, ...rows].join("\r\n");
  return `\ufeff${body}\r\n`;
}

// Pipes are escaped so a value can't break the column structure, and any newline is
// collapsed to a space so each row stays on one Markdown line.
function mdEscape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

// Held rows as a GitHub-flavoured Markdown table, columns in resultColumns() order.
export function resultMarkdown(result: HistResult): string {
  const cols = resultColumns(result);
  const header = `| ${cols.map(mdEscape).join(" | ")} |`;
  const divider = `| ${cols.map(() => "---").join(" | ")} |`;
  const rows = result.rows.map(
    (row) => `| ${cols.map((name) => mdEscape(cellText(row[name]))).join(" | ")} |`,
  );
  return `${[header, divider, ...rows].join("\n")}\n`;
}

// Held rows as an array of row objects keyed by column in resultColumns() order, native
// types preserved (nested objects, numbers, booleans); a missing/undefined cell is null.
export function resultJson(result: HistResult): string {
  const cols = resultColumns(result);
  const rows = result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const name of cols) {
      const v = row[name];
      obj[name] = v === undefined ? null : v;
    }
    return obj;
  });
  return `${JSON.stringify(rows, null, 2)}\n`;
}
