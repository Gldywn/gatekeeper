import { type RiskClass, type RiskVerdict, rank } from "../risk";
import { parser } from "./parser";

// Read-only top-level statements. EXPLAIN is here, but the node walk still escalates
// EXPLAIN of a modifying statement, which may execute it.
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

// Every node's type, plus whether any of them carries a row lock (FOR UPDATE, LOCK IN SHARE
// MODE), which node-sql-parser keeps as a select's locking_read.
function walk(node: unknown, visit: (type: string, locks: boolean) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  visit(typeof node.type === "string" ? node.type.toLowerCase() : "", node.locking_read != null);
  for (const key of Object.keys(node)) {
    walk(node[key], visit);
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

// A grammar-aware parse, escalated on any embedded modify node or row lock; null when the
// parser cannot read the statement, so the shared gate falls back to the strict text check.
export function classifyNsp(sql: string, grammar: string): RiskVerdict | null {
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: grammar });
  } catch {
    return null;
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return { class: "destructive", parseOk: true, blocked: true };
  }
  const top = String((statements[0] as Record<string, unknown>).type ?? "").toLowerCase();
  let cls = topClass(top);
  walk(ast, (type, locks) => {
    const nc = MODIFY_NODE[type] ?? (locks ? "write" : undefined);
    if (nc && rank(nc) > rank(cls)) {
      cls = nc;
    }
  });
  return { class: cls, parseOk: true, blocked: false };
}
