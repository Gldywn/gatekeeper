import { parser } from "./sql-parser";

export type RiskClass = "read" | "write" | "destructive";

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

// The plugin is the only component that runs SQL, so the risk gate lives here: a
// dialect-aware parse, escalated on any embedded modify node; unparseable is blocked.
export function classifyQuery(sql: string, dialect = "postgresql"): RiskVerdict {
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
  return { class: cls, parseOk: true, blocked: false };
}

// Parser gaps fall back to text: reject empty/multi, a leading SELECT/WITH with no
// modifying keyword reads, everything else is destructive (fail safe).
function fallback(sql: string): RiskVerdict {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
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
  return { class: "destructive", parseOk: false, blocked: true };
}
