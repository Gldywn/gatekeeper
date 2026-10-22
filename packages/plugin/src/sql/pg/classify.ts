import { type RiskClass, type RiskVerdict, rank } from "../risk";
import { readPg } from "./parse";

type Node = Record<string, unknown>;

// Top-level statements that only read or only write rows; any other statement is destructive.
const READ = new Set(["SelectStmt", "VariableShowStmt"]);
const WRITE = new Set(["InsertStmt", "UpdateStmt"]);
// Nodes that modify wherever they sit: a data-modifying CTE, a row lock, SELECT ... INTO.
const MODIFY: Record<string, RiskClass> = {
  InsertStmt: "write",
  UpdateStmt: "write",
  lockingClause: "write",
  DeleteStmt: "destructive",
  MergeStmt: "destructive",
  intoClause: "destructive",
};

export function classifyPg(sql: string): RiskVerdict | null {
  const text = readPg(sql);
  // Never the text fallback: its comment stripping can hide the second statement the server
  // would see, as in SELECT 'a\' /*'; DELETE FROM t; -- */.
  if (text === "ambiguous") return { class: "destructive", parseOk: false, blocked: true };
  if (!text) return null;
  const stmts = text.tree.stmts ?? [];
  if (stmts.length !== 1) return { class: "destructive", parseOk: true, blocked: true };
  return {
    class: statementClass(stmts[0].stmt as Node | undefined),
    parseOk: true,
    blocked: false,
  };
}

// Known limitation: a read can still have side effects through volatile or exec functions
// (nextval, dblink_exec); a parse cannot see those.
function statementClass(stmt: Node | undefined): RiskClass {
  const [kind, body] = Object.entries(stmt ?? {})[0] ?? [];
  if (kind === "ExplainStmt") return explainClass(body as Node);
  let cls: RiskClass = READ.has(kind) ? "read" : WRITE.has(kind) ? "write" : "destructive";
  escalate(body, (found) => {
    if (rank(found) > rank(cls)) cls = found;
  });
  return cls;
}

// EXPLAIN ANALYZE runs the statement it wraps, a plain EXPLAIN only plans it. An ANALYZE option
// counts unless its value is explicitly false, so contradictory options still count as running.
function explainClass(explain: Node): RiskClass {
  const runs = ((explain.options as Node[] | undefined) ?? []).some((option) => {
    const def = option.DefElem as Node | undefined;
    return def?.defname === "analyze" && !explicitlyFalse(def.arg as Node | undefined);
  });
  return runs ? statementClass(explain.query as Node | undefined) : "read";
}

function explicitlyFalse(arg: Node | undefined): boolean {
  if (!arg) return false;
  const text = (arg.String as Node | undefined)?.sval;
  if (typeof text === "string") return ["false", "off"].includes(text.toLowerCase());
  // A zero Integer arrives without its ival: protobuf drops default values.
  const integer = arg.Integer as Node | undefined;
  return integer !== undefined && (integer.ival ?? 0) === 0;
}

function escalate(node: unknown, found: (cls: RiskClass) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) escalate(child, found);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    const cls = MODIFY[key];
    if (cls && value != null && !(Array.isArray(value) && !value.length)) found(cls);
    escalate(value, found);
  }
}
