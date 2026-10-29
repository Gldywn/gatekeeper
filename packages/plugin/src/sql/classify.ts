import type { AccessMode } from "@gatekeeper/shared";
import { prepareSql } from "./identifiers";
import { parser } from "./sql-parser";

// The plugin's risk class is the shared access mode; kept as a local alias so the many
// call sites that import RiskClass keep working.
export type RiskClass = AccessMode;

export interface RiskVerdict {
  // Highest risk the statement carries.
  class: RiskClass;
  // false when the class came from the textual fallback, not a real parse.
  parseOk: boolean;
  // Multi-statement or unclassifiable: no mode may approve it.
  blocked: boolean;
}

const RANK: Record<RiskClass, number> = { read: 0, write: 1, destructive: 2 };

export function rank(c: RiskClass): number {
  return RANK[c];
}

// Read-only top-level statements. EXPLAIN is here, but the node walk still escalates
// EXPLAIN ANALYZE of a modifying statement, which does execute.
const READ_STATEMENTS = new Set(["select", "show", "desc", "describe", "explain"]);
const WRITE_STATEMENTS = new Set(["insert", "update"]);

// Node types that mean modification wherever they appear (a CTE, a subquery, an
// EXPLAIN); anything not listed and not a read stays destructive (fail safe).
const MODIFY_NODE: Record<string, RiskClass> = {
  insert: "write",
  update: "write",
  // SELECT ... INTO parses as a select carrying an `into` node; it creates a table
  // (Postgres) or writes/exfiltrates a file (MySQL OUTFILE/DUMPFILE), never a read.
  into: "destructive",
  delete: "destructive",
  drop: "destructive",
  truncate: "destructive",
  alter: "destructive",
  create: "destructive",
  rename: "destructive",
  replace: "destructive",
  merge: "destructive",
  grant: "destructive",
  revoke: "destructive",
  call: "destructive",
  use: "destructive",
  set: "destructive",
  lock: "destructive",
  unlock: "destructive",
};

const LOCKING_READ =
  /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b|\block\s+in\s+share\s+mode\b/i;
const MODIFY_KEYWORDS =
  /\b(insert|update|delete|drop|truncate|alter|create|replace|merge|grant|revoke|call|vacuum|pragma|attach|copy|into|lock)\b/i;

// The comments every engine closes at the same place: `--` plus whitespace, up to LF, CRLF or
// the end (SQLite runs past a lone CR), and a non-executable /* */ with no nested opener.
const LEADING_COMMENTS =
  /^(?:\s+|--(?=[ \t\r\n]|$)[^\r\n]*(?:\r?\n|$)|\/\*(?!M?!)(?:(?!\/\*)[\s\S])*?\*\/)*/;

// Stopgap until these engines are read by their own grammar: node-sql-parser ends a -- or #
// comment at a lone CR where MySQL and SQLite run on to the LF, and takes MySQL's --1 for a
// comment where MySQL reads minus minus one. Its tree is then not the statement that runs.
const LONE_CR = /\r(?!\n)/;
// `--` then any character above space: MySQL wants whitespace or a control character there.
const MYSQL_DASHES = /--(?=[!-\u{10FFFF}])/u;
// Its T-SQL grammar also takes \' for an escaped quote, where SQL Server ends the string, and
// takes a one-word statement for an alias: SQL Server runs SELECT 1 SHUTDOWN as two. No left
// edge: the word can be glued to a number (1SHUTDOWN, 0xABSHUTDOWN).
const TSQL_BACKSLASH = /\\/;
const TSQL_ONE_WORD = /(?:shutdown|reconfigure|checkpoint|commit|rollback|revert|setuser)\b/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function walkTypes(node: unknown, visit: (type: string) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkTypes(child, visit);
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  if (typeof node.type === "string") {
    visit(node.type.toLowerCase());
  }
  for (const key of Object.keys(node)) {
    walkTypes(node[key], visit);
  }
}

// Known limitation: a read-classified SELECT can still have side effects through
// volatile or exec functions (nextval, dblink_exec); a static parse cannot see those.
function topClass(top: string): RiskClass {
  if (READ_STATEMENTS.has(top)) {
    return "read";
  }
  if (WRITE_STATEMENTS.has(top)) {
    return "write";
  }
  return "destructive"; // delete/drop/truncate/… and anything unrecognized fail safe
}

// node-sql-parser cannot parse EXPLAIN in any dialect (it throws), so peel a leading
// EXPLAIN off and classify the statement it wraps. Returns null when there is none.
export function stripExplain(sql: string): { inner: string; analyze: boolean } | null {
  const lead = /^\s*explain\b/i.exec(sql);
  if (!lead) {
    return null;
  }
  let rest = sql.slice(lead[0].length);
  // Postgres accepts ANALYSE as well as ANALYZE; miss it and an EXPLAIN that actually
  // runs a DELETE would read as a harmless plan. Match both, always fail toward "runs".
  // A comment after the options, or a quoted or escaped option name (U&"\0061nalyze"), can
  // spell ANALYZE out of these regexes' sight: count it as one.
  const hidden = (options: string, after: string) =>
    /[^\w\s,]/.test(options) || /^\s*(?:\/\*|--|#)/.test(after);
  const paren = /^\s*\(([^)]*)\)/.exec(rest);
  if (paren) {
    const after = rest.slice(paren[0].length);
    const analyze = /\banaly[sz]e\b/i.test(paren[1]) || hidden(paren[1], after);
    return { inner: after.trim(), analyze };
  }
  let analyze = false;
  const opt = /^\s*(analy[sz]e|verbose)\b/i;
  let m = opt.exec(rest);
  while (m) {
    if (/analy[sz]e/i.test(m[1])) {
      analyze = true;
    }
    rest = rest.slice(m[0].length);
    m = opt.exec(rest);
  }
  return { inner: rest.trim(), analyze: analyze || hidden("", rest) };
}

