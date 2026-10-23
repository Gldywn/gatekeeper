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
import { parser } from "./parser";

// The parser encodes each entry as "{type}::{qualifier}::{name}"; the name we
// want is always the last segment.
function lastSegment(entry: string): string {
  const parts = entry.split("::");
  return parts[parts.length - 1] ?? "";
}

// A table entry is "{type}::{schema}::{name}"; the schema is "null" when the SQL
// left the table unqualified.
function parseTableRef(entry: string): TableRef | null {
  const parts = entry.split("::");
  const name = parts[parts.length - 1] ?? "";
  if (!name) {
    return null;
  }
  const qualifier = parts.length >= 3 ? (parts[parts.length - 2] ?? "") : "";
  return { schema: qualifier && qualifier !== "null" ? qualifier : null, name };
}

function isNode(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const key of Object.keys(node)) walk(node[key], visit);
}

// The parser's typings allow a value node as alias besides the usual plain string.
function aliasName(as: unknown): string | null {
  if (typeof as === "string") return as;
  if (isNode(as) && typeof as.value === "string") return as.value;
  return null;
}

// A table function has no relation to rename, so its alias names the single output column
// it returns ("FROM unnest(tags) AS contact_email") instead of standing for a table.
function isFunctionRelation(item: Record<string, unknown>): boolean {
  return item.type === "unnest" || (isNode(item.expr) && item.expr.type === "function");
}

// The parser's columnList carries only the source column, so "c.name AS company_name"
// reaches the classifier as a bare "name" unless the alias is collected from the AST.
// RETURNING is a select list under its own node type, hence the second type here.
function outputAliases(ast: unknown): string[] {
  const aliases: string[] = [];
  walk(ast, (n) => {
    if ((n.type === "select" || n.type === "returning") && Array.isArray(n.columns)) {
      for (const item of n.columns) {
        const alias = isNode(item) ? aliasName(item.as) : null;
        if (alias) aliases.push(alias);
      }
    }
    if (Array.isArray(n.from)) {
      for (const item of n.from) {
        if (!isNode(item)) continue;
        const alias = isFunctionRelation(item) ? aliasName(item.as) : null;
        if (alias) aliases.push(alias);
      }
    }
  });
  return unique(aliases);
}

// The parser spreads a function name over name.name[] and name.schema (an unqualified
// bigquery name lands in the latter, a qualifier in the other), so any part counts.
function isJsonFunction(node: Record<string, unknown>): boolean {
  let match = false;
  walk(node.name, (n) => {
    if (typeof n.value === "string" && JSON_FUNCTION.test(n.value)) match = true;
  });
  return match;
}

// The operands one node reads its keys from: what an accessor operator takes on the
// right (a path, or an array of them), the subscripts of a bracketed column, or the
// arguments a JSON function takes after the document itself.
function keyOperands(node: Record<string, unknown>): unknown[] {
  if (node.type === "binary_expr" && JSON_OPERATORS.has(String(node.operator))) {
    const right = node.right;
    const list = isNode(right) && isNode(right.expr_list) ? right.expr_list.value : null;
    return Array.isArray(list) ? list : [right];
  }
  if (node.type === "column_ref" && Array.isArray(node.array_index)) {
    return node.array_index.map((entry) => (isNode(entry) ? entry.index : null));
  }
  if (node.type !== "function" || !isJsonFunction(node)) {
    return [];
  }
  const args = isNode(node.args) && Array.isArray(node.args.value) ? node.args.value : [];
  // The document comes first and the keys after it; a call that already starts on a
  // string builds or parses a document rather than reading one.
  return args.length < 2 || stringLiteral(args[0]) !== null ? [] : args.slice(1);
}

function accessorKeys(node: Record<string, unknown>): string[] {
  return keyOperands(node).flatMap((operand) => {
    const path = stringLiteral(operand);
    return path === null ? [] : jsonKeyNames(path);
  });
}

function jsonKeys(ast: unknown): string[] {
  const keys: string[] = [];
  walk(ast, (n) => {
    keys.push(...accessorKeys(n));
  });
  return unique(keys);
}

// Returns null when the parser cannot handle the statement, so the caller can
// skip annotation rather than show something wrong.
export function analyzeSql(sql: string, grammar: string): ParsedQuery | null {
  try {
    const { tableList, columnList, ast } = parser.parse(sql, { database: grammar });
    const refs = tableList.map(parseTableRef).filter((ref): ref is TableRef => ref !== null);
    let star = false;
    const columns: string[] = [];
    for (const entry of columnList) {
      const name = lastSegment(entry);
      if (name === "(.*)" || name === "*") {
        star = true;
        continue;
      }
      if (name) {
        columns.push(name);
      }
    }
    return {
      tables: dedupeRefs(refs),
      columns: unique(columns),
      aliases: outputAliases(ast),
      jsonKeys: jsonKeys(ast),
      star,
    };
  } catch {
    return null;
  }
}

interface WriteTarget {
  ref: TableRef;
  op: string;
}

