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

// MySQL and MariaDB run the body of a /*! ... */ comment, which node-sql-parser drops: its tree
// cannot represent such a statement, so none of these engines' answers is trusted for it.
const EXECUTABLE_COMMENTS = new Set(["mysql", "mariadb"]);

const engines = new Map<string, SqlEngine>();

export function nspEngine(databaseType: string): SqlEngine {
  const grammar = GRAMMAR[databaseType] ?? "postgresql";
  let engine = engines.get(grammar);
  if (!engine) {
    const unread = (sql: string) => EXECUTABLE_COMMENTS.has(grammar) && sql.includes("/*!");
    engine = {
      dialect: grammar,
      classify: (sql) => (unread(sql) ? null : classifyNsp(sql, grammar)),
      analyze: (sql) => (unread(sql) ? null : inspect.analyzeSql(sql, grammar)),
      tableOps: (sql) => (unread(sql) ? null : inspect.analyzeTableOps(sql, grammar)),
      sensitiveLiterals: (sql) => (unread(sql) ? [] : inspect.sensitiveLiterals(sql, grammar)),
      receipt: (sql) => (unread(sql) ? null : inspect.statementReceipt(sql, grammar)),
      countsRows: (sql) => (unread(sql) ? null : inspect.countsRows(sql, grammar)),
    };
    engines.set(grammar, engine);
  }
  return engine;
}