// The plugin is the only component that runs SQL, so the risk gate lives here: a
// dialect-aware parse, escalated on any embedded modify node; unparseable is blocked.
export function classifyQuery(sql: string, dialect = "postgresql"): RiskVerdict {
  // Before the EXPLAIN peel, so a plain EXPLAIN cannot turn this verdict back into a read.
  const mysqlFamily = dialect === "mysql" || dialect === "mariadb";
  if (
    LONE_CR.test(sql) ||
    (mysqlFamily && MYSQL_DASHES.test(sql)) ||
    (dialect === "transactsql" && (TSQL_BACKSLASH.test(sql) || TSQL_ONE_WORD.test(sql)))
  ) {
    return { class: "destructive", parseOk: false, blocked: fallback(sql).blocked };
  }
  // SQL Server has no EXPLAIN: it calls a procedure of that name and runs what follows.
  const explain = dialect === "transactsql" ? null : stripExplain(sql);
  if (explain && explain.inner.length > 0) {
    // Nested EXPLAIN is invalid in every supported dialect; fail it closed rather than let
    // the plain-EXPLAIN downgrade below turn an inner EXPLAIN ANALYZE <modify> into a read.
    if (stripExplain(explain.inner)) {
      return { class: "destructive", parseOk: false, blocked: true };
    }
    const inner = classifyQuery(explain.inner, dialect);
    // EXPLAIN ANALYZE executes the wrapped statement for real, so it carries that
    // statement's risk; a plain EXPLAIN only plans it, which is read-only.
    if (explain.analyze) {
      return inner;
    }
    return {
      class: inner.blocked ? inner.class : "read",
      parseOk: inner.parseOk,
      blocked: inner.blocked,
    };
  }
  let ast: unknown;
  try {
    ast = parser.astify(prepareSql(sql, dialect).sql, { database: dialect });
  } catch {
    const text = fallback(sql);
    // SQL Server runs a batch whose statements need no `;` between them, so the text check
    // cannot count them: it never reads there.
    return dialect === "transactsql" ? { ...text, class: "destructive" } : text;
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return { class: "destructive", parseOk: true, blocked: true };
  }
  const top = String((statements[0] as Record<string, unknown>).type ?? "").toLowerCase();
  let cls = topClass(top);
  walkTypes(ast, (type) => {
    const nc = MODIFY_NODE[type];
    if (nc && rank(nc) > rank(cls)) {
      cls = nc;
    }
  });
  if (cls === "read" && LOCKING_READ.test(sql)) {
    cls = "write";
  }
  // MySQL executable comments (/*! ... */) run their body on MySQL/MariaDB, but the parser
  // may drop them; never let a modify keyword hidden inside one ride under a read verdict.
  if (rank(cls) < rank("destructive") && executableCommentModifies(sql)) {
    cls = "destructive";
  }
  // Nor a `;` in that dropped body: it starts a second statement.
  if (/\/\*M?!/.test(sql) && fallback(sql).blocked) {
    return { class: "destructive", parseOk: true, blocked: true };
  }
  return { class: cls, parseOk: true, blocked: false };
}

// True when the SQL carries a MySQL or MariaDB executable comment (/*! or /*M!) and a
// data-modifying keyword. Not stripped: stripping comments without seeing strings let a '/*'
// inside a string swallow the body. The blanked view splits /*!50000INTO at the version.
function executableCommentModifies(sql: string): boolean {
  return /\/\*M?!/.test(sql) && matches(MODIFY_KEYWORDS, sql);
}

// A match in any view escalates: markers spaced out (/*!50000INTO), deleting nothing; executable
// bodies kept as MySQL runs them; every comment dropped, as an engine skips /*M! or a gated
// version. Comments become spaces (FOR/**/SHARE); one left open ends at the end, so it is linear.
function matches(re: RegExp, sql: string): boolean {
  const marked = sql.replace(/\/\*M?!\d*/g, " ");
  const kept = sql
    .replace(/\/\*(?!M?!)[\s\S]*?(?:\*\/|$)/g, " ")
    .replace(/--[^\r\n]*|\/\*M?!\d*|\*\//g, " ");
  const dropped = sql.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ").replace(/--[^\r\n]*/g, " ");
  return [marked, kept, dropped].some((view) => re.test(view));
}

// Parser gaps fall back to text: reject empty/multi, a leading SELECT/WITH with no
// modifying keyword reads, everything else is destructive (fail safe).
function fallback(sql: string): RiskVerdict {
  // No parser found the strings, so nothing past the leading comments is removed: a '--'
  // or '/*' inside a string would otherwise swallow the SQL after it.
  const single = sql
    .slice(LEADING_COMMENTS.exec(sql)?.[0].length ?? 0)
    .trim()
    .replace(/;\s*$/, "");
  if (single.length === 0 || single.includes(";")) {
    return { class: "destructive", parseOk: false, blocked: true };
  }
  if (/^(select|with)\b/i.test(single) && !matches(MODIFY_KEYWORDS, single)) {
    // A locking read (FOR SHARE / FOR KEY SHARE fail to parse and land here) takes
    // row locks, so it carries write intent even though it changes no data.
    if (matches(LOCKING_READ, single)) {
      return { class: "write", parseOk: false, blocked: false };
    }
    return { class: "read", parseOk: false, blocked: false };
  }
  // Strictest class but approvable: blocking every statement the parser cannot read made
  // DROP DATABASE unapprovable in the very mode built to gate it. The `;` check above
  // already blocked genuinely multi-statement input.
  return { class: "destructive", parseOk: false, blocked: false };
}
