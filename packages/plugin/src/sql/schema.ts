import type { SensitivityRecord } from "@gatekeeper/shared";

export interface SchemaContext {
  tables: string[];
  pii: string[];
  client: string[];
  literals: string[];
  star: boolean;
  analysis?: import("./read-analysis").ReadSnapshot;
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
export const IDENTIFIER = /(?:^id|_id|Id|ID)$/;
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

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function dedupeRefs(refs: TableRef[]): TableRef[] {
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

// Accessors that read one key out of a JSON document; the key, not the containing column,
// is what the query exposes.
export const JSON_OPERATORS = new Set(["->", "->>", "#>", "#>>"]);
// Outside snowflake, every dialect names its JSON functions with "json" in them
// (json_extract, jsonb_extract_path_text, JSON_VALUE): a dialect-generic match.
export const JSON_FUNCTION = /json/i;
// A path operand ("$.contact.email", "{contact,email}") holds a key per segment, while
// anything else is one literal key whose dots belong to it ("email.txt").
const JSON_PATH = /^\s*[${]/;

// The names a JSON path operand exposes, outermost first. Array indexes name nothing.
export function jsonKeyNames(path: string): string[] {
  if (!JSON_PATH.test(path)) {
    return path.trim() ? [path.trim()] : [];
  }
  return (
    path
      .split(/[.,[\]{}]/)
      // Strip only what delimits a segment, never a character inside it, so every name
      // returned still occurs verbatim in the operand the highlighter has to mark up.
      .map((segment) => segment.trim().replace(/^["'$]+|["'$]+$/g, ""))
      .filter((segment) => segment !== "" && !/^\d+$/.test(segment))
  );
}

export interface ParsedQuery {
  tables: TableRef[];
  // Source column names as the parser resolves them, plus the column lists it folds into
  // columnList itself (a CTE's, a typed table function's), never an output alias.
  columns: string[];
  // Output names the query assigns (AS, RETURNING, a relation column list): what the
  // result set, and the agent, will see.
  aliases: string[];
  // Keys read out of a JSON document (profile->>'email'): the parser reports only
  // the containing column, so the key is the sole trace of what is exposed.
  jsonKeys: string[];
  star: boolean;
}

// The tables a statement writes versus reads, for the card's Writes/Deletes annotation.
export interface TableOps {
  writes: string[];
  reads: string[];
  writeOp: string | null;
}

// The one operation a simple statement performs and the tables it names, for the decided receipt.
export interface Receipt {
  op: string;
  tables: string[];
}

export function formatRef(ref: TableRef): string {
  return ref.schema ? `${ref.schema}.${ref.name}` : ref.name;
}

type ExposedInput = Pick<ParsedQuery, "columns" | "star"> &
  Partial<Pick<ParsedQuery, "aliases" | "jsonKeys">>;

// The distinct column names a query would expose: the ones it names, the output
// aliases it assigns, the JSON keys it reads, plus (for SELECT *) the real columns
// of the tables it reads.
function exposedColumns(parsed: ExposedInput, tableColumns: string[]): string[] {
  const exposed = new Set<string>([
    ...parsed.columns,
    ...(parsed.aliases ?? []),
    ...(parsed.jsonKeys ?? []),
  ]);
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

// A value whose shape is sensitive whatever column it meets: an email, an IBAN, a card number.
export function sensitiveShape(value: string): boolean {
  return (
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ||
    /^[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}$/.test(value) ||
    /^\d{13,19}$/.test(value.replace(/[ -]/g, ""))
  );
}

/** Local sensitive-name screening for every source, alias and JSON key sent for evaluation. */
export function sensitiveReference(name: string): boolean {
  // ponytail: beta exempts ID names, stronger identifier checks need relation context.
  if (IDENTIFIER.test(name)) return false;
  // A bare `name` is a product's as often as a person's: Jev tells them apart from the
  // relation, while first_name, full_name or company_name still hold through the fragments.
  return (
    looksLikePii(name) ||
    looksLikeClientData(name) ||
    /^(?:ip|ipaddress|ipv4address|ipv6address)$/i.test(name.replace(/_/g, "")) ||
    /(?:^|_)ip(?:_|$)/i.test(name)
  );
}

export function sensitivityOf(schema: SchemaContext): SensitivityRecord {
  return {
    pii: schema.pii.length > 0,
    value: schema.literals.length > 0,
    client: schema.client.length > 0,
  };
}
