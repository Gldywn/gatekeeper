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

export const LOCKING_READ =
  /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b|\block\s+in\s+share\s+mode\b/i;
export const MODIFY_KEYWORDS =
  /\b(insert|update|delete|drop|truncate|alter|create|replace|merge|grant|revoke|call|vacuum|pragma|attach|copy|into|lock)\b/i;

// Statements no engine can read fall back to text: reject empty/multi, a leading SELECT/WITH
// with no modifying keyword reads, everything else is destructive (fail safe).
export function fallback(sql: string): RiskVerdict {
  const stripped = sql
    // Keep MySQL executable comments (/*! ... */): their body runs, so stripping it would
    // let a hidden write pass as a read; MODIFY_KEYWORDS then catches it below.
    .replace(/\/\*(?!!)[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  const single = stripped.replace(/;\s*$/, "");
  if (single.length === 0 || single.includes(";")) {
    return { class: "destructive", parseOk: false, blocked: true };
  }
  if (/^(select|with)\b/i.test(single) && !MODIFY_KEYWORDS.test(single)) {
    // A locking read (FOR SHARE / FOR KEY SHARE fail to parse and land here) takes
    // row locks, so it carries write intent even though it changes no data.
    if (LOCKING_READ.test(single)) {
      return { class: "write", parseOk: false, blocked: false };
    }
    return { class: "read", parseOk: false, blocked: false };
  }
  // Strictest class but approvable: blocking every statement the parser cannot read made
  // DROP DATABASE unapprovable in the very mode built to gate it. The `;` check above
  // already blocked genuinely multi-statement input.
  return { class: "destructive", parseOk: false, blocked: false };
}