// Only the keyword separates a file from a table: a quoted Postgres identifier reaches
// `expr` as a string literal exactly like an OUTFILE path, and MySQL accepts a path in
// double quotes. Anything else is the table "SELECT ... INTO t" creates.
function intoTarget(node: Record<string, unknown>): WriteTarget | null {
  const keyword = typeof node.keyword === "string" ? node.keyword.toUpperCase() : null;
  if (keyword === "OUTFILE" || keyword === "DUMPFILE") {
    const path = stringLiteral(node.expr);
    return path === null ? null : { ref: { schema: null, name: path }, op: "export" };
  }
  // "INTO @var" holds var nodes rather than a name, and binds nothing durable.
  const name = typeof node.expr === "string" ? node.expr : stringLiteral(node.expr);
  return name === null ? null : { ref: { schema: null, name }, op: "create" };
}

// CREATE VIEW keeps its target in the create node ("{db, view}"), never in tableList.
function viewTarget(node: Record<string, unknown>): WriteTarget | null {
  const view = node.view;
  if (!isNode(view) || typeof view.view !== "string") {
    return null;
  }
  return {
    ref: { schema: typeof view.db === "string" ? view.db : null, name: view.view },
    op: "create",
  };
}

// The write destinations tableList does not carry, because the parser keeps them in the
// statement node instead of the table list: a SELECT ... INTO target and a CREATE VIEW.
function astWriteTargets(ast: unknown): WriteTarget[] {
  const targets: WriteTarget[] = [];
  walk(ast, (n) => {
    // A select with no INTO still carries an `into` placeholder, without a type.
    if (n.type === "into") {
      const target = intoTarget(n);
      if (target) targets.push(target);
      return;
    }
    if (n.type === "create" && n.keyword === "view") {
      const target = viewTarget(n);
      if (target) targets.push(target);
    }
  });
  return targets;
}

// The tables a modifying query writes to versus reads from: the table list split on its
// per-entry operation prefix ("{op}::{schema}::{table}"), plus the destinations that live
// in the AST alone. Feeds the card's Writes/Deletes annotation.
export function analyzeTableOps(sql: string, grammar: string): TableOps | null {
  let tableList: string[];
  let ast: unknown;
  try {
    ({ tableList, ast } = parser.parse(sql, { database: grammar }));
  } catch {
    return null;
  }
  const writes: TableRef[] = [];
  const reads: TableRef[] = [];
  let writeOp: string | null = null;
  for (const entry of tableList) {
    const op = entry.split("::")[0]?.toLowerCase() ?? "";
    const ref = parseTableRef(entry);
    if (!ref) {
      continue;
    }
    if (op === "select") {
      reads.push(ref);
    } else {
      writes.push(ref);
      writeOp ??= op;
    }
  }
  for (const target of astWriteTargets(ast)) {
    writes.push(target.ref);
    writeOp ??= target.op;
  }
  return {
    writes: dedupeRefs(writes).map(formatRef),
    reads: dedupeRefs(reads).map(formatRef),
    writeOp,
  };
}

// The one operation a simple statement performs and the tables it names, for the decided
// receipt. Anything the parse cannot vouch for (several statements, a CTE, SELECT ... INTO,
// MERGE, a call, several targets) gets null, and the receipt stays generic.
const RECEIPT_OPS = new Set(["select", "insert", "update", "delete", "drop", "truncate"]);
export function statementReceipt(sql: string, grammar: string): Receipt | null {
  let ast: unknown;
  try {
    ({ ast } = parser.parse(sql, { database: grammar }));
  } catch {
    return null;
  }
  if (Array.isArray(ast)) {
    if (ast.length !== 1) return null;
    ast = ast[0];
  }
  if (!isNode(ast) || typeof ast.type !== "string" || ast.with) {
    return null;
  }
  const type = ast.type.toLowerCase();
  const ops = RECEIPT_OPS.has(type) ? analyzeTableOps(sql, grammar) : null;
  if (!ops) {
    return null;
  }
  if (type === "select") {
    return ops.writes.length || !ops.reads.length ? null : { op: "SELECT", tables: ops.reads };
  }
  return ops.writes.length === 1 && ops.writeOp === type
    ? { op: type.toUpperCase(), tables: ops.writes }
    : null;
}

// Only a statement that changes rows has a meaningful affected count; null when unparsed.
const ROW_OPS = new Set(["insert", "update", "delete", "replace", "merge"]);
export function countsRows(sql: string, grammar: string): boolean | null {
  try {
    const { ast } = parser.parse(sql, { database: grammar });
    const top = Array.isArray(ast) ? ast : [ast];
    return top.length === 1 && isNode(top[0]) && ROW_OPS.has(String(top[0].type).toLowerCase());
  } catch {
    return null;
  }
}

const COMPARISON_OPS = new Set([
  "=",
  "!=",
  "<>",
  "<",
  ">",
  "<=",
  ">=",
  "LIKE",
  "ILIKE",
  "NOT LIKE",
  "NOT ILIKE",
  "SIMILAR TO",
  "NOT SIMILAR TO",
  "~",
  "~*",
  "!~",
  "!~*",
  // MySQL/MariaDB and SQLite spell the regex family their own way.
  "REGEXP",
  "NOT REGEXP",
  "RLIKE",
  "NOT RLIKE",
  "GLOB",
  "IN",
  "NOT IN",
  "BETWEEN",
  "NOT BETWEEN",
  // SQLite compares values with IS/IS NOT; on "IS NULL" they carry no literal anyway.
  "IS",
  "IS NOT",
]);

