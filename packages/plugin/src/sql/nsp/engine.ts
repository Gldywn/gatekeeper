import type { SqlEngine } from "../engine";
import { classifyNsp } from "./classify";
import * as inspect from "./inspect";

// Beekeeper's databaseType to node-sql-parser's grammar name. Engines without a grammar of
// their own are read with its PostgreSQL grammar, as they always were.
const GRAMMAR: Record<string, string> = {
  sqlserver: "transactsql",
  mariadb: "mariadb",
  mysql: "mysql",
  sqlite: "sqlite",
  bigquery: "bigquery",
  snowflake: "snowflake",
};

const engines = new Map<string, SqlEngine>();

export function nspEngine(databaseType: string): SqlEngine {
  const grammar = GRAMMAR[databaseType] ?? "postgresql";
  let engine = engines.get(grammar);
  if (!engine) {
    engine = {
      dialect: grammar,
      classify: (sql) => classifyNsp(sql, grammar),
      analyze: (sql) => inspect.analyzeSql(sql, grammar),
      tableOps: (sql) => inspect.analyzeTableOps(sql, grammar),
      sensitiveLiterals: (sql) => inspect.sensitiveLiterals(sql, grammar),
      receipt: (sql) => inspect.statementReceipt(sql, grammar),
      countsRows: (sql) => inspect.countsRows(sql, grammar),
    };
    engines.set(grammar, engine);
  }
  return engine;
}
