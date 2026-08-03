export type RiskClass = "read" | "write" | "destructive";

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

// Advisory, regex-only risk classifier mirroring the plugin's classes. The plugin
// (with a real parser) stays authoritative; this only stamps the audit and blocks the
// two cases no mode may approve: empty and multi-statement.
export function classifyRisk(sql: string): RiskAssessment {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  if (stripped.length === 0) {
    return { class: "destructive", ok: false, reason: "Empty statement" };
  }
  const single = stripped.replace(/;\s*$/, "");
  if (single.includes(";")) {
    return { class: "destructive", ok: false, reason: "Only a single statement is allowed" };
  }
  return { class: riskClass(single), ok: true };
}

function riskClass(single: string): RiskClass {
  const lead = (single.match(/^[a-z]+/i)?.[0] ?? "").toLowerCase();
  if (WRITE_LEAD.has(lead)) {
    return EMBED_DESTRUCTIVE.test(single) ? "destructive" : "write";
  }
  if (READ_LEAD.has(lead)) {
    if (EMBED_DESTRUCTIVE.test(single)) {
      return "destructive";
    }
    if (EMBED_WRITE.test(single)) {
      return "write";
    }
    return "read";
  }
  // delete/drop/truncate/alter/create/... and anything unrecognised fail safe.
  return "destructive";
}
