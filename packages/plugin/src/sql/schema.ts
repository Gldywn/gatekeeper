import { parser } from "./sql-parser";

export interface SchemaContext {
  tables: string[];
  pii: string[];
  client: string[];
  literals: string[];
  star: boolean;
}

export interface TableRef {
  // The parsed schema qualifier (e.g. "audit" in audit.users), or null when the
  // table is unqualified and resolves against the connection's default schema.
  schema: string | null;
  name: string;
}

// Column-name fragments that suggest personal data. Deliberately conservative:
// bare "name" is excluded (too noisy: table_name, product_name), while specific
// person, contact, and secret fields are in.
const PII_FRAGMENTS = [
  "email",
  "phone",
  "mobile",
  "address",
  "street",
  "zipcode",
  "postal",
  "ssn",
  "passport",
  "nationality",
  "birth",
  "dob",
  "firstname",
  "lastname",
  "fullname",
  "surname",
  "ownername",
  "iban",
  "bic",
  "swift",
  "creditcard",
  "cardnumber",
  "cvv",
  "zip",
  "password",
  "passwd",
  "secret",
  "apikey",
  "token",
  "salary",
];

// A column is an identifier when it ends in an id suffix (id, user_id, addressId).
const IDENTIFIER = /(?:^id|_id|Id|ID)$/;
// Short names whose substring is too common to match; flagged only on an exact,
// separator-stripped match (pin is a security code).
const EXACT = new Set(["pin"]);
// IP is debugging signal here, not personal data. Allow the common spellings before
// the postal-"address" fragment can catch ip_address / ipAddress.
const IP_ALLOW = new Set(["ip", "ipaddress", "ipv4address", "ipv6address"]);

