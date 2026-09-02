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

// A derived table renames its columns inside the relation alias itself, which the
// parser hands back unsplit as the raw string "f(company_name, ...)".
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
        if (isNode(item)) aliases.push(...relationColumnAliases(item.as));
      }
    }
  });
  return unique(aliases);
}

export interface ParsedQuery {
  tables: TableRef[];
  // Source column names as the parser resolves them, never an output alias.
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

// The tables a modifying query writes to versus reads from, split by the parser's
// per-entry operation prefix ("{op}::{schema}::{table}"): everything but a plain
// select is a write/destructive target. Feeds the card's Writes/Deletes annotation.
export function analyzeTableOps(
  sql: string,
  dialect: string,
): { writes: string[]; reads: string[]; writeOp: string | null } | null {
  let tableList: string[];
  try {
    ({ tableList } = parser.parse(sql, { database: dialect }));
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
  "IN",
  "NOT IN",
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IBAN_RE = /^[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}$/;

function columnName(node: unknown): string | null {
  if (!isNode(node) || node.type !== "column_ref") return null;
  const c = node.column;
  if (typeof c === "string") return c;
  if (isNode(c)) {
    if (typeof c.value === "string") return c.value;
    if (isNode(c.expr) && typeof c.expr.value === "string") return c.expr.value;
  }
  return null;
}

function stringLiteral(node: unknown): string | null {
  if (!isNode(node)) return null;
  const t = node.type;
  if (
    (t === "single_quote_string" || t === "double_quote_string") &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  return null;
}

// String literals that expose a sensitive value in the query text itself: a value
// bound to a PII/client column (WHERE company_name = 'ACME'), or one whose shape is
// itself PII (an email or IBAN). Render-only, like the column flags.
export function sensitiveLiterals(sql: string, dialect: string): string[] {
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: dialect });
  } catch {
    return [];
  }
  const found = new Set<string>();
  const addLiteral = (node: unknown) => {
    const v = stringLiteral(node);
    if (v !== null) found.add(v);
  };
  walk(ast, (n) => {
    const s = stringLiteral(n);
    if (s !== null && (EMAIL_RE.test(s) || IBAN_RE.test(s))) {
      found.add(s);
    }
    if (n.type === "binary_expr" && COMPARISON_OPS.has(String(n.operator).toUpperCase())) {
      for (const [side, other] of [
        [n.left, n.right],
        [n.right, n.left],
      ] as const) {
        const col = columnName(side);
        if (col && classifyColumn(col)) {
          addLiteral(other);
          if (isNode(other) && other.type === "expr_list" && Array.isArray(other.value)) {
            for (const item of other.value) addLiteral(item);
          }
        }
      }
    }
  });
  return [...found];
}
