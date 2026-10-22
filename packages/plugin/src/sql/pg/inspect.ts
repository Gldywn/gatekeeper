import type { ScanToken } from "libpg-query";
import {
  classifyColumn,
  dedupeRefs,
  formatRef,
  JSON_FUNCTION,
  JSON_OPERATORS,
  jsonKeyNames,
  type ParsedQuery,
  type Receipt,
  sensitiveShape,
  type TableOps,
  type TableRef,
  unique,
} from "../schema";
import { type PgText, readPg, writtenString } from "./parse";

type Node = Record<string, unknown>;
interface RangeVar extends Node {
  relname: string;
  schemaname?: string;
  location?: number;
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Every object of the tree with the key it hangs under: libpg_query wraps a node in its type
// name ({ RangeVar: {...} }) except where the field's type is fixed (InsertStmt.relation).
function walk(node: unknown, visit: (value: Node, key: string) => void, key = ""): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, key);
    return;
  }
  if (!isNode(node)) return;
  visit(node, key);
  for (const [k, v] of Object.entries(node)) walk(v, visit, k);
}

function text(sql: string): PgText | null {
  const read = readPg(sql);
  return read === "ambiguous" ? null : read;
}

function stmtsOf(read: PgText): Node[] {
  return (read.tree.stmts ?? []).map((s) => (s.stmt ?? {}) as Node);
}

function strings(list: unknown): string[] {
  return Array.isArray(list)
    ? list.flatMap((item) => {
        const sval = isNode(item) && isNode(item.String) ? item.String.sval : undefined;
        return typeof sval === "string" ? [sval] : [];
      })
    : [];
}

function ref(rv: RangeVar): TableRef {
  return { schema: rv.schemaname ?? null, name: rv.relname };
}

function byLocation(a: RangeVar, b: RangeVar): number {
  return (a.location ?? 0) - (b.location ?? 0);
}

// A CTE is named like a table but is not one: an unqualified reference to a CTE visible where it
// sits reads no relation, while the same name outside that WITH is a real table.
function cteReferences(read: PgText): Set<Node> {
  const refs = new Set<Node>();
  const visit = (node: unknown, ctes: ReadonlySet<string>): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, ctes);
      return;
    }
    if (!isNode(node)) return;
    const defined = isNode(node.withClause) ? node.withClause.ctes : null;
    const scope = Array.isArray(defined)
      ? new Set([
          ...ctes,
          ...defined.flatMap((c) => {
            const name = isNode(c) && isNode(c.CommonTableExpr) ? c.CommonTableExpr.ctename : null;
            return typeof name === "string" ? [name] : [];
          }),
        ])
      : ctes;
    const rv = node.RangeVar;
    if (isNode(rv) && !rv.schemaname && typeof rv.relname === "string" && scope.has(rv.relname))
      refs.add(rv);
    for (const value of Object.values(node)) visit(value, scope);
  };
  visit(read.tree, new Set());
  return refs;
}

interface Relations {
  reads: RangeVar[];
  writes: { rv: RangeVar; op: string }[];
  created: Set<RangeVar>;
}

const DML: Record<string, string> = {
  InsertStmt: "insert",
  UpdateStmt: "update",
  DeleteStmt: "delete",
  MergeStmt: "merge",
};
const DROPPED = new Set(["OBJECT_TABLE", "OBJECT_VIEW", "OBJECT_MATVIEW", "OBJECT_FOREIGN_TABLE"]);

// The relations a statement writes (with the operation) and reads, in source order. Created
// relations do not exist yet, so they are writes and never tables to look columns up in.
function relations(read: PgText): Relations {
  const ctes = cteReferences(read);
  const writes: Relations["writes"] = [];
  const created = new Set<RangeVar>();
  const targets = new Set<Node>();
  const write = (rv: unknown, op: string, creates = false) => {
    if (!isNode(rv) || typeof rv.relname !== "string") return;
    writes.push({ rv: rv as RangeVar, op });
    targets.add(rv);
    if (creates) created.add(rv as RangeVar);
  };
  const all: RangeVar[] = [];
  walk(read.tree, (n, key) => {
    if (key in DML) write(n.relation, DML[key]);
    else if (key === "intoClause" || key === "into") write(n.rel, "create", true);
    else if (key === "ViewStmt") write(n.view, "create", true);
    else if (key === "CreateStmt") write(n.relation, "create", true);
    else if (key === "AlterTableStmt") write(n.relation, "alter");
    else if (key === "TruncateStmt" && Array.isArray(n.relations))
      for (const item of n.relations) write(isNode(item) ? item.RangeVar : null, "truncate");
    else if (key === "DropStmt" && DROPPED.has(String(n.removeType)) && Array.isArray(n.objects))
      for (const object of n.objects) {
        const names = strings(isNode(object) && isNode(object.List) ? object.List.items : null);
        const relname = names.at(-1);
        if (relname) write({ relname, schemaname: names.at(-2) }, "drop");
      }
    if (key === "RangeVar" && typeof n.relname === "string") all.push(n as RangeVar);
  });
  const reads = all.filter((rv) => !targets.has(rv) && !ctes.has(rv));
  writes.sort((a, b) => byLocation(a.rv, b.rv));
  return { reads: reads.sort(byLocation), writes, created };
}

