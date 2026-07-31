import { escapeHtml, escapeRegExp } from "./html";

// Wrap the given column names where they appear in the highlighted SQL. The guards
// keep a match from landing inside an existing highlight span, a string, or a longer
// word, so passes for different classes compose without corrupting each other.
function markColumns(html: string, columns: readonly string[] | undefined, cls: string): string {
  if (!columns?.length) {
    return html;
  }
  const flag = new RegExp(`(?<![\\w>"'])(${columns.map(escapeRegExp).join("|")})(?![\\w<])`, "gi");
  return html.replace(flag, `<span class="${cls}">$1</span>`);
}

export function highlight(
  sql: string,
  pii?: readonly string[],
  client?: readonly string[],
  literals?: readonly string[],
): string {
  const sensitive = new Set(literals ?? []);
  let html = escapeHtml(sql)
    .replace(
      /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|LIMIT|AS|AND|OR|JOIN|ON|INTERVAL|DELETE|UPDATE|INSERT|WITH)\b/g,
      '<span class="kw">$1</span>',
    )
    .replace(/\b(count|sum|now|avg|max|min)\b/g, '<span class="fn">$1</span>')
    // A string literal exposing a sensitive value gets an extra class so the value,
    // not just the column, stands out in the query text.
    .replace(
      /('[^']*')/g,
      (m) => `<span class="st${sensitive.has(m.slice(1, -1)) ? " sensitive-val" : ""}">${m}</span>`,
    );
  html = markColumns(html, pii, "pii-col");
  html = markColumns(html, client, "client-col");
  return html;
}
