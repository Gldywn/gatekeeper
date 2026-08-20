import type { AccessMode } from "@gatekeeper/shared";
import { parser } from "./sql-parser";

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

// Read-only top-level statements. EXPLAIN is here, but the node walk still escalates
// EXPLAIN ANALYZE of a modifying statement, which does execute.
const READ_STATEMENTS = new Set(["select", "show", "desc", "describe", "explain"]);
const WRITE_STATEMENTS = new Set(["insert", "update"]);

// Node types that mean modification wherever they appear (a CTE, a subquery, an
// EXPLAIN); anything not listed and not a read stays destructive (fail safe).
const MODIFY_NODE: Record<string, RiskClass> = {
  insert: "write",
  update: "write",
  // SELECT ... INTO parses as a select carrying an `into` node; it creates a table
  // (Postgres) or writes/exfiltrates a file (MySQL OUTFILE/DUMPFILE), never a read.
  into: "destructive",
  delete: "destructive",
  drop: "destructive",
  truncate: "destructive",
  alter: "destructive",
  create: "destructive",
  rename: "destructive",
  replace: "destructive",
  merge: "destructive",
  grant: "destructive",
  revoke: "destructive",
  call: "destructive",
  use: "destructive",
  set: "destructive",
  lock: "destructive",
  unlock: "destructive",
};

const LOCKING_READ =
  /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b|\block\s+in\s+share\s+mode\b/i;
const MODIFY_KEYWORDS =
  /\b(insert|update|delete|drop|truncate|alter|create|replace|merge|grant|revoke|call|vacuum|pragma|attach|copy|into|lock)\b/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function walkTypes(node: unknown, visit: (type: string) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkTypes(child, visit);
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  if (typeof node.type === "string") {
    visit(node.type.toLowerCase());
  }
  for (const key of Object.keys(node)) {
    walkTypes(node[key], visit);
  }
}

// Known limitation: a read-classified SELECT can still have side effects through
// volatile or exec functions (nextval, dblink_exec); a static parse cannot see those.
function topClass(top: string): RiskClass {
  if (READ_STATEMENTS.has(top)) {
    return "read";
  }
  if (WRITE_STATEMENTS.has(top)) {
    return "write";
  }
  return "destructive"; // delete/drop/truncate/… and anything unrecognized fail safe
}

// node-sql-parser cannot parse EXPLAIN in any dialect (it throws), so peel a leading
// EXPLAIN off and classify the statement it wraps. Returns null when there is none.
function stripExplain(sql: string): { inner: string; analyze: boolean } | null {
  const lead = /^\s*explain\b/i.exec(sql);
  if (!lead) {
    return null;
  }
  let rest = sql.slice(lead[0].length);
  // Postgres accepts ANALYSE as well as ANALYZE; miss it and an EXPLAIN that actually
  // runs a DELETE would read as a harmless plan. Match both, always fail toward "runs".
  const paren = /^\s*\(([^)]*)\)/.exec(rest);
  if (paren) {
    return { inner: rest.slice(paren[0].length).trim(), analyze: /\banaly[sz]e\b/i.test(paren[1]) };
  }
  let analyze = false;
  const opt = /^\s*(analy[sz]e|verbose)\b/i;
  let m = opt.exec(rest);
  while (m) {
    if (/analy[sz]e/i.test(m[1])) {
      analyze = true;
    }
    rest = rest.slice(m[0].length);
    m = opt.exec(rest);
  }
  return { inner: rest.trim(), analyze };
}

// The plugin is the only component that runs SQL, so the risk gate lives here: a
// dialect-aware parse, escalated on any embedded modify node; unparseable is blocked.
export function classifyQuery(sql: string, dialect = "postgresql"): RiskVerdict {
  const explain = stripExplain(sql);
  if (explain && explain.inner.length > 0) {
    // Nested EXPLAIN is invalid in every supported dialect; fail it closed rather than let
    // the plain-EXPLAIN downgrade below turn an inner EXPLAIN ANALYZE <modify> into a read.
    if (stripExplain(explain.inner)) {
      return { class: "destructive", parseOk: false, blocked: true };
    }
    const inner = classifyQuery(explain.inner, dialect);
    // EXPLAIN ANALYZE executes the wrapped statement for real, so it carries that
    // statement's risk; a plain EXPLAIN only plans it, which is read-only.
    if (explain.analyze) {
      return inner;
    }
    return {
      class: inner.blocked ? inner.class : "read",
      parseOk: inner.parseOk,
      blocked: inner.blocked,
    };
  }
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: dialect });
  } catch {
    return fallback(sql);
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return { class: "destructive", parseOk: true, blocked: true };
  }
  const top = String((statements[0] as Record<string, unknown>).type ?? "").toLowerCase();
  let cls = topClass(top);
  walkTypes(ast, (type) => {
    const nc = MODIFY_NODE[type];
    if (nc && rank(nc) > rank(cls)) {
      cls = nc;
    }
  });
  if (cls === "read" && LOCKING_READ.test(sql)) {
    cls = "write";
  }
  // MySQL executable comments (/*! ... */) run their body on MySQL/MariaDB, but the parser
  // may drop them; never let a modify keyword hidden inside one ride under a read verdict.
  if (rank(cls) < rank("destructive") && executableCommentModifies(sql)) {
    cls = "destructive";
  }
  return { class: cls, parseOk: true, blocked: false };
}

// True when the SQL carries a MySQL executable comment whose body (kept, unlike ordinary
// comments) contains a data-modifying keyword.
function executableCommentModifies(sql: string): boolean {
  if (!/\/\*!/.test(sql)) {
    return false;
  }
  const bare = sql.replace(/\/\*(?!!)[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  return MODIFY_KEYWORDS.test(bare);
}

// Parser gaps fall back to text: reject empty/multi, a leading SELECT/WITH with no
// modifying keyword reads, everything else is destructive (fail safe).
function fallback(sql: string): RiskVerdict {
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
