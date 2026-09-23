// Built-in types only, each mapped to a CAST target the parser keeps intact (INT8 would
// parse as INT(8)). timetz has no such target and stays unparsed, so it holds.
const TYPED_LITERAL_TARGET: Record<string, string> = {
  "timestamp with time zone": "TIMESTAMPTZ",
  "timestamp without time zone": "TIMESTAMP",
  timestamptz: "TIMESTAMPTZ",
  uuid: "UUID",
  jsonb: "JSONB",
  json: "JSON",
  numeric: "NUMERIC",
  int8: "BIGINT",
  bigint: "BIGINT",
  integer: "INTEGER",
  text: "TEXT",
  boolean: "BOOLEAN",
  bool: "BOOLEAN",
  inet: "INET",
};
const TYPED_LITERAL =
  /^(timestamp\s+with\s+time\s+zone|timestamp\s+without\s+time\s+zone|timestamptz|uuid|jsonb|json|numeric|int8|bigint|integer|text|boolean|bool|inet)\s+(?=')/i;

// node-sql-parser 5.4 loses relation quoting and cannot parse doubled identifier quotes.
// Substitute quoted names only for analysis, then restore exact names at its boundaries.
export function preparePgSql(sql: string) {
  const names = new Map<string, string>();
  let prefix = "gkquoted_";
  while (sql.toLowerCase().includes(prefix)) prefix += "_";
  let prepared = "";
  let castTarget = "";
  let ordinaryBackslash = false;
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (/^u&["']/i.test(rest)) throw new Error("Unsupported Unicode escape syntax");
    if (rest.startsWith("--")) {
      const end = /[\r\n]/.exec(rest);
      i = end === null ? sql.length : i + end.index;
      prepared += " ";
    } else if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error("Unclosed SQL comment");
      prepared += " ";
    } else if (rest[0] === '"') {
      const quoted = /^"(?:[^"]|"")*"/.exec(rest)?.[0];
      if (!quoted) throw new Error("Unclosed SQL identifier");
      const name = quoted.slice(1, -1).replace(/""/g, '"');
      if (!validIdentifier(name)) throw new Error("Unsupported SQL identifier");
      const marker = `${prefix}${names.size}`;
      names.set(marker, name);
      prepared += `"${marker}"`;
      i += quoted.length;
    } else if (rest[0] === "'" || /^[eE]'/.test(rest)) {
      const escaped = rest[0] !== "'";
      const start = i;
      i += escaped ? 2 : 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "\\") {
          // An escaped quote can change statement boundaries when this setting is off.
          if (!escaped && sql[i + 1] === "'") throw new Error("Ambiguous SQL string escape");
          if (!escaped) ordinaryBackslash = true;
          i += escaped ? 2 : 1;
        } else if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            closed = true;
            break;
          }
        } else i++;
      }
      if (!closed) throw new Error("Unclosed SQL string");
      prepared += sql.slice(start, i);
      if (castTarget) {
        prepared += ` AS ${castTarget})`;
        castTarget = "";
      }
    } else if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(rest)) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)![0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error("Unclosed SQL string");
      prepared += sql.slice(i, end + tag.length);
      i = end + tag.length;
    } else {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest)?.[0];
      if (word) {
        // The parser knows CAST but not PostgreSQL's typed-literal spelling `type 'value'`.
        const typed = TYPED_LITERAL.exec(rest);
        if (typed) {
          prepared += "CAST(";
          castTarget = TYPED_LITERAL_TARGET[typed[1].toLowerCase().replace(/\s+/g, " ")];
          i += typed[0].length;
          continue;
        }
        // Parser-only spelling: PostgreSQL runs the submitted FETCH FIRST unchanged.
        const fetch = /^fetch\s+first\s+(\d+)\s+rows?\s+only\b/i.exec(rest);
        if (fetch) {
          prepared += `limit ${fetch[1]}`;
          i += fetch[0].length;
          continue;
        }
        prepared += word.toLowerCase();
        i += word.length;
      } else {
        // Non-ASCII case folding depends on the database encoding and locale.
        if (sql.charCodeAt(i) > 127) throw new Error("Quote non-ASCII identifiers");
        prepared += sql[i++];
      }
    }
  }
  return {
    sql: prepared,
    ordinaryBackslash,
    name: (value: string): string => names.get(value) ?? value,
    restoreSql: (value: string): string =>
      value.replace(
        new RegExp(`"?${prefix}[0-9]+"?`, "g"),
        (marker) => `"${names.get(marker.replaceAll('"', ""))!.replaceAll('"', '""')}"`,
      ),
    restoreAst: <T>(value: T): T => restoreNames(value, names),
  };
}

function restoreNames<T>(value: T, names: Map<string, string>): T {
  if (typeof value === "string") return (names.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => restoreNames(v, names)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, restoreNames(v, names)]),
    ) as T;
  return value;
}

export function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    new TextEncoder().encode(value).length <= 63
  );
}

// Explicit E strings escape both delimiters and backslashes independently of session settings.
export function identifierLiteral(value: string): string {
  if (!validIdentifier(value)) throw new Error("Invalid relation");
  return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}
