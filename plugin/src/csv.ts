// RFC 4180 field: double internal quotes and wrap when the value carries a comma,
// quote, or newline. Always data-preserving, so safe on every cell.
export function csvQuote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// A leading =, +, -, or @ is neutralised with a ' so a spreadsheet imports the cell as
// text, not a formula. Leading whitespace/tab/CR is stripped by spreadsheets first, so a
// trigger hidden behind it still counts. Only for string cells: a number like -5 stays -5.
export function csvFormulaGuard(value: string): string {
  return /^\s*[=+\-@]/.test(value) || /^[\t\r]/.test(value) ? `'${value}` : value;
}