// The operands a node reads JSON keys from: an accessor's right side (a path, or an array of
// keys), a subscript, a JSON function's arguments after the document, a SQL/JSON path.
function keyOperands(node: Node): unknown[] {
  const expr = node.A_Expr;
  if (isNode(expr) && JSON_OPERATORS.has(strings(expr.name).join(""))) {
    const right = expr.rexpr;
    return isNode(right) && isNode(right.A_ArrayExpr) && Array.isArray(right.A_ArrayExpr.elements)
      ? right.A_ArrayExpr.elements
      : [right];
  }
  const indirection = node.A_Indirection;
  if (isNode(indirection) && Array.isArray(indirection.indirection))
    return indirection.indirection.map((i) =>
      isNode(i) && isNode(i.A_Indices) ? i.A_Indices.uidx : null,
    );
  const json = node.JsonFuncExpr;
  if (isNode(json)) return [json.pathspec];
  const call = node.FuncCall;
  if (!isNode(call) || !isJsonFunction(call) || !Array.isArray(call.args)) return [];
  // The document comes first and the keys after it; a call starting on a string builds one.
  return call.args.length < 2 || stringValue(call.args[0]) !== null ? [] : call.args.slice(1);
}

function isJsonFunction(call: Node): boolean {
  return strings(call.funcname).some((part) => JSON_FUNCTION.test(part));
}

function stringValue(node: unknown): string | null {
  if (isNode(node) && isNode(node.TypeCast)) return stringValue(node.TypeCast.arg);
  const constant = isNode(node) ? node.A_Const : null;
  if (!isNode(constant) || !isNode(constant.sval)) return null;
  return typeof constant.sval.sval === "string" ? constant.sval.sval : "";
}

function accessorKeys(node: Node): string[] {
  return keyOperands(node).flatMap((operand) => {
    const path = stringValue(operand);
    return path === null ? [] : jsonKeyNames(path);
  });
}

// The name an operand compares: a column, or the field a composite selection reaches,
// as in (t.profile).company_name.
function columnName(node: Node): string | null {
  const column = node.ColumnRef;
  if (isNode(column)) return strings(column.fields).at(-1) ?? null;
  const indirection = node.A_Indirection;
  if (!isNode(indirection)) return null;
  const field = strings(indirection.indirection).at(-1);
  return field ?? (isNode(indirection.arg) ? columnName(indirection.arg) : null);
}

const SELECTS = new Set(["SelectStmt", "larg", "rarg"]);
// FROM items whose alias can rename their columns: t(a, b), (SELECT ...) s(a), (x JOIN y) j(a).
const RENAMING = new Set(["RangeVar", "RangeSubselect", "RangeFunction", "JoinExpr"]);

export function analyzePg(sql: string): ParsedQuery | null {
  const read = text(sql);
  if (!read) return null;
  const { reads, writes, created } = relations(read);
  const tables = [...reads, ...writes.map((w) => w.rv).filter((rv) => !created.has(rv))]
    .sort(byLocation)
    .map(ref);
  const columns: string[] = [];
  const aliases: string[] = [];
  const jsonKeys: string[] = [];
  let star = false;
  walk(read.tree, (n, key) => {
    if (key === "ColumnRef" && Array.isArray(n.fields)) {
      const last = n.fields.at(-1);
      if (isNode(last) && "A_Star" in last) star = true;
      else columns.push(...strings([last]));
    }
    if (key === "A_Indirection") columns.push(...strings(n.indirection));
    jsonKeys.push(...accessorKeys(n));
    // Output names come from a SELECT list (set-operation branches arrive unwrapped as larg and
    // rarg) or a RETURNING list, never from an UPDATE's SET.
    const outputs = SELECTS.has(key) ? n.targetList : key === "returningClause" ? n.exprs : null;
    for (const item of Array.isArray(outputs) ? outputs : []) {
      const name = isNode(item) && isNode(item.ResTarget) ? item.ResTarget.name : undefined;
      if (typeof name === "string") aliases.push(name);
    }
    if (key === "CommonTableExpr") aliases.push(...strings(n.aliascolnames));
    if (RENAMING.has(key)) {
      const alias = isNode(n.alias) ? n.alias : null;
      const renamed = strings(alias?.colnames);
      aliases.push(...renamed);
      if (key !== "RangeFunction") return;
      // A typed table function declares its columns; a bare alias names its single column.
      const declared: string[] = [];
      walk(n, (m, k) => {
        if (k === "ColumnDef" && typeof m.colname === "string") declared.push(m.colname);
      });
      aliases.push(...declared);
      if (!renamed.length && !declared.length && typeof alias?.aliasname === "string")
        aliases.push(alias.aliasname);
    }
  });
  for (const w of writes)
    if (["insert", "update", "merge"].includes(w.op)) columns.push(...assignedColumns(read, w.rv));
  return {
    tables: dedupeRefs(tables),
    columns: unique(columns),
    aliases: unique(aliases),
    jsonKeys: unique(jsonKeys),
    star,
  };
}

