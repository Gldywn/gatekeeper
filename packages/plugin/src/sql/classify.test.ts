import { describe, expect, it } from "vitest";
import { classifyQuery, rank } from "./classify";

const pg = "postgresql";

describe("classifyQuery", () => {
  it("classifies plain reads", () => {
    for (const sql of [
      "SELECT 1",
      "select id, name from users where id = 1",
      "WITH t AS (SELECT 1 AS n) SELECT * FROM t",
    ]) {
      const v = classifyQuery(sql, pg);
      expect(v.class, sql).toBe("read");
      expect(v.blocked, sql).toBe(false);
    }
  });

  it("classifies plain writes", () => {
    expect(classifyQuery("INSERT INTO users (id) VALUES (1)", pg).class).toBe("write");
    expect(classifyQuery("UPDATE users SET name = 'x' WHERE id = 1", pg).class).toBe("write");
  });

  it("classifies destructive statements", () => {
    for (const sql of [
      "DELETE FROM users",
      "DROP TABLE users",
      "TRUNCATE users",
      "ALTER TABLE users ADD COLUMN x int",
      "CREATE TABLE t (id int)",
      "GRANT SELECT ON users TO bob",
    ]) {
      expect(classifyQuery(sql, pg).class, sql).toBe("destructive");
    }
  });

  it("never reads a write hidden inside a read shape", () => {
    // INSERT ... SELECT and a locking read must not classify as a plain read.
    expect(
      rank(classifyQuery("INSERT INTO audit SELECT * FROM users", pg).class),
    ).toBeGreaterThanOrEqual(rank("write"));
    expect(
      rank(classifyQuery("SELECT id FROM users WHERE id = 1 FOR UPDATE", pg).class),
    ).toBeGreaterThanOrEqual(rank("write"));
  });

  it("never reads a write hidden in a MySQL executable comment", () => {
    for (const sql of [
      "SELECT 1 /*!40000 DROP TABLE t */",
      "SELECT 1 /*!, DELETE FROM t */",
      "SELECT * FROM t /*!40000 INTO OUTFILE '/tmp/x' */",
    ]) {
      expect(classifyQuery(sql, "mysql").class, sql).toBe("destructive");
    }
  });

  it("leaves a benign MySQL optimizer hint as a read", () => {
    const v = classifyQuery("SELECT /*!40001 SQL_NO_CACHE */ * FROM t", "mysql");
    expect(v.class).toBe("read");
    expect(v.blocked).toBe(false);
  });

  it("never reads a locking read (FOR SHARE / LOCK IN SHARE MODE)", () => {
    for (const [sql, dialect] of [
      ["SELECT * FROM t FOR SHARE", "postgresql"],
      ["SELECT * FROM t FOR KEY SHARE", "postgresql"],
      ["SELECT * FROM t LOCK IN SHARE MODE", "mysql"],
    ] as const) {
      const v = classifyQuery(sql, dialect);
      expect(v.class === "read" && !v.blocked, sql).toBe(false);
    }
  });

  it("blocks multi-statement input", () => {
    for (const sql of ["SELECT 1; DROP TABLE users", "SELECT 1; SELECT 2"]) {
      expect(classifyQuery(sql, pg).blocked, sql).toBe(true);
    }
  });

  it("never reads a SELECT ... INTO (table create / file write)", () => {
    for (const [sql, dialect] of [
      ["SELECT * INTO stolen FROM users", "postgresql"],
      ["SELECT * FROM users INTO OUTFILE '/tmp/x.csv'", "mysql"],
      ["SELECT * INTO DUMPFILE '/tmp/x' FROM users", "mysql"],
    ] as const) {
      const v = classifyQuery(sql, dialect);
      // The security property: it must never be an approvable read.
      expect(v.class === "read" && !v.blocked, sql).toBe(false);
    }
  });

  it("fails a data-modifying CTE closed, never read", () => {
    expect(classifyQuery("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", pg).class).toBe(
      "destructive",
    );
  });

  it("reads an EXPLAIN of a SELECT, approvable (the parser cannot parse EXPLAIN itself)", () => {
    for (const sql of [
      "EXPLAIN SELECT 1",
      "EXPLAIN VERBOSE SELECT id FROM users",
      "EXPLAIN (FORMAT JSON) SELECT 1",
      "EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM users WHERE id = 1",
      // The reported query: schema-qualified tables, subqueries, ->> JSON access.
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT t.id FROM subvention.subvention_transaction t
       WHERE t.subvention_id = (SELECT subvention_id FROM subvention.subvention_transaction WHERE id = 'x')
         AND t.metadata->>'orderId' IN (SELECT s.metadata->>'orderId' FROM subvention.subvention_transaction s WHERE s.id = 'x')`,
    ]) {
      const v = classifyQuery(sql, pg);
      expect(v.class, sql).toBe("read");
      expect(v.blocked, sql).toBe(false);
    }
  });

  // SECURITY: EXPLAIN ANALYZE (or ANALYSE) actually runs the wrapped statement, so it must
  // carry that statement's risk and never read as a harmless plan.
  it("never lets EXPLAIN ANALYZE hide a modifying statement", () => {
    for (const [sql, cls] of [
      ["EXPLAIN ANALYZE DELETE FROM users", "destructive"],
      ["EXPLAIN ANALYSE DELETE FROM users", "destructive"],
      ["EXPLAIN (ANALYZE, BUFFERS) DELETE FROM users WHERE id = 1", "destructive"],
      ["EXPLAIN (ANALYSE) TRUNCATE users", "destructive"],
      ["EXPLAIN ANALYZE UPDATE users SET name = 'x' WHERE id = 1", "write"],
      ["EXPLAIN (ANALYZE) INSERT INTO users (id) VALUES (1)", "write"],
    ] as const) {
      const v = classifyQuery(sql, pg);
      expect(v.class, sql).toBe(cls);
      // Approvable under the matching mode (not a dead blocked card), but never a read.
      expect(v.class === "read", sql).toBe(false);
      expect(v.blocked, sql).toBe(false);
    }
  });

  // A plain EXPLAIN (no ANALYZE) only plans; it never executes the wrapped DML.
  it("treats a plain EXPLAIN of a modifying statement as a read (plan only)", () => {
    for (const sql of ["EXPLAIN DELETE FROM users", "EXPLAIN VERBOSE UPDATE users SET x = 1"]) {
      const v = classifyQuery(sql, pg);
      expect(v.class, sql).toBe("read");
      expect(v.blocked, sql).toBe(false);
    }
  });

  // SECURITY: the engine reads a comment as a space, so EXPLAIN /**/ ANALYZE runs the DELETE;
  // the option regexes saw no ANALYZE and downgraded it to a plan.
  it("never lets a comment or an escaped option name hide EXPLAIN ANALYZE", () => {
    for (const [sql, dialect] of [
      ["EXPLAIN /**/ ANALYZE DELETE FROM users", pg],
      ["EXPLAIN VERBOSE /**/ ANALYZE DELETE FROM users", pg],
      ["EXPLAIN -- x\nANALYZE DELETE FROM users", pg],
      ['EXPLAIN (FORMAT JSON, U&"\\0061nalyze" true) DELETE FROM users', pg],
      ["EXPLAIN /*!ANALYZE*/ DELETE t FROM t JOIN u ON t.a = u.a", "mysql"],
    ] as const) {
      const v = classifyQuery(sql, dialect);
      expect(v.class === "read" && !v.blocked, sql).toBe(false);
    }
    expect(classifyQuery("EXPLAIN /* note */ SELECT 1", pg).class).toBe("read");
  });

  it("still blocks a multi-statement EXPLAIN", () => {
    expect(classifyQuery("EXPLAIN SELECT 1; DROP TABLE users", pg).blocked).toBe(true);
  });

  // Nested EXPLAIN is invalid SQL; it must never downgrade an inner ANALYZE modify to read.
  it("blocks a nested EXPLAIN instead of reading its inner ANALYZE", () => {
    for (const sql of [
      "EXPLAIN EXPLAIN ANALYZE DELETE FROM users",
      "EXPLAIN ANALYZE EXPLAIN SELECT 1",
    ]) {
      const v = classifyQuery(sql, pg);
      expect(v.class === "read", sql).toBe(false);
      expect(v.blocked, sql).toBe(true);
    }
  });

  it("treats an unrecognized statement as destructive (fail safe on the class)", () => {
    const v = classifyQuery("VACUUM", pg);
    expect(v.class).toBe("destructive");
    expect(v.parseOk).toBe(false);
  });

  it("classifies a MySQL REPLACE as destructive", () => {
    expect(classifyQuery("REPLACE INTO users (id) VALUES (1)", "mysql").class).toBe("destructive");
  });

  // The skill sends agents without Schema access to these SQLite introspection forms, so
  // they must stay approvable in Read mode, while the bare PRAGMA statement stays strict.
  it("reads the SQLite catalog forms the skill recommends, never a bare PRAGMA", () => {
    for (const sql of [
      "SELECT name, type FROM pragma_table_info('users')",
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ]) {
      const v = classifyQuery(sql, "sqlite");
      expect(v.class, sql).toBe("read");
      expect(v.blocked, sql).toBe(false);
    }
    expect(classifyQuery("PRAGMA table_info(users)", "sqlite").class).toBe("destructive");
  });

  it("blocks empty or comment-only input", () => {
    for (const sql of ["", "   ", "-- just a comment"]) {
      expect(classifyQuery(sql, pg).blocked, sql).toBe(true);
    }
  });

  // node-sql-parser knows none of these. Blocking them made the archetypal destructive
  // statement unapprovable in the very mode built to gate it.
  it("leaves a single unparseable statement approvable, at the strictest class", () => {
    for (const sql of [
      'DROP DATABASE IF EXISTS "hpal__6590549bf90d4356a1f3196bd3bcf0a7"',
      'DROP DATABASE IF EXISTS "hpal__6590549bf90d4356a1f3196bd3bcf0a7" WITH (FORCE)',
      "DROP DATABASE gatekeeper_test",
      "VACUUM FULL users",
    ]) {
      const v = classifyQuery(sql, pg);
      expect(v.class, sql).toBe("destructive");
      expect(v.blocked, sql).toBe(false);
      // The card leans on this to warn that the class is a guess.
      expect(v.parseOk, sql).toBe(false);
    }
  });

  it("still blocks multiple statements even when they do not parse", () => {
    for (const sql of [
      'DROP DATABASE "a"; DROP DATABASE "b"',
      "VACUUM FULL users; DROP TABLE users",
    ]) {
      expect(classifyQuery(sql, pg).blocked, sql).toBe(true);
    }
  });

  const approvableRead = (sql: string, dialect: string) => {
    const v = classifyQuery(sql, dialect);
    return v.class === "read" && !v.blocked;
  };

  // SECURITY: the text check cannot see strings, so a '--' or '/*' inside one used to delete
  // the second statement and return a read. node-sql-parser rejects every input below.
  it("never lets a string hide a second statement from the text check", () => {
    for (const [sql, dialect] of [
      ["SELECT '--'; FLUSH TABLES", "mysql"],
      ["SELECT '--'; FLUSH TABLES", "mariadb"],
      ["SELECT '/*'; FLUSH TABLES; SELECT '*/'", "mysql"],
      ["SELECT '--'; DROP DATABASE x", pg],
      ["SELECT '--'; COPY t TO PROGRAM 'id'", pg],
      ["SELECT '/*'; DROP DATABASE x; SELECT '*/'", pg],
    ] as const) {
      expect(classifyQuery(sql, dialect).blocked, sql).toBe(true);
    }
  });

  it("never reads an INTO OUTFILE or a locking clause a string hid from the text check", () => {
    for (const [sql, dialect] of [
      ["SELECT '/*', a FROM t PARTITION (p0) INTO OUTFILE '/tmp/x' -- */", "mysql"],
      // A number ends at a letter, so no word boundary precedes INTO.
      ["SELECT 1e1INTO OUTFILE '/tmp/x'", "mysql"],
      ["SELECT .5INTO OUTFILE '/tmp/x'", "mariadb"],
      // Nor does it after a dollar quote's closing $: PostgreSQL creates the table.
      ["SELECT $$a$$INTO TABLE t FROM u", pg],
      ["SELECT id, $q$x$q$INTO TABLE stolen FROM users", pg],
      ["SELECT * FROM t WHERE a = $$x$$FOR SHARE", pg],
      ["SELECT '/*' FROM t FOR NO KEY UPDATE -- */", pg],
      ["SELECT '--' FROM t\nFOR SHARE", pg],
    ] as const) {
      expect(approvableRead(sql, dialect), sql).toBe(false);
    }
  });

  // Only comments every engine closes at the same place are skipped to find the first keyword;
  // PostgreSQL nests /* */, so a first-close strip would expose the SELECT inside one.
  it("skips only the leading comments every engine delimits alike", () => {
    for (const [sql, dialect] of [
      ["/* /* */ SELECT 1 */ CHECKPOINT", pg],
      ["/* ok */ /*! SET @a = 1 */ SELECT a FROM t PARTITION (p0)", "mysql"],
    ] as const) {
      expect(approvableRead(sql, dialect), sql).toBe(false);
    }
    for (const sql of [
      "/* ; UPDATE */ -- note; see\nSELECT a FROM t PARTITION (p0)",
      "-- note\r\nSELECT a FROM t PARTITION (p0)",
    ]) {
      const v = classifyQuery(sql, "mysql");
      expect(v, sql).toEqual({ class: "read", parseOk: false, blocked: false });
    }
  });

  it("keeps a locking clause split by comments a locking read", () => {
    for (const [sql, dialect] of [
      ["SELECT * FROM t FOR/**/SHARE", pg],
      ["SELECT * FROM t FOR /* a */ /* b */ KEY -- c\n SHARE", pg],
      // MySQL runs the executable body, comments inside it included.
      ["SELECT * FROM t /*!FOR/**/SHARE*/", "mysql"],
      ["SELECT * FROM t PARTITION (p0) /*! FOR -- x\n SHARE */", "mysql"],
      // And skips a MariaDB body or a newer version's; elsewhere /*! is an ordinary comment.
      ["SELECT * FROM t FOR/*M! x */SHARE", "mysql"],
      ["SELECT * FROM t FOR/*!99999 x*/SHARE", "mysql"],
      ["SELECT * FROM t FOR/*!x*/SHARE", pg],
      ["SELECT * FROM t /*!FOR/*M!x*/SHARE*/", "mysql"],
      // A '/*' that never closes, in a string or a line comment, must not swallow the rest.
      ["SELECT '/*' FROM t FOR-- x\nSHARE", pg],
      ["SELECT '/*' FROM t FOR-- x\nSHARE", "mysql"],
      ["SELECT * FROM t FOR -- see /* below\nSHARE", pg],
      // A number ends at a letter, so no word boundary precedes the keyword.
      ["SELECT * FROM t WHERE a = 1FOR SHARE", pg],
    ] as const) {
      expect(approvableRead(sql, dialect), sql).toBe(false);
    }
  });

  // Accepted cost, on statements no parser read: a ';' or a keyword is taken as written,
  // even inside a comment or a string.
  it("over-blocks unparsed text rather than guess where its strings and comments end", () => {
    const unparsed = "SELECT a FROM t PARTITION (p0)";
    for (const [sql, expected] of [
      [`${unparsed} -- see a; b`, { class: "destructive", parseOk: false, blocked: true }],
      [`${unparsed}; -- end`, { class: "destructive", parseOk: false, blocked: true }],
      [`${unparsed};;`, { class: "destructive", parseOk: false, blocked: true }],
      [`${unparsed} -- update later`, { class: "destructive", parseOk: false, blocked: false }],
      [
        "SELECT '-- update later' FROM t PARTITION (p0)",
        { class: "destructive", parseOk: false, blocked: false },
      ],
      [`${unparsed} -- end`, { class: "read", parseOk: false, blocked: false }],
      [`${unparsed};`, { class: "read", parseOk: false, blocked: false }],
    ] as const) {
      expect(classifyQuery(sql, "mysql"), sql).toEqual(expected);
    }
  });

  it("never lets a string or a version number hide a write in an executable comment", () => {
    for (const [sql, dialect] of [
      ["SELECT '/*', 1 /*! INTO OUTFILE '/tmp/x' */", "mysql"],
      ["SELECT '-- ' /*!40000 INTO OUTFILE '/tmp/x' */", "mysql"],
      ["SELECT * FROM t /*M! INTO OUTFILE '/tmp/x' */", "mariadb"],
      ["SELECT 1 /*!50000INTO OUTFILE '/tmp/x'*/", "mysql"],
      ["SELECT 1 /*M!100000INTO OUTFILE '/tmp/x'*/", "mariadb"],
      // A '--' or '/*' in the string must not blank the body the version is glued to.
      ["SELECT '-- ' /*!50000INTO OUTFILE '/tmp/x'*/", "mysql"],
      ["SELECT '/*' /*M!100000INTO OUTFILE '/tmp/x'*/", "mariadb"],
      ["SELECT 1 /*!50000,1.5INTO OUTFILE '/tmp/x'*/", "mysql"],
    ] as const) {
      expect(classifyQuery(sql, dialect), sql).toEqual({
        class: "destructive",
        parseOk: true,
        blocked: false,
      });
    }
  });

  // The parser drops the executable body, so its `;` went unseen: SET, PREPARE and EXECUTE are
  // no modifying keyword, and the hex below is DROP TABLE t.
  it("blocks a second statement inside a MySQL or MariaDB executable comment", () => {
    const body = "; SET @q = 0x44524F50205441424C452074; PREPARE s FROM @q; EXECUTE s -- ";
    for (const [sql, dialect] of [
      [`SELECT 1 /*!${body}*/`, "mysql"],
      [`SELECT 1 /*M!${body}*/`, "mariadb"],
    ] as const) {
      expect(classifyQuery(sql, dialect).blocked, sql).toBe(true);
    }
    const hint = classifyQuery("SELECT /*!40001 SQL_NO_CACHE */ * FROM t;", "mysql");
    expect(hint).toEqual({ class: "read", parseOk: true, blocked: false });
  });

  // Every render of the queue classifies each row; a comment-blanking scan that restarted at
  // each unclosed `/*` took about a second on 100k characters, the submission cap.
  it("classifies adversarial comment openers in linear time", () => {
    for (const [sql, dialect] of [
      [`SELECT '--${"/*a".repeat(33_000)}'`, "mysql"],
      [`SELECT 1 FROM t PARTITION (p0) ${"/* ".repeat(33_000)}`, "mysql"],
    ] as const) {
      const start = performance.now();
      classifyQuery(sql, dialect);
      expect(performance.now() - start, `${sql.length} chars`).toBeLessThan(300);
    }
  });

  // SECURITY: node-sql-parser ends a -- comment at a lone CR, MySQL and SQLite at the LF: it
  // reads a string where the engine runs DROP TABLE. It also reads MySQL's --1 as a comment.
  it("never trusts a parse where a lone CR or MySQL's --x moves a comment's end", () => {
    const unread = { class: "destructive", parseOk: false, blocked: false };
    for (const [sql, dialect] of [
      ["-- x\rSELECT 'a\nDROP TABLE t -- '", "mysql"],
      ["-- x\rSELECT 'a\nDROP TABLE t -- '", "mariadb"],
      ["-- x\rSELECT 'a\nDROP TABLE t -- '", "sqlite"],
      ["-- x\rSELECT 'a\nDROP TABLE t -- '", "redshift"],
      ["# x\rSELECT 'a\nDROP TABLE t -- '", "mysql"],
      ["SELECT 1 -- x\r, 'a\nINTO OUTFILE '/tmp/x' -- '", "mysql"],
      ["EXPLAIN -- x\rSELECT 'a\nDROP TABLE t -- '", "sqlite"],
      ["SELECT 1--1 INTO OUTFILE '/tmp/x'", "mysql"],
      ["SELECT 1--1 INTO OUTFILE '/tmp/x'", "mariadb"],
      ["SELECT 1--\u00a0INTO OUTFILE '/tmp/x'", "mysql"],
    ] as const) {
      expect(classifyQuery(sql, dialect), sql).toEqual(unread);
    }
    for (const [sql, dialect] of [
      ["-- x\rSELECT 'a\n; DROP TABLE t -- '", "sqlite"],
      ["SELECT 1--1; DROP TABLE t", "mysql"],
    ] as const) {
      expect(classifyQuery(sql, dialect), sql).toEqual({ ...unread, blocked: true });
    }
    // A CRLF ends the comment in every engine, and --x is a comment outside MySQL.
    expect(classifyQuery("-- x\r\nSELECT 'a\nDROP TABLE t -- '", "sqlite").class).toBe("read");
    expect(classifyQuery("SELECT 1 --x", "sqlite").class).toBe("read");
  });

  // SECURITY: a SQL Server batch needs no `;` between statements, and T-SQL has no backslash
  // escape, which node-sql-parser's grammar assumes: it read a string where DROP TABLE runs.
  it("never reads a SQL Server batch the text check cannot split", () => {
    for (const sql of [
      "SELECT 1 SELECT 2",
      "SELECT * FROM t EXEC xp_cmdshell 'whoami'",
      "SELECT 1 KILL 52",
    ]) {
      expect(classifyQuery(sql, "transactsql"), sql).toEqual({
        class: "destructive",
        parseOk: false,
        blocked: false,
      });
    }
    // node-sql-parser parses these as reads, taking the second word for an alias.
    for (const sql of [
      "SELECT '\\' DROP TABLE t -- '",
      "SELECT 1 SHUTDOWN",
      "SELECT 1SHUTDOWN",
      "SELECT TOP 1SHUTDOWN",
      "SELECT 0xSHUTDOWN",
      "SELECT * FROM t RECONFIGURE",
      "SELECT * FROM t CHECKPOINT",
      "SELECT 1 SETUSER",
      // It also takes NBSP and the C1 controls for identifier characters.
      "SELECT name FROM users u\u00a0DELETE\u00a0FROM\u00a0users",
    ]) {
      expect(classifyQuery(sql, "transactsql"), sql).toEqual({
        class: "destructive",
        parseOk: false,
        blocked: false,
      });
    }
    // No EXPLAIN in SQL Server: it calls a procedure of that name and runs the rest.
    for (const sql of ["EXPLAIN DROP TABLE t", "EXPLAIN SELECT 1 SELECT 2"]) {
      expect(approvableRead(sql, "transactsql"), sql).toBe(false);
    }
    // The parser still splits a batch the guard distrusts; its count keeps the block.
    const nbspBatch = "DELETE t\nDELETE u /*\u00a0*/";
    for (const sql of [
      "BEGIN TRAN DELETE FROM t COMMIT",
      nbspBatch,
      // Behind an EXPLAIN, which SQL Server does not have, the batch still splits.
      "EXPLAIN DELETE t DELETE u",
      "EXPLAIN KILL 51 KILL 52",
      "EXPLAIN BEGIN TRAN DELETE FROM t COMMIT",
    ]) {
      expect(classifyQuery(sql, "transactsql").blocked, sql).toBe(true);
    }
    expect(classifyQuery("SELECT name FROM t WHERE id = 1", "transactsql").class).toBe("read");
  });
});

describe("rank", () => {
  it("orders read < write < destructive", () => {
    expect(rank("read")).toBeLessThan(rank("write"));
    expect(rank("write")).toBeLessThan(rank("destructive"));
  });
});
