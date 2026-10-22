import { prepareSql } from "../identifiers";
import {
  fallback,
  LOCKING_READ,
  MODIFY_KEYWORDS,
  type RiskClass,
  type RiskVerdict,
  rank,
} from "../risk";
import { parser } from "./parser";

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
export function stripExplain(sql: string): { inner: string; analyze: boolean } | null {
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

// A grammar-aware parse, escalated on any embedded modify node; null when the parser cannot
// read the statement, so the shared gate falls back to the strict text check.
export function classifyNsp(sql: string, grammar: string): RiskVerdict | null {
  const explain = stripExplain(sql);
  if (explain && explain.inner.length > 0) {
    // Nested EXPLAIN is invalid in every supported dialect; fail it closed rather than let
    // the plain-EXPLAIN downgrade below turn an inner EXPLAIN ANALYZE <modify> into a read.
    if (stripExplain(explain.inner)) {
      return { class: "destructive", parseOk: false, blocked: true };
    }
    const inner = classifyNsp(explain.inner, grammar) ?? fallback(explain.inner);
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
    ast = parser.astify(prepareSql(sql, grammar).sql, { database: grammar });
  } catch {
    return null;
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