// A column name as the parser spells it: a plain string, a value node, or a nested
// expr, depending on the dialect and on whether the identifier was quoted.
function columnLabel(node: unknown): string | null {
  if (typeof node === "string") return node;
  if (isNode(node)) {
    if (typeof node.value === "string") return node.value;
    if (isNode(node.expr) && typeof node.expr.value === "string") return node.expr.value;
  }
  return null;
}

function columnName(node: unknown): string | null {
  if (!isNode(node) || node.type !== "column_ref") return null;
  return columnLabel(node.column);
}

// Node types holding a plain string literal, one per dialect family: "string" is
// BigQuery's double-quoted form, "var_string" the T-SQL N'ACME' one.
const STRING_NODES = new Set([
  "single_quote_string",
  "double_quote_string",
  "string",
  "var_string",
]);

function literalValues(node: unknown): string[] {
  if (!isNode(node)) return [];
  const t = node.type;
  return typeof t === "string" && STRING_NODES.has(t) && typeof node.value === "string"
    ? [node.value]
    : [];
}

// A node the grammar allows only one string in: an OUTFILE path, a SELECT ... INTO target.
function stringLiteral(node: unknown): string | null {
  return literalValues(node)[0] ?? null;
}

// Either side of a comparison can wrap what it compares: lower(col), col::text,
// COALESCE(col, ''), max(col), = ANY(ARRAY[...]). Descending those wrappers yields
// the operands that carry the signal, and stopping at every other node keeps a
// subquery's own literals out.
function operands(node: unknown): Record<string, unknown>[] {
  if (!isNode(node)) return [];
  const t = node.type;
  // A JSON function is an operand in itself: splitting it into arguments would drop the
  // key it reads (json_extract(profile, '$.email')), which is where its meaning sits.
  if (t === "function" && !isJsonFunction(node)) return operands(node.args);
  if (t === "aggr_func") return operands(isNode(node.args) ? node.args.expr : null);
  if (t === "cast") return operands(node.expr);
  if (t === "array") return operands(node.expr_list);
  if (t === "expr_list") return Array.isArray(node.value) ? node.value.flatMap(operands) : [];
  return [node];
}

// An operand names what it compares through its column or, for a JSON accessor, through
// its key (profile->>'company_name' carries its meaning in the key, never in "profile").
function hasSensitiveColumn(node: unknown): boolean {
  return operands(node).some((operand) => {
    const col = columnName(operand);
    if (col !== null && classifyColumn(col) !== null) return true;
    return accessorKeys(operand).some((key) => classifyColumn(key) !== null);
  });
}

// String literals that expose a sensitive value in the query text itself: a value
// bound to a PII/client column (WHERE company_name = 'ACME', SET company_name = 'ACME',
// an inserted row), or one whose shape is itself sensitive. Display and sharing checks
// consume the same detection, before display preferences are applied.
export function sensitiveLiterals(sql: string, grammar: string): string[] {
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: grammar });
  } catch {
    return [];
  }
  const found = new Set<string>();
  // An empty value carries nothing and would tint every '' in the rendered query.
  const add = (value: string) => {
    if (value !== "") {
      found.add(value);
    }
  };
  const addLiteral = (node: unknown) => {
    for (const value of literalValues(node)) add(value);
  };
  walk(ast, (n) => {
    for (const value of literalValues(n)) {
      if (sensitiveShape(value)) add(value);
    }
    // Assignments hang off `set` wherever they appear: UPDATE, MySQL INSERT ... SET,
    // and the update branch of an upsert (ON CONFLICT / ON DUPLICATE KEY).
    if (Array.isArray(n.set)) {
      for (const item of n.set) {
        if (!isNode(item)) continue;
        const col = columnLabel(item.column);
        if (col && classifyColumn(col)) addLiteral(item.value);
      }
    }
    // INSERT/REPLACE ... VALUES: the column list lines up positionally with each row.
    if (Array.isArray(n.columns) && isNode(n.values) && Array.isArray(n.values.values)) {
      const columns = n.columns.map(columnLabel);
      for (const row of n.values.values) {
        if (!isNode(row) || !Array.isArray(row.value)) continue;
        row.value.forEach((value, i) => {
          const col = columns[i];
          if (col && classifyColumn(col)) addLiteral(value);
        });
      }
    }
    if (n.type !== "binary_expr" || !COMPARISON_OPS.has(String(n.operator).toUpperCase())) {
      return;
    }
    for (const [side, other] of [
      [n.left, n.right],
      [n.right, n.left],
    ] as const) {
      if (!hasSensitiveColumn(side)) {
        continue;
      }
      for (const operand of operands(other)) {
        for (const value of literalValues(operand)) {
          add(value);
        }
      }
    }
  });
  return [...found];
}
