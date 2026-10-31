import type { AccessMode } from "@gatekeeper/shared";

// The plugin's risk class is the shared access mode; kept as a local alias so the many
// call sites that import RiskClass keep working.
export type RiskClass = AccessMode;

export interface RiskVerdict {
  // Highest risk the statement carries.
  class: RiskClass;
  // false when the class came from the textual fallback, not a real parse.
  parseOk: boolean;
  // Multi-statement or unclassifiable: no mode may approve it.
  blocked: boolean;
}

const RANK: Record<RiskClass, number> = { read: 0, write: 1, destructive: 2 };

export function rank(c: RiskClass): number {
  return RANK[c];
}

// The left edge is no word boundary: a number ends at a letter (SELECT 1e1INTO OUTFILE ...),
// and a PostgreSQL dollar quote at its closing $ (SELECT $$a$$INTO TABLE t).
const LOCKING_READ =
  /(?<![A-Za-z_])(?:for\s+(update|share|no\s+key\s+update|key\s+share)\b|lock\s+in\s+share\s+mode\b)/i;
const MODIFY_KEYWORDS =
  /(?<![A-Za-z_])(insert|update|delete|drop|truncate|alter|create|replace|merge|grant|revoke|call|vacuum|pragma|attach|copy|into|lock)\b/i;

// The comments every engine closes at the same place: `--` plus whitespace, up to LF, CRLF or
// the end (SQLite runs past a lone CR), and a non-executable /* */ with no nested opener.
const LEADING_COMMENTS =
  /^(?:\s+|--(?=[ \t\r\n]|$)[^\r\n]*(?:\r?\n|$)|\/\*(?!M?!)(?:(?!\/\*)[\s\S])*?\*\/)*/;

// Blanks each closed comment `comment` opens. Past the last `*/` none can close, so that tail is
// left as written: linear on many unclosed `/*`, and a `/*` in a string deletes nothing.
function blankClosed(sql: string, comment: RegExp): string {
  const end = sql.lastIndexOf("*/") + 2;
  return end < 2 ? sql : `${sql.slice(0, end).replace(comment, " ")}${sql.slice(end)}`;
}

// A match in any view escalates: markers spaced out (/*!50000INTO), deleting nothing; MySQL's
// reading (/*! bodies run, /*M! is a comment); MariaDB's (both run); every comment dropped, as
// an engine skips a newer version's body. Comments become spaces, so FOR/**/SHARE meets.
function matches(re: RegExp, sql: string): boolean {
  const spaced = (text: string) => text.replace(/--[^\r\n]*|\/\*M?!\d*|\*\//g, " ");
  const views = [
    sql.replace(/\/\*M?!\d*/g, " "),
    spaced(blankClosed(sql, /\/\*(?!!)[\s\S]*?\*\//g)),
    spaced(blankClosed(sql, /\/\*(?!M?!)[\s\S]*?\*\//g)),
    blankClosed(sql, /\/\*[\s\S]*?\*\//g).replace(/--[^\r\n]*/g, " "),
  ];
  return views.some((view) => re.test(view));
}

// Statements no engine can read fall back to text: reject empty/multi, a leading SELECT/WITH
// with no modifying keyword reads, everything else is destructive (fail safe).
export function fallback(sql: string): RiskVerdict {
  // No parser found the strings, so nothing past the leading comments is removed: a '--'
  // or '/*' inside a string would otherwise swallow the SQL after it.
  const single = sql
    .slice(LEADING_COMMENTS.exec(sql)?.[0].length ?? 0)
    .trim()
    .replace(/;\s*$/, "");
  if (single.length === 0 || single.includes(";")) {
    return { class: "destructive", parseOk: false, blocked: true };
  }
  if (/^(select|with)\b/i.test(single) && !matches(MODIFY_KEYWORDS, single)) {
    // A locking read (FOR SHARE / FOR KEY SHARE fail to parse and land here) takes
    // row locks, so it carries write intent even though it changes no data.
    if (matches(LOCKING_READ, single)) {
      return { class: "write", parseOk: false, blocked: false };
    }
    return { class: "read", parseOk: false, blocked: false };
  }
  // Strictest class but approvable: blocking every statement the parser cannot read made
  // DROP DATABASE unapprovable in the very mode built to gate it. The `;` check above
  // already blocked genuinely multi-statement input.
  return { class: "destructive", parseOk: false, blocked: false };
}