export function looksLikePii(column: string): boolean {
  // Foreign keys and identifiers are references the agent legitimately needs, not
  // the sensitive value itself, even when the name embeds a PII word such as
  // "address" (billingAddressId); never flag them.
  if (IDENTIFIER.test(column)) {
    return false;
  }
  const normalized = column.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (IP_ALLOW.has(normalized)) {
    return false;
  }
  if (EXACT.has(normalized)) {
    return true;
  }
  return PII_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

// A customer company's identity or commercial terms: a confidentiality axis distinct
// from personal PII, surfaced separately. High-precision (no bare "price"/"amount")
// so it does not cry wolf on generic columns.
const CLIENT_FRAGMENTS = [
  "company",
  "organization",
  "organisation",
  "raisonsociale",
  "employer",
  "clientname",
  "customername",
  "accountname",
  "headcount",
  "contractvalue",
  "contractamount",
];
// Short tokens whose substring is too common to match (vat in "private", arr in
// "array"); flagged only on an exact, separator-stripped match.
const CLIENT_EXACT = new Set(["siren", "siret", "vat", "tva", "rcs", "mrr", "arr"]);

export function looksLikeClientData(column: string): boolean {
  // company_id / account_id are the opaque references the agent should use, never
  // the sensitive value; never flag an identifier.
  if (IDENTIFIER.test(column)) {
    return false;
  }
  const normalized = column.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (CLIENT_EXACT.has(normalized)) {
    return true;
  }
  return CLIENT_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

// A column carries at most one class; PII wins so anything that reads as personal is
// surfaced as PII rather than client data.
export function classifyColumn(column: string): "pii" | "client" | null {
  if (looksLikePii(column)) {
    return "pii";
  }
  if (looksLikeClientData(column)) {
    return "client";
  }
  return null;
}

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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function dedupeRefs(refs: TableRef[]): TableRef[] {
  const seen = new Set<string>();
  const out: TableRef[] = [];
  for (const ref of refs) {
    const key = `${ref.schema ?? ""}.${ref.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
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

// A relation renames its columns inside the alias itself, which the parser hands back
// unsplit as the raw string "f(company_name, ...)". A quoted alias holding parentheses is
// indistinguishable and is split too; a quoted column name holding them never matches.
const RELATION_COLUMN_LIST = /^[^()]+\(([^()]*)\)$/;

function relationColumnAliases(as: unknown): string[] {
  const alias = aliasName(as);
  const columns = alias ? RELATION_COLUMN_LIST.exec(alias.trim())?.[1] : undefined;
  if (columns === undefined) return [];
  return columns
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
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
        const renamed = relationColumnAliases(item.as);
        if (renamed.length > 0) {
          aliases.push(...renamed);
          continue;
        }
        const alias = isFunctionRelation(item) ? aliasName(item.as) : null;
        if (alias) aliases.push(alias);
      }
    }
  });
  return unique(aliases);
}

export interface ParsedQuery {
  tables: TableRef[];
  // Source column names as the parser resolves them, plus the column lists it folds into
  // columnList itself (a CTE's, a typed table function's), never an output alias.
  columns: string[];
  // Output names the query assigns (AS, RETURNING, a relation column list): what the
  // result set, and the agent, will see.
  aliases: string[];
  star: boolean;
}

// Returns null when the parser cannot handle the statement, so the caller can
// skip annotation rather than show something wrong.
export function analyzeSql(sql: string, dialect: string): ParsedQuery | null {
  try {
    const { tableList, columnList, ast } = parser.parse(sql, { database: dialect });
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
      star,
    };
  } catch {
    return null;
  }
}

function formatRef(ref: TableRef): string {
  return ref.schema ? `${ref.schema}.${ref.name}` : ref.name;
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
export function analyzeTableOps(
  sql: string,
  dialect: string,
): { writes: string[]; reads: string[]; writeOp: string | null } | null {
  let tableList: string[];
  let ast: unknown;
  try {
    ({ tableList, ast } = parser.parse(sql, { database: dialect }));
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

type ExposedInput = Pick<ParsedQuery, "columns" | "star"> & Partial<Pick<ParsedQuery, "aliases">>;

// The distinct column names a query would expose: the ones it names, the output
// aliases it assigns, plus (for SELECT *) the real columns of the tables it reads.
function exposedColumns(parsed: ExposedInput, tableColumns: string[]): string[] {
  const exposed = new Set<string>([...parsed.columns, ...(parsed.aliases ?? [])]);
  if (parsed.star) {
    for (const name of tableColumns) {
      exposed.add(name);
    }
  }
  return [...exposed];
}

export function piiColumns(parsed: ExposedInput, tableColumns: string[]): string[] {
  return unique(exposedColumns(parsed, tableColumns).filter((c) => classifyColumn(c) === "pii"));
}

export function clientColumns(parsed: ExposedInput, tableColumns: string[]): string[] {
  return unique(exposedColumns(parsed, tableColumns).filter((c) => classifyColumn(c) === "client"));
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IBAN_RE = /^[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}$/;

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

// The quoted spans of a raw SQL fragment the parser kept as text instead of modelling,
// escapes included so the value still matches the query text. Single quotes only: the
// parser re-quotes an unmodelled operand (IS DISTINCT FROM) with double quotes, where a
// value and a bare column read alike.
const RAW_QUOTED = /'((?:[^'\\]|''|\\.)*)'/g;

// Node types holding a plain string literal, one per dialect family: "string" is
// BigQuery's double-quoted form, "var_string" the T-SQL N'ACME' one.
const STRING_NODES = new Set([
  "single_quote_string",
  "double_quote_string",
  "string",
  "var_string",
]);

// The literal values a node carries. Beyond the string nodes, the parser leaves E'ACME'
// as raw text in a "default" node, and dollar-quoted $$ACME$$ as a "var" whose prefix and
// suffix match (which a $1 bind parameter, having no suffix, never does).
function literalValues(node: unknown): string[] {
  if (!isNode(node)) return [];
  const t = node.type;
  if (typeof t === "string" && STRING_NODES.has(t) && typeof node.value === "string") {
    return [node.value];
  }
  if (t === "var" && typeof node.name === "string" && typeof node.prefix === "string") {
    return node.prefix === node.suffix ? [node.name] : [];
  }
  if (t === "default" && typeof node.value === "string") {
    return [...node.value.matchAll(RAW_QUOTED)].map((m) => m[1]);
  }
  return [];
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
  if (t === "function") return operands(node.args);
  if (t === "aggr_func") return operands(isNode(node.args) ? node.args.expr : null);
  if (t === "cast") return operands(node.expr);
  if (t === "array") return operands(node.expr_list);
  if (t === "expr_list") return Array.isArray(node.value) ? node.value.flatMap(operands) : [];
  return [node];
}

function hasSensitiveColumn(node: unknown): boolean {
  return operands(node).some((operand) => {
    const col = columnName(operand);
    return col !== null && classifyColumn(col) !== null;
  });
}

// String literals that expose a sensitive value in the query text itself: a value
// bound to a PII/client column (WHERE company_name = 'ACME', SET company_name = 'ACME',
// an inserted row), or one whose shape is itself PII (an email or IBAN). Render-only,
// like the column flags.
export function sensitiveLiterals(sql: string, dialect: string): string[] {
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: dialect });
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
      if (EMAIL_RE.test(value) || IBAN_RE.test(value)) {
        add(value);
      }
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
