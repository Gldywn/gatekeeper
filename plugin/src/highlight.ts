import { type Tok, tokenize } from "./format";
import { escapeHtml } from "./html";

// Case-sensitive by design: the previous regex pass matched only the uppercase
// spellings, so INTERVAL etc. read as keywords only when written that way.
const KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "LIMIT",
  "AS",
  "AND",
  "OR",
  "JOIN",
  "ON",
  "INTERVAL",
  "DELETE",
  "UPDATE",
  "INSERT",
  "WITH",
]);
const FUNCTIONS = new Set(["count", "sum", "now", "avg", "max", "min"]);

// A qualified name such as "u.company_name" is classified on, and wraps, only its
// last segment, leaving the "u." qualifier outside the span, as the old pass did.
function lastSegment(word: string): string {
  const dot = word.lastIndexOf(".");
  return dot === -1 ? word : word.slice(dot + 1);
}

function classifyWord(
  word: string,
  piiSet: ReadonlySet<string>,
  clientSet: ReadonlySet<string>,
): string {
  if (KEYWORDS.has(word)) {
    return `<span class="kw">${word}</span>`;
  }
  if (FUNCTIONS.has(word)) {
    return `<span class="fn">${word}</span>`;
  }
  const seg = lastSegment(word);
  const key = seg.toLowerCase();
  const cls = piiSet.has(key) ? "pii-col" : clientSet.has(key) ? "client-col" : "";
  if (!cls) {
    return escapeHtml(word);
  }
  const prefix = word.slice(0, word.length - seg.length);
  return `${escapeHtml(prefix)}<span class="${cls}">${escapeHtml(seg)}</span>`;
}

// Walking the shared tokenizer keeps a match from ever landing inside a string,
// comment, or an existing span, which the regex-over-escaped-HTML pass could not.
export function highlight(
  sql: string,
  pii?: readonly string[],
  client?: readonly string[],
  literals?: readonly string[],
): string {
  const piiSet = new Set((pii ?? []).map((c) => c.toLowerCase()));
  const clientSet = new Set((client ?? []).map((c) => c.toLowerCase()));
  const sensitive = new Set(literals ?? []);
  const toks: Tok[] = tokenize(sql);
  let out = "";

  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === "word") {
      // "GROUP BY"/"ORDER BY" were matched as one keyword phrase (single space).
      if (
        (tk.v === "GROUP" || tk.v === "ORDER") &&
        toks[i + 1]?.t === "ws" &&
        toks[i + 1].v === " " &&
        toks[i + 2]?.t === "word" &&
        toks[i + 2].v === "BY"
      ) {
        out += `<span class="kw">${tk.v} BY</span>`;
        i += 2;
        continue;
      }
      out += classifyWord(tk.v, piiSet, clientSet);
      continue;
    }
    if (tk.t === "str") {
      const quote = tk.v[0];
      const closed = tk.v.length >= 2 && tk.v.endsWith(quote);
      const inner = closed ? tk.v.slice(1, -1) : tk.v.slice(1);
      // Single quotes are a value literal; a flagged value adds "sensitive-val".
      if (quote === "'") {
        const cls = sensitive.has(inner) ? "st sensitive-val" : "st";
        out += `<span class="${cls}">${escapeHtml(tk.v)}</span>`;
        continue;
      }
      // Double-quote (ANSI) and backtick (MySQL) quote an identifier, not a value,
      // so a quoted PII/client column must keep its flag.
      const key = inner.toLowerCase();
      const cls = piiSet.has(key) ? "pii-col" : clientSet.has(key) ? "client-col" : "";
      if (cls) {
        const close = closed ? quote : "";
        out += `${escapeHtml(quote)}<span class="${cls}">${escapeHtml(inner)}</span>${escapeHtml(close)}`;
        continue;
      }
      out += escapeHtml(tk.v);
      continue;
    }
    out += escapeHtml(tk.v);
  }
  return out;
}
