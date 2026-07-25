import { Parser } from "node-sql-parser";

const parser = new Parser();
const FORBIDDEN =
  /"type"\s*:\s*"(delete|update|insert|replace|create|drop|alter|truncate|call|use|grant|revoke|set|lock)"/i;

export function mapDialect(databaseType: string): string {
  switch (databaseType) {
    case "sqlserver":
      return "transactsql";
    case "mariadb":
    case "mysql":
    case "sqlite":
    case "bigquery":
    case "snowflake":
      return databaseType;
    default:
      return "postgresql";
  }
}

function conservativeReadOnly(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  if (stripped.length === 0) {
    return false;
  }
  const single = stripped.replace(/;\s*$/, "");
  if (single.includes(";")) {
    return false;
  }
  return /^(select|with)\b/i.test(single);
}

// The plugin is the only component that can call runQuery, so the read-only rule
// lives here. A dialect-aware parse fails closed: exactly one SELECT with no
// data-modifying node anywhere. Parser gaps fall back to a leading-keyword check.
export function isReadOnlyQuery(sql: string, dialect = "postgresql"): boolean {
  try {
    const ast = parser.astify(sql, { database: dialect });
    const statements = Array.isArray(ast) ? ast : [ast];
    if (statements.length !== 1) {
      return false;
    }
    if ((statements[0] as { type?: string }).type !== "select") {
      return false;
    }
    return !FORBIDDEN.test(JSON.stringify(ast));
  } catch {
    return conservativeReadOnly(sql);
  }
}
