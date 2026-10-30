import type { SqlEngine } from "../engine";
import { unreadWalk } from "../load-plan";
import { fallback, type RiskVerdict } from "../risk";
import { classifyNsp, parsesAsSeveral } from "./classify";
import * as inspect from "./inspect";
import { loadNsp } from "./load";
import { outputNsp } from "./output";

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

// node-sql-parser ends a -- or # comment at a lone CR, where MySQL and SQLite run on to the LF.
const LONE_CR = /\r(?!\n)/;
// And takes MySQL's --1 for a comment, where MySQL wants whitespace or a control after `--`.
const MYSQL_DASHES = /--(?=[!-\u{10FFFF}])/u;
// Where its tree is not the statement the engine runs, none of its answers is trusted. Stopgap
// until these engines are read by their own grammar.
const UNREAD: Record<string, RegExp[]> = {
  // The engine runs the /*! body the parser drops, MariaDB the /*M! one too
  // (https://mariadb.com/kb/en/comment-syntax/).
  mysql: [/\/\*!/, MYSQL_DASHES],
  mariadb: [/\/\*M?!/, MYSQL_DASHES],
  // SQL Server ends a string at \', runs SELECT 1 SHUTDOWN as two statements (glued to a number
  // too: 1SHUTDOWN) and excludes U+0080 to U+00A0 from names, which the parser reads as aliases.
  transactsql: [
    /\\/,
    /(?:shutdown|reconfigure|checkpoint|commit|rollback|revert|setuser)\b/i,
    /[\u0080-\u00a0]/,
  ],
};

// Unread, the statement takes the strictest class, approvable like any statement Gatekeeper
// cannot read. The text check alone would not do: it strips comments without seeing strings,
// so a '/*' inside a string can hide an INTO OUTFILE from it.
function unreadVerdict(sql: string, grammar: string): RiskVerdict {
  const blocked = fallback(sql).blocked || parsesAsSeveral(sql, grammar);
  return { class: "destructive", parseOk: false, blocked };
}

const engines = new Map<string, SqlEngine>();

export function nspEngine(databaseType: string): SqlEngine {
  const grammar = GRAMMAR[databaseType] ?? "postgresql";
  let engine = engines.get(grammar);
  if (!engine) {
    const patterns = [LONE_CR, ...(UNREAD[grammar] ?? [])];
    const unread = (sql: string) => patterns.some((re) => re.test(sql));
    engine = {
      dialect: grammar,
      classify: (sql) => {
        if (unread(sql)) return unreadVerdict(sql, grammar);
        // SQL Server runs a batch whose statements need no `;`, which the text check cannot
        // count: what it cannot parse is never read there.
        const parsed = classifyNsp(sql, grammar);
        return parsed ?? (grammar === "transactsql" ? unreadVerdict(sql, grammar) : null);
      },
      analyze: (sql) => (unread(sql) ? null : inspect.analyzeSql(sql, grammar)),
      tableOps: (sql) => (unread(sql) ? null : inspect.analyzeTableOps(sql, grammar)),
      sensitiveLiterals: (sql) => (unread(sql) ? [] : inspect.sensitiveLiterals(sql, grammar)),
      receipt: (sql) => (unread(sql) ? null : inspect.statementReceipt(sql, grammar)),
      countsRows: (sql) => (unread(sql) ? null : inspect.countsRows(sql, grammar)),
      output: (sql, columns) => (unread(sql) ? null : outputNsp(sql, grammar, columns)),
      load: (sql) => (unread(sql) ? unreadWalk() : loadNsp(sql, grammar)),
    };
    engines.set(grammar, engine);
  }
  return engine;
}