// The columns an INSERT or UPDATE writes, which name no ColumnRef.
function assignedColumns(read: PgText, target: RangeVar): string[] {
  const names: string[] = [];
  walk(read.tree, (n, key) => {
    if (!(key in WRITTEN) || n.relation !== target) return;
    const clauses = Array.isArray(n.mergeWhenClauses)
      ? n.mergeWhenClauses.map((c) => (isNode(c) ? c.MergeWhenClause : null))
      : [];
    for (const list of [
      n.cols,
      n.targetList,
      ...clauses.map((c) => (isNode(c) ? c.targetList : null)),
    ])
      names.push(...targetNames(list).filter((name): name is string => name !== undefined));
  });
  return names;
}

// The statements that name the columns they write, which appear in no ColumnRef.
const WRITTEN: Record<string, true> = { InsertStmt: true, UpdateStmt: true, MergeStmt: true };

function targetNames(list: unknown): (string | undefined)[] {
  return (Array.isArray(list) ? list : []).map((item) => {
    const name = isNode(item) && isNode(item.ResTarget) ? item.ResTarget.name : undefined;
    return typeof name === "string" ? name : undefined;
  });
}

export function tableOpsPg(sql: string): TableOps | null {
  const read = text(sql);
  if (!read || !stmtsOf(read).every(modelled)) return null;
  const { reads, writes } = relations(read);
  return {
    writes: dedupeRefs(writes.map((w) => ref(w.rv))).map(formatRef),
    reads: dedupeRefs(reads.map(ref)).map(formatRef),
    writeOp: writes[0]?.op ?? null,
  };
}

const MODELLED = new Set([
  "SelectStmt",
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "CreateTableAsStmt",
  "ViewStmt",
  "CreateStmt",
  "AlterTableStmt",
  "TruncateStmt",
  "DropStmt",
]);

function modelled(stmt: Node): boolean {
  return Object.keys(stmt).every((kind) => MODELLED.has(kind));
}

const RECEIPT: Record<string, string> = {
  SelectStmt: "SELECT",
  InsertStmt: "INSERT",
  UpdateStmt: "UPDATE",
  DeleteStmt: "DELETE",
  DropStmt: "DROP",
  TruncateStmt: "TRUNCATE",
};

// The one operation a simple statement performs and the tables it names. Anything the parse
// cannot vouch for (several statements, a CTE, SELECT ... INTO, MERGE, a call, several
// targets) gets null, and the receipt stays generic.
export function receiptPg(sql: string): Receipt | null {
  const read = text(sql);
  const stmts = read ? stmtsOf(read) : [];
  if (stmts.length !== 1) return null;
  const [kind, body] = Object.entries(stmts[0])[0] ?? [];
  const op = RECEIPT[kind];
  if (!op || !isNode(body) || body.withClause) return null;
  const ops = tableOpsPg(sql);
  if (!ops) return null;
  if (op === "SELECT")
    return ops.writes.length || !ops.reads.length ? null : { op, tables: ops.reads };
  return ops.writes.length === 1 && ops.writeOp === op.toLowerCase()
    ? { op, tables: ops.writes }
    : null;
}

export function countsRowsPg(sql: string): boolean | null {
  const read = text(sql);
  if (!read) return null;
  const stmts = stmtsOf(read);
  return stmts.length === 1 && Object.keys(stmts[0]).some((kind) => kind in DML);
}

// The comparisons whose operands can bind a value to a column: operators, IN, ranges, patterns.
const COMPARISON_KINDS = new Set([
  "AEXPR_OP_ANY",
  "AEXPR_OP_ALL",
  "AEXPR_DISTINCT",
  "AEXPR_NOT_DISTINCT",
  "AEXPR_IN",
  "AEXPR_LIKE",
  "AEXPR_ILIKE",
  "AEXPR_SIMILAR",
  "AEXPR_BETWEEN",
  "AEXPR_NOT_BETWEEN",
  "AEXPR_BETWEEN_SYM",
  "AEXPR_NOT_BETWEEN_SYM",
]);
const COMPARISON_OPS = new Set(["=", "<>", "<", ">", "<=", ">=", "~", "~*", "!~", "!~*"]);

