import type { AccessMode } from "@gatekeeper/shared";

// The server's advisory risk class is the shared access mode.
export type RiskClass = AccessMode;

export interface RiskAssessment {
  class: RiskClass;
  // false only when the statement is empty or multi-statement: those are never
  // enqueued. A write/destructive is ok:true and forwarded; the human gate decides.
  ok: boolean;
  reason?: string;
}

// A leading keyword that begins a read; a modifying sub-statement (a CTE or subquery)
// still escalates the class below.
const READ_LEAD = new Set([
  "select",
  "with",
  "show",
  "desc",
  "describe",
  "explain",
  "table",
  "values",
]);
const WRITE_LEAD = new Set(["insert", "update", "upsert"]);

// Statement-initiating modify keywords, matched as multi-token phrases so common
// function/clause names (REPLACE(), UPDATE ... SET, USE INDEX) never trip them.
const EMBED_WRITE = /\b(insert\s+into|update\s+\w)/i;
const EMBED_DESTRUCTIVE =
  /\b(delete\s+from|drop\s+\w|truncate\s+|alter\s+\w|grant\s+|revoke\s+|merge\s+into)/i;
// A select carrying INTO creates a table or writes a file; over-classify it on the
// advisory stamp (a string-literal "into" is harmless here, the plugin is precise).
const EMBED_INTO = /\binto\b/i;

// Same leading-comment rule as the plugin's text check (packages/plugin/src/sql/classify.ts):
// only the comments every engine closes at the same place.
const LEADING_COMMENTS =
  /^(?:\s+|--(?=[ \t\r\n]|$)[^\r\n]*(?:\r?\n|$)|\/\*(?!M?!)(?:(?!\/\*)[\s\S])*?\*\/)*/;

// Same two views as the plugin's matches(): as written, or with ordinary comments and
// executable markers blanked (DELETE/**/FROM), an open comment ending at the end of the text.
function matches(re: RegExp, sql: string): boolean {
  const blanked = sql
    .replace(/\/\*(?!M?!)[\s\S]*?(?:\*\/|$)/g, " ")
    .replace(/--[^\r\n]*|\/\*M?!\d*|\*\//g, " ");
  return re.test(sql) || re.test(blanked);
}

// Advisory, regex-only risk classifier mirroring the plugin's classes. The plugin
// (with a real parser) stays authoritative; this only stamps the audit and blocks the
// two cases no mode may approve: empty and multi-statement.
export function classifyRisk(sql: string): RiskAssessment {
  // Strings are not delimited here, so nothing past the leading comments is removed: a
  // '--' or '/*' inside a string would otherwise hide a second statement.
  const single = sql
    .slice(LEADING_COMMENTS.exec(sql)?.[0].length ?? 0)
    .trim()
    .replace(/;\s*$/, "");
  if (single.length === 0) {
    return { class: "destructive", ok: false, reason: "Empty statement" };
  }
  if (single.includes(";")) {
    return { class: "destructive", ok: false, reason: "Only a single statement is allowed" };
  }
  return { class: riskClass(single), ok: true };
}

function riskClass(single: string): RiskClass {
  const lead = (single.match(/^[a-z]+/i)?.[0] ?? "").toLowerCase();
  if (WRITE_LEAD.has(lead)) {
    return matches(EMBED_DESTRUCTIVE, single) ? "destructive" : "write";
  }
  if (READ_LEAD.has(lead)) {
    if (matches(EMBED_DESTRUCTIVE, single) || matches(EMBED_INTO, single)) {
      return "destructive";
    }
    if (matches(EMBED_WRITE, single)) {
      return "write";
    }
    return "read";
  }
  // delete/drop/truncate/alter/create/... and anything unrecognised fail safe.
  return "destructive";
}
