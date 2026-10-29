import type { SqlEngine } from "../engine";
import { unreadWalk } from "../load-plan";
import { fallback, type RiskVerdict } from "../risk";
import { classifyNsp } from "./classify";
import * as inspect from "./inspect";
import { loadNsp } from "./load";

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

// The engine runs the body of these comments, which node-sql-parser drops: its tree cannot
// represent such a statement, so none of its answers is trusted for it. MariaDB also runs
// /*M! ... */ (https://mariadb.com/kb/en/comment-syntax/).
const EXECUTABLE_COMMENTS: Record<string, string[]> = {
  mysql: ["/*!"],
  mariadb: ["/*!", "/*M!"],
};

// Unread, the statement takes the strictest class, approvable like any statement Gatekeeper
// cannot read. The text check alone would not do: it strips comments without seeing strings,
// so a '/*' inside a string can hide an INTO OUTFILE from it.
function unreadVerdict(sql: string, grammar: string): RiskVerdict {
  const blocked = Boolean(classifyNsp(sql, grammar)?.blocked) || fallback(sql).blocked;
  return { class: "destructive", parseOk: false, blocked };
}

const engines = new Map<string, SqlEngine>();

export function nspEngine(databaseType: string): SqlEngine {
  const grammar = GRAMMAR[databaseType] ?? "postgresql";
  let engine = engines.get(grammar);
  if (!engine) {
    const markers = EXECUTABLE_COMMENTS[grammar] ?? [];
    const unread = (sql: string) => markers.some((marker) => sql.includes(marker));
    engine = {
      dialect: grammar,
      classify: (sql) => (unread(sql) ? unreadVerdict(sql, grammar) : classifyNsp(sql, grammar)),
      analyze: (sql) => (unread(sql) ? null : inspect.analyzeSql(sql, grammar)),
      tableOps: (sql) => (unread(sql) ? null : inspect.analyzeTableOps(sql, grammar)),
      sensitiveLiterals: (sql) => (unread(sql) ? [] : inspect.sensitiveLiterals(sql, grammar)),
      receipt: (sql) => (unread(sql) ? null : inspect.statementReceipt(sql, grammar)),
      countsRows: (sql) => (unread(sql) ? null : inspect.countsRows(sql, grammar)),
      load: (sql) => (unread(sql) ? unreadWalk() : loadNsp(sql, grammar)),
    };
    engines.set(grammar, engine);
  }
  return engine;
}
