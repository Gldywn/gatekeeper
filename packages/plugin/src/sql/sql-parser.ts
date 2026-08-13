import { Parser } from "node-sql-parser";

// One instance shared by every SQL-inspecting module (read-only guard, schema
// analysis): node-sql-parser holds no per-call state, so reusing it is safe.
export const parser = new Parser();

// Beekeeper's databaseType to the dialect name node-sql-parser expects. The single
// home for dialect handling; every parse that needs a dialect routes through here.
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