function isComparison(expr: Node): boolean {
  return (
    COMPARISON_KINDS.has(String(expr.kind)) ||
    (expr.kind === "AEXPR_OP" && COMPARISON_OPS.has(strings(expr.name).join("")))
  );
}

// Either side of a comparison can wrap what it compares: lower(col), col::text, COALESCE(col, ''),
// max(col), an IN list, ARRAY[...]. Descending those wrappers yields the operands that carry the
// signal, and stopping at every other node keeps a subquery's own literals out.
function operands(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(operands);
  if (!isNode(node)) return [];
  const call = node.FuncCall;
  if (isNode(call) && !isJsonFunction(call)) return operands(call.args);
  for (const [kind, field] of [
    ["TypeCast", "arg"],
    ["CoalesceExpr", "args"],
    ["MinMaxExpr", "args"],
    ["A_ArrayExpr", "elements"],
    ["List", "items"],
    ["RowExpr", "args"],
  ] as const) {
    const inner = node[kind];
    if (isNode(inner)) return operands(inner[field]);
  }
  return [node];
}

// An operand names what it compares through its column or, for a JSON accessor, through its key.
function hasSensitiveColumn(node: unknown): boolean {
  return operands(node).some((operand) => {
    const column = columnName(operand);
    if (column !== null && classifyColumn(column) !== null) return true;
    return accessorKeys(operand).some((key) => classifyColumn(key) !== null);
  });
}

// String literals that expose a sensitive value in the query text itself: one bound to a PII or
// client column (compared, assigned, inserted), or one whose shape is itself sensitive. Each is
// returned as written, escapes included, so the highlight still finds it in the query.
export function sensitiveLiteralsPg(sql: string): string[] {
  const read = text(sql);
  if (!read) return [];
  const found = new Set<string>();
  const add = (node: unknown) => {
    for (const operand of operands(node)) {
      const value = written(read.tokens, operand);
      if (value) found.add(value);
    }
  };
  // An inserted row lines up positionally with its column list.
  const inserted = (columns: (string | undefined)[], values: unknown) => {
    if (!Array.isArray(values)) return;
    values.forEach((value, i) => {
      const column = columns[i];
      if (column !== undefined && classifyColumn(column)) add(value);
    });
  };
  const assigned = (targets: unknown) => {
    for (const item of Array.isArray(targets) ? targets : []) {
      const target = isNode(item) ? item.ResTarget : null;
      if (!isNode(target) || typeof target.name !== "string" || !classifyColumn(target.name))
        continue;
      // SET (a, b) = ('x', 1) gives each target the whole row and its own position in it.
      const multi = isNode(target.val) ? target.val.MultiAssignRef : null;
      if (!isNode(multi)) {
        add(target.val);
        continue;
      }
      const row = isNode(multi.source) ? multi.source.RowExpr : null;
      if (isNode(row) && Array.isArray(row.args)) add(row.args[Number(multi.colno) - 1]);
    }
  };
  walk(read.tree, (n, key) => {
    const value = stringValue(n);
    if (value && sensitiveShape(value)) add(n);
    if (key === "UpdateStmt" || key === "onConflictClause") assigned(n.targetList);
    if (key === "MergeWhenClause" && n.commandType === "CMD_UPDATE") assigned(n.targetList);
    if (key === "MergeWhenClause" && n.commandType === "CMD_INSERT")
      inserted(targetNames(n.targetList), n.values);
    if (key === "InsertStmt") {
      const select = isNode(n.selectStmt) ? n.selectStmt.SelectStmt : null;
      const rows = isNode(select) && Array.isArray(select.valuesLists) ? select.valuesLists : [];
      for (const row of rows)
        inserted(targetNames(n.cols), isNode(row) && isNode(row.List) ? row.List.items : null);
    }
    if (key !== "A_Expr" || !isComparison(n)) return;
    for (const [side, other] of [
      [n.lexpr, n.rexpr],
      [n.rexpr, n.lexpr],
    ] as const)
      if (hasSensitiveColumn(side)) add(other);
  });
  return [...found];
}

// A non-empty string constant as written in the query, or its decoded value when no string token
// starts where the constant does (a Unicode-escaped U&'' form).
function written(tokens: ScanToken[], node: Node): string | null {
  const value = stringValue(node);
  if (!value) return null;
  const location = isNode(node.A_Const) ? node.A_Const.location : undefined;
  return (typeof location === "number" ? writtenString(tokens, location) : null) || value;
}
