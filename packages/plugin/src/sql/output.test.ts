import { describe, expect, it } from "vitest";
import { analyzeOutput, textSchema } from "./output";
import { recordedSensitivity } from "./schema";

type Live = Record<string, string[]> | null;
// [dialect, sql, live columns by table (null: SQL text alone), names, complete]; null names: no parse.
type Case = [string, string, Live, string[] | null, boolean | null];

const lookup = (live: Live) =>
  live
    ? (ref: { schema: string | null; name: string }) =>
        live[ref.schema ? `${ref.schema}.${ref.name}` : ref.name] ?? null
    : undefined;

function check(cases: Case[]): void {
  for (const [dialect, sql, live, names, complete] of cases) {
    const out = analyzeOutput(sql, dialect, lookup(live));
    if (names === null) {
      expect(out, sql).toBeNull();
      continue;
    }
    expect(out, sql).not.toBeNull();
    expect(new Set(out?.names), sql).toEqual(new Set(names));
    expect(out?.complete, sql).toBe(complete);
  }
}

describe("analyzeOutput", () => {
  it("leaves out what the statement only filters, joins, groups or orders on", () => {
    check([
      [
        "postgresql",
        "SELECT id FROM crm.people WHERE profile->>'email' IS NOT NULL",
        null,
        ["id"],
        true,
      ],
      ["postgresql", "SELECT id FROM t WHERE note = 'john@doe.com'", null, ["id"], true],
      [
        "postgresql",
        "SELECT p.id FROM people p JOIN contacts c ON c.email = p.email",
        null,
        ["id"],
        true,
      ],
      ["postgresql", "SELECT p.id FROM people p JOIN contacts c USING (email)", null, ["id"], true],
      ["postgresql", "SELECT id FROM people GROUP BY id, email", null, ["id"], true],
      [
        "postgresql",
        "SELECT id FROM people GROUP BY id HAVING min(email) IS NOT NULL",
        null,
        ["id"],
        true,
      ],
      ["postgresql", "SELECT id FROM people ORDER BY email LIMIT 5 OFFSET 2", null, ["id"], true],
    ]);
  });

  it("returns no content for a predicate, a count, a window's partition or an aggregate's filter", () => {
    check([
      [
        "postgresql",
        "SELECT row_number() OVER (PARTITION BY email ORDER BY phone) AS n FROM people",
        null,
        ["n"],
        true,
      ],
      [
        "postgresql",
        "SELECT min(id) FILTER (WHERE email IS NOT NULL) AS v FROM people",
        null,
        ["id", "v"],
        true,
      ],
      [
        "postgresql",
        "SELECT string_agg(id::text, ',' ORDER BY email) AS ids FROM people",
        null,
        ["id", "ids"],
        true,
      ],
      ["postgresql", "SELECT email IS NOT NULL FROM people", null, [], true],
      [
        "postgresql",
        "SELECT email = 'known@example.invalid' AS matches FROM people",
        null,
        ["matches"],
        true,
      ],
      // The label the agent sees still reads as personal, so it is a name like any other.
      [
        "postgresql",
        "SELECT email IS NOT NULL AS has_email FROM people",
        null,
        ["has_email"],
        true,
      ],
      [
        "postgresql",
        "SELECT NOT (email = 'known@example.invalid') AS ok FROM people",
        null,
        ["ok"],
        true,
      ],
      [
        "postgresql",
        "SELECT email IS NOT NULL AND phone IS NOT NULL AS ok FROM people",
        null,
        ["ok"],
        true,
      ],
      [
        "postgresql",
        "SELECT EXISTS (SELECT email FROM people WHERE phone IS NOT NULL) AS present",
        null,
        ["present"],
        true,
      ],
      ["postgresql", "SELECT count(email) AS n FROM people", null, ["n"], true],
      ["postgresql", "SELECT count(DISTINCT email) AS n FROM people", null, ["n"], true],
      [
        "postgresql",
        "SELECT CASE WHEN email IS NOT NULL THEN id ELSE 0 END AS v FROM people",
        null,
        ["id", "v"],
        true,
      ],
      [
        "postgresql",
        "SELECT CASE email WHEN 'known@example.invalid' THEN id ELSE 0 END AS v FROM people",
        null,
        ["id", "v"],
        true,
      ],
    ]);
  });

  it("returns nothing for a write without RETURNING or a SELECT that stores its rows", () => {
    check([
      [
        "postgresql",
        "UPDATE people SET email = 'known@example.invalid' WHERE phone = '123'",
        null,
        [],
        true,
      ],
      ["postgresql", "INSERT INTO people (email) VALUES ('known@example.invalid')", null, [], true],
      ["postgresql", "INSERT INTO archive (email) SELECT email FROM people", null, [], true],
      ["mysql", "REPLACE INTO people (email) VALUES ('known@example.invalid')", null, [], true],
      ["postgresql", "SELECT email INTO staging_copy FROM people", null, [], true],
      ["mysql", "SELECT email INTO OUTFILE '/tmp/people.csv' FROM people", null, [], true],
      ["mysql", "SELECT email INTO @handle FROM people", null, [], true],
      ["postgresql", "CREATE TABLE staging_copy AS SELECT email FROM people", null, [], true],
      ["postgresql", "CREATE VIEW people_v AS SELECT email FROM people", null, [], true],
      ["postgresql", "DELETE FROM people WHERE email IS NOT NULL", null, [], true],
    ]);
  });

  it("traces what the projection returns to its labels and sources", () => {
    check([
      ["postgresql", "SELECT id, email FROM people", null, ["id", "email"], true],
      ["postgresql", "SELECT p.email, p.phone FROM crm.people p", null, ["email", "phone"], true],
      [
        "postgresql",
        "SELECT email AS contact, name AS company_name FROM people",
        null,
        ["email", "contact", "name", "company_name"],
        true,
      ],
      [
        "postgresql",
        'SELECT p."Email" AS "Contact Email" FROM crm.people p',
        null,
        ["Email", "Contact Email"],
        true,
      ],
      ["postgresql", "SELECT min(email) AS v FROM people", null, ["email", "v"], true],
      ["postgresql", "SELECT lower(email) AS v FROM people", null, ["email", "v"], true],
      [
        "postgresql",
        "SELECT email || ':' || phone AS v FROM people",
        null,
        ["email", "phone", "v"],
        true,
      ],
      [
        "postgresql",
        "SELECT CASE WHEN id > 0 THEN email ELSE phone END AS v FROM people",
        null,
        ["email", "phone", "v"],
        true,
      ],
      [
        "postgresql",
        "SELECT (SELECT c.email FROM contacts c WHERE c.phone = p.phone) AS contact FROM people p",
        null,
        ["email", "contact"],
        true,
      ],
      [
        "postgresql",
        "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY salary) AS v FROM people",
        null,
        ["salary", "v"],
        true,
      ],
      [
        "postgresql",
        "SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY salary) AS v FROM people",
        null,
        ["salary", "v"],
        true,
      ],
      [
        "postgresql",
        "SELECT lag(email) OVER (ORDER BY id) AS previous FROM people",
        null,
        ["email", "previous"],
        true,
      ],
      ["postgresql", "SELECT 'known@example.invalid' AS email FROM people", null, ["email"], true],
    ]);
  });

  it("reads the keys a returned JSON accessor takes, in every dialect", () => {
    check([
      [
        "postgresql",
        "SELECT profile->>'email' AS e FROM people",
        null,
        ["profile", "email", "e"],
        true,
      ],
      [
        "postgresql",
        "SELECT profile#>>'{contact,email}' AS e FROM people",
        null,
        ["profile", "contact", "email", "e"],
        true,
      ],
      [
        "postgresql",
        "SELECT jsonb_extract_path_text(profile, 'email') AS e FROM people",
        null,
        ["profile", "email", "e"],
        true,
      ],
      [
        "mysql",
        "SELECT profile->>'$.email' AS e FROM people",
        null,
        ["profile", "email", "e"],
        true,
      ],
      [
        "mysql",
        "SELECT JSON_EXTRACT(profile, '$.email') AS e FROM people",
        null,
        ["profile", "email", "e"],
        true,
      ],
      [
        "sqlite",
        "SELECT json_extract(profile, '$.email') AS e FROM people",
        null,
        ["profile", "email", "e"],
        true,
      ],
      [
        "transactsql",
        "SELECT JSON_VALUE(profile, '$.email') AS e FROM people",
        null,
        ["profile", "email", "e"],
        true,
      ],
      [
        "bigquery",
        "SELECT JSON_EXTRACT_SCALAR(profile, '$.email') AS e FROM people",
        null,
        ["profile", "email", "e"],
        true,
      ],
      ["postgresql", "SELECT profile['email'] FROM crm.people", null, ["profile", "email"], true],
      [
        "snowflake",
        "SELECT profile['contact']['email'] FROM crm.people",
        null,
        ["profile", "contact", "email"],
        true,
      ],
    ]);
  });

  it("returns every value a JSON constructor or modifier puts in the document it builds", () => {
    check([
      [
        "postgresql",
        "SELECT json_build_object('contact', email) AS payload FROM people",
        null,
        ["email", "payload"],
        true,
      ],
      [
        "postgresql",
        "SELECT json_build_array(id, email) AS payload FROM people",
        null,
        ["id", "email", "payload"],
        true,
      ],
      [
        "mysql",
        "SELECT JSON_OBJECT('contact', email) AS payload FROM people",
        null,
        ["email", "payload"],
        true,
      ],
      [
        "sqlite",
        "SELECT json_object('contact', email) AS payload FROM people",
        null,
        ["email", "payload"],
        true,
      ],
      [
        "transactsql",
        "SELECT JSON_MODIFY(profile, '$.contact', email) AS payload FROM people",
        null,
        ["profile", "contact", "email", "payload"],
        true,
      ],
      [
        "mysql",
        "SELECT JSON_SET(profile, '$.contact', email) AS payload FROM people",
        null,
        ["profile", "contact", "email", "payload"],
        true,
      ],
      [
        "postgresql",
        "SELECT string_agg(id::text, email) AS v FROM people",
        null,
        ["id", "email", "v"],
        true,
      ],
    ]);
  });

  it("keeps quoted PostgreSQL names that differ only by case apart", () => {
    check([
      [
        "postgresql",
        'SELECT s."value" FROM (SELECT id AS "Value", email AS "value" FROM people) s',
        null,
        ["email", "value"],
        true,
      ],
      [
        "postgresql",
        'SELECT "x".v FROM (SELECT id AS v FROM a) AS "X" CROSS JOIN (SELECT email AS v FROM b) AS "x"',
        null,
        ["email", "v"],
        true,
      ],
      [
        "postgresql",
        'WITH "X" AS (SELECT email AS v FROM people), "x" AS (SELECT id AS v FROM people) SELECT v FROM "X"',
        null,
        ["email", "v"],
        true,
      ],
    ]);
  });

  it("follows the name PostgreSQL gives an unaliased expression, else stays unknown", () => {
    check([
      [
        "postgresql",
        "SELECT s.lower FROM (SELECT lower(email) FROM people) s",
        null,
        ["email", "lower"],
        true,
      ],
      [
        "postgresql",
        "WITH x AS (SELECT min(email) FROM people) SELECT min FROM x",
        null,
        ["email", "min"],
        true,
      ],
      [
        "postgresql",
        "SELECT s.email FROM (SELECT email::text FROM people) s",
        null,
        ["email"],
        true,
      ],
      // A quoted function keeps its case in the name PostgreSQL gives its result.
      [
        "postgresql",
        'SELECT s."F" FROM (SELECT public."F"(email) FROM people) s',
        null,
        ["email", "F"],
        true,
      ],
      // MySQL names it by its text: the reference cannot be matched, so it stays unknown.
      ["mysql", "SELECT s.v FROM (SELECT lower(email) FROM people) s", null, ["email", "v"], false],
    ]);
  });

  it("treats a quoted or qualified function named not as a function, and an interval amount as a value", () => {
    check([
      ["postgresql", 'SELECT public."not"(email) AS v FROM people', null, ["email", "v"], true],
      ["mysql", "SELECT now() + INTERVAL salary DAY AS v FROM people", null, ["salary", "v"], true],
      [
        "bigquery",
        "SELECT DATE_ADD(CURRENT_DATE(), INTERVAL salary DAY) AS v FROM people",
        null,
        ["salary", "v"],
        true,
      ],
    ]);
  });

  it("keeps every source when quoted names differ only by case outside PostgreSQL", () => {
    check([
      [
        "snowflake",
        'SELECT s."value" FROM (SELECT id AS "Value", email AS "value" FROM people) s',
        null,
        ["id", "email", "value", "Value"],
        true,
      ],
    ]);
  });

  it("returns a USING key once, holding either side's value", () => {
    check([
      [
        "postgresql",
        "SELECT k FROM (SELECT code AS k FROM firms) a FULL JOIN (SELECT email AS k FROM people) b USING (k)",
        null,
        ["code", "email", "k"],
        true,
      ],
      [
        "postgresql",
        "SELECT s.c FROM (SELECT * FROM a FULL JOIN b USING (id)) s(a, b, c)",
        { a: ["id", "code"], b: ["id", "email"] },
        ["email", "c"],
        true,
      ],
      // The keys come first, in USING order, then each side's remaining columns.
      [
        "postgresql",
        "SELECT s.b FROM (SELECT * FROM a JOIN b USING (id)) s(a, b, c)",
        { a: ["email", "id"], b: ["id", "code"] },
        ["email", "b"],
        true,
      ],
      [
        "postgresql",
        "SELECT s.c FROM (SELECT * FROM a JOIN b USING (id, code)) s(a, b, c, d)",
        { a: ["email", "code", "id"], b: ["id", "code", "phone"] },
        ["email", "c"],
        true,
      ],
      // node-sql-parser reads NATURAL as an alias, so the merged columns stay unknown.
      [
        "postgresql",
        "SELECT s.c FROM (SELECT * FROM a NATURAL JOIN b) s(a, b, c)",
        { a: ["id", "code"], b: ["id", "email"] },
        ["c", "id"],
        false,
      ],
      [
        "postgresql",
        "SELECT a.* FROM a NATURAL JOIN b",
        { a: ["id", "email"], b: ["id"] },
        ["id", "email"],
        true,
      ],
      // JOIN binds tighter than the comma: a stays first, then the joined b and c.
      [
        "postgresql",
        "SELECT s.a FROM (SELECT * FROM a, b JOIN c USING (id)) s(a, b, c, d)",
        { a: ["email"], b: ["code", "id"], c: ["id", "phone"] },
        ["email", "a"],
        true,
      ],
    ]);
  });

  it("expands a star or a whole row only over the relations it names, with live columns", () => {
    check([
      ["postgresql", "SELECT * FROM people", { people: ["id", "email"] }, ["id", "email"], true],
      [
        "postgresql",
        "SELECT * FROM people p JOIN firms f ON p.company_id = f.id",
        { people: ["id", "email", "company_id"], firms: ["id", "company_name"] },
        ["id", "email", "company_id", "company_name"],
        true,
      ],
      [
        "postgresql",
        "SELECT p.* FROM people p JOIN firms f ON p.company_id = f.id",
        { people: ["id", "email"], firms: ["id", "company_name"] },
        ["id", "email"],
        true,
      ],
      [
        "postgresql",
        "SELECT p.* FROM crm.people p",
        { "crm.people": ["id", "email"] },
        ["id", "email"],
        true,
      ],
      ["postgresql", "SELECT * FROM people", null, [], false],
      ["postgresql", "SELECT count(*) AS n FROM people", { people: ["id", "email"] }, ["n"], true],
      [
        "bigquery",
        "SELECT * EXCEPT (email) FROM people",
        { people: ["id", "email", "phone"] },
        ["id", "phone"],
        true,
      ],
      [
        "snowflake",
        "SELECT * EXCLUDE (email) FROM people",
        { people: ["id", "email", "phone"] },
        ["id", "phone"],
        true,
      ],
      [
        "postgresql",
        "SELECT p FROM people p",
        { people: ["id", "email"] },
        ["p", "id", "email"],
        true,
      ],
      ["postgresql", "SELECT p FROM people p", null, ["p"], false],
      ["postgresql", "SELECT p FROM people p", { people: ["id", "p", "email"] }, ["p"], true],
      [
        "postgresql",
        "SELECT row_to_json(p) AS record FROM people p",
        { people: ["id", "email"] },
        ["id", "email", "record"],
        true,
      ],
    ]);
  });

  it("follows CTEs, derived tables and positional renames to what the outer projection keeps", () => {
    check([
      [
        "postgresql",
        "WITH x AS (SELECT email, id FROM people) SELECT id FROM x",
        null,
        ["id"],
        true,
      ],
      [
        "postgresql",
        "WITH x AS (SELECT email AS e, id FROM people) SELECT e FROM x",
        null,
        ["email", "e"],
        true,
      ],
      [
        "postgresql",
        "WITH unused AS (SELECT email FROM people) SELECT id FROM firms",
        null,
        ["id"],
        true,
      ],
      [
        "postgresql",
        "WITH x(company_name) AS (SELECT name FROM firms) SELECT company_name FROM x",
        null,
        ["name", "company_name"],
        true,
      ],
      [
        "postgresql",
        "WITH x(a, b) AS (SELECT id, email FROM people) SELECT b FROM x",
        null,
        ["email", "b"],
        true,
      ],
      [
        "postgresql",
        "SELECT f.b FROM (SELECT id, email FROM people) f(a, b)",
        null,
        ["email", "b"],
        true,
      ],
      [
        "postgresql",
        "SELECT f.b FROM (SELECT * FROM people) f(a, b)",
        { people: ["id", "email"] },
        ["email", "b"],
        true,
      ],
      ["postgresql", "SELECT f.b FROM (SELECT * FROM people) f(a, b)", null, ["b"], false],
      [
        "postgresql",
        "SELECT f.a FROM (SELECT * FROM people) f(a, b)",
        { people: ["email", "id"] },
        ["email", "a"],
        true,
      ],
      [
        "postgresql",
        "SELECT s.e FROM (SELECT email AS e, phone FROM people) s",
        null,
        ["email", "e"],
        true,
      ],
      // A column passed through a star keeps its own name, so naming it is enough.
      ["postgresql", "SELECT s.id FROM (SELECT * FROM people) s", null, ["id"], true],
      [
        "postgresql",
        "SELECT (SELECT p.email) AS contact FROM people p",
        null,
        ["email", "contact"],
        true,
      ],
      [
        "postgresql",
        "SELECT (SELECT p.id FROM firms p) AS v FROM people p",
        null,
        ["id", "v"],
        true,
      ],
      [
        "postgresql",
        "SELECT l.e FROM people p CROSS JOIN LATERAL (SELECT p.email AS e) l",
        null,
        ["email", "e"],
        true,
      ],
      [
        "postgresql",
        "SELECT a FROM people p(a, b)",
        { people: ["email", "id"] },
        ["email", "a"],
        true,
      ],
      [
        "postgresql",
        "SELECT v.x FROM people p CROSS JOIN LATERAL (VALUES (p.email)) v(x)",
        null,
        ["email", "x"],
        true,
      ],
      [
        "postgresql",
        "WITH x AS (UPDATE billing.firms SET company_name = 'ACME' RETURNING id) SELECT * FROM x",
        null,
        ["id"],
        true,
      ],
    ]);
  });

  it("labels a set operation by its first branch and drops what EXCEPT removes", () => {
    check([
      [
        "postgresql",
        "SELECT email AS contact FROM a UNION SELECT phone AS ignored_alias FROM b",
        null,
        ["email", "phone", "contact"],
        true,
      ],
      ["postgresql", "SELECT id FROM a UNION ALL SELECT id AS email FROM b", null, ["id"], true],
      [
        "postgresql",
        "SELECT email AS contact FROM a INTERSECT SELECT phone AS ignored_alias FROM b",
        null,
        ["email", "phone", "contact"],
        true,
      ],
      ["postgresql", "SELECT id FROM a EXCEPT SELECT email FROM b", null, ["id"], true],
      [
        "postgresql",
        "SELECT id FROM a EXCEPT SELECT email FROM b UNION SELECT phone AS ignored_alias FROM c",
        null,
        ["id", "phone"],
        true,
      ],
      // INTERSECT binds tighter, so c belongs to the subtracted operand.
      [
        "postgresql",
        "SELECT id FROM a EXCEPT SELECT phone FROM b INTERSECT SELECT email FROM c",
        null,
        ["id"],
        true,
      ],
      [
        "postgresql",
        "SELECT s.contact FROM (SELECT email AS contact, id FROM a UNION ALL SELECT phone AS other, id FROM b) s",
        null,
        ["email", "phone", "contact"],
        true,
      ],
    ]);
  });

  it("returns what RETURNING names, over the write's target", () => {
    check([
      ["postgresql", "INSERT INTO people (id) VALUES (1) RETURNING email", null, ["email"], true],
      [
        "postgresql",
        "UPDATE people SET phone = '123' WHERE id = 1 RETURNING email AS contact",
        null,
        ["email", "contact"],
        true,
      ],
      [
        "postgresql",
        "DELETE FROM people WHERE phone IS NOT NULL RETURNING email",
        null,
        ["email"],
        true,
      ],
      [
        "postgresql",
        "UPDATE people SET phone = '123' RETURNING *",
        { people: ["id", "email", "phone"] },
        ["id", "email", "phone"],
        true,
      ],
      [
        "postgresql",
        "UPDATE people p SET id = 1 FROM firms f WHERE p.company_id = f.id RETURNING p.*",
        { people: ["id", "email"], firms: ["id", "company_name"] },
        ["id", "email"],
        true,
      ],
      ["sqlite", "UPDATE people SET id = 1 RETURNING email", null, ["email"], true],
      [
        "sqlite",
        "DELETE FROM people WHERE id = 1 RETURNING *",
        { people: ["id", "email"] },
        ["id", "email"],
        true,
      ],
      ["mariadb", "INSERT INTO people (id) VALUES (1) RETURNING email", null, ["email"], true],
      ["mariadb", "DELETE FROM people WHERE id = 1 RETURNING email", null, ["email"], true],
    ]);
  });

  it("marks output it cannot trace as incomplete, keeping what it could", () => {
    check([
      [
        "postgresql",
        "WITH RECURSIVE x AS (SELECT 1 UNION ALL SELECT 1 FROM x) SELECT * FROM x",
        null,
        [],
        false,
      ],
      ["mysql", "SHOW COLUMNS FROM people", null, [], false],
      ["mysql", "DESCRIBE people", null, [], false],
      ["postgresql", "CALL p(1)", null, [], false],
      // node-sql-parser reads T-SQL's OUTPUT clause as a run of variable assignments.
      [
        "transactsql",
        "INSERT INTO t (email) OUTPUT inserted.email VALUES ('known@example.invalid')",
        null,
        [],
        false,
      ],
      ["postgresql", "SELECT * FROM generate_series(1, 3)", null, ["generate_series"], false],
      [
        "postgresql",
        "SELECT p.email, f.* FROM people p, my_func() f",
        { people: ["id", "email"] },
        ["email", "f"],
        false,
      ],
      // Naming a field does not say what a function body put in it.
      ["postgresql", "SELECT f.v FROM my_func() f", null, ["v"], false],
      ["postgresql", "SELECT f.id FROM my_func() f", null, ["id"], false],
      ["postgresql", "SELECT 1 FROM (SELECT * FROM people) x", null, [], true],
      [
        "postgresql",
        "SELECT s.known_slot FROM (SELECT 1 AS known_slot, p.* FROM people p) s",
        null,
        ["known_slot"],
        true,
      ],
      [
        "postgresql",
        "SELECT id FROM people UNION ALL (SELECT email FROM contacts ORDER BY email LIMIT 1)",
        null,
        ["id", "email"],
        false,
      ],
    ]);
  });

  it("recursion moves values between columns, so a recursive CTE's output stays unknown", () => {
    check([
      [
        "postgresql",
        "WITH RECURSIVE x(a, b, n) AS (SELECT email, id, 1 FROM people UNION ALL SELECT b, a, n + 1 FROM x WHERE n < 2) SELECT b FROM x",
        null,
        ["b", "email", "a", "id", "n"],
        false,
      ],
    ]);
  });

  it("returns null when the statement does not parse", () => {
    check([
      [
        "postgresql",
        "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1 RETURNING email",
        null,
        null,
        null,
      ],
      ["postgresql", "EXPLAIN SELECT email FROM t", null, null, null],
      ["postgresql", "VALUES ('a@b.co')", null, null, null],
      [
        "postgresql",
        "WITH d AS (DELETE FROM t RETURNING email) SELECT count(*) FROM d",
        null,
        null,
        null,
      ],
    ]);
  });
});

describe("textSchema", () => {
  it("flags only what the statement returns, never what it filters on or the values it carries", () => {
    expect(
      textSchema("SELECT id FROM crm.people WHERE profile->>'email' IS NOT NULL", "postgresql"),
    ).toEqual({
      tables: ["crm.people"],
      pii: [],
      client: [],
      complete: true,
    });
    expect(textSchema("SELECT id FROM t WHERE note = 'john@doe.com'", "postgresql")).toMatchObject({
      pii: [],
      client: [],
    });
    expect(
      textSchema(
        "SELECT c.email, c.company_name FROM crm.customers c WHERE c.phone = '+33 6 12 34 56 78'",
        "postgresql",
      ),
    ).toMatchObject({ pii: ["email"], client: ["company_name"], complete: true });
  });

  it("cannot see the columns behind a star from the text alone", () => {
    expect(textSchema("SELECT * FROM crm.people", "postgresql")).toMatchObject({
      pii: [],
      complete: false,
    });
  });

  it("is null when the statement does not parse", () => {
    expect(textSchema("this is not a query at all !@#", "postgresql")).toBeNull();
  });
});

describe("recordedSensitivity", () => {
  it("records the flags of a fully traced output, never a sensitive value", () => {
    expect(recordedSensitivity({ tables: [], pii: ["email"], client: [], complete: true })).toEqual(
      {
        pii: true,
        value: false,
        client: false,
      },
    );
  });

  it("records the flags found in an output it could not fully trace, and nothing when none", () => {
    expect(
      recordedSensitivity({ tables: [], pii: ["email"], client: [], complete: false }),
    ).toEqual({ pii: true, value: false, client: false });
    expect(
      recordedSensitivity({ tables: [], pii: [], client: [], complete: false }),
    ).toBeUndefined();
    expect(
      recordedSensitivity(textSchema("SELECT * FROM crm.people", "postgresql")),
    ).toBeUndefined();
    expect(recordedSensitivity(null)).toBeUndefined();
  });
});

describe("analyzeOutput, round 1 of the cross-review", () => {
  const live = {
    people: ["id", "email", "phone"],
    orders: ["id", "total"],
    firms: ["id", "company_name"],
    "db.sch.people": ["id", "email"],
  };

  it("follows what SET or the inserted row puts in a column RETURNING hands back", () => {
    check([
      [
        "postgresql",
        "UPDATE people SET memo = email RETURNING memo",
        null,
        ["memo", "email"],
        true,
      ],
      ["sqlite", "UPDATE people SET memo = email RETURNING memo", null, ["memo", "email"], true],
      [
        "postgresql",
        "UPDATE people p SET memo = c.email FROM contacts c WHERE c.id = p.id RETURNING p.memo",
        null,
        ["memo", "email"],
        true,
      ],
      [
        "postgresql",
        "INSERT INTO archive (memo) VALUES ('x') ON CONFLICT (id) DO UPDATE SET memo = EXCLUDED.memo || archive.phone RETURNING memo",
        null,
        ["memo", "phone"],
        true,
      ],
      // A value the agent typed into the row adds nothing it did not know.
      [
        "postgresql",
        "INSERT INTO archive (memo, id) VALUES ('x', 1) RETURNING memo",
        null,
        ["memo"],
        true,
      ],
      // EXCLUDED is the row the upsert tried to insert, here an email.
      [
        "postgresql",
        "INSERT INTO archive (memo) SELECT email FROM people ON CONFLICT (id) DO UPDATE SET other = EXCLUDED.memo RETURNING other",
        { archive: ["id", "memo", "other"] },
        ["other", "memo", "email"],
        true,
      ],
      // Every SET reads the row as it was: other gets the old memo, never the new email.
      [
        "postgresql",
        "UPDATE people SET memo = email, other = memo RETURNING other",
        { people: ["id", "email", "memo", "other"] },
        ["other", "memo"],
        true,
      ],
    ]);
  });

  it("leaves a FROM item it does not model unknown instead of dropping it", () => {
    check([
      [
        "postgresql",
        "SELECT * FROM firms f JOIN (people p JOIN orders o ON o.id = p.id) ON f.id = p.id",
        live,
        ["id", "company_name", "email", "phone", "total"],
        true,
      ],
      [
        "postgresql",
        "SELECT p.* FROM firms f JOIN (people p JOIN orders o ON o.id = p.id) ON f.id = p.id",
        live,
        ["id", "email", "phone"],
        true,
      ],
      [
        "postgresql",
        "SELECT * FROM firms f, jsonb_to_recordset(f.data) AS x(email text)",
        live,
        ["id", "company_name", "email", "data"],
        false,
      ],
      [
        "snowflake",
        "SELECT * FROM firms f, LATERAL FLATTEN(input => f.data) x",
        live,
        ["id", "company_name"],
        false,
      ],
    ]);
  });

  it("reads BigQuery's ARRAY_AGG argument, three-part names and double-quoted identifiers", () => {
    check([
      ["bigquery", "SELECT ARRAY_AGG(email) AS x FROM people", null, ["email", "x"], true],
      ["snowflake", "SELECT * FROM db.sch.people", live, ["id", "email"], true],
      ["sqlite", 'SELECT "email" FROM people', null, ["email"], true],
      ["transactsql", 'SELECT "email" FROM people', null, ["email"], true],
      ["snowflake", 'SELECT "EMAIL" FROM people', null, ["EMAIL"], true],
      // MySQL and BigQuery read double quotes as a string, which the agent wrote.
      ["mysql", 'SELECT "email" FROM people', null, [], true],
    ]);
  });

  it("stops expanding stars over stars past any real table's width, and never throws", () => {
    const ctes = ["c0 AS (SELECT 1 AS a, 2 AS b)"];
    for (let i = 1; i <= 24; i++) ctes.push(`c${i} AS (SELECT * FROM c${i - 1} x, c${i - 1} y)`);
    const sql = `WITH ${ctes.join(", ")} SELECT * FROM c24`;
    expect(analyzeOutput(sql, "postgresql")).toEqual({ names: [], complete: false });
    expect(
      analyzeOutput(sql.replace("SELECT * FROM c24", "SELECT 1 FROM c24"), "postgresql"),
    ).toEqual({
      names: [],
      complete: true,
    });
  });
});

describe("analyzeOutput, round 2 of the cross-review", () => {
  it("joins a parenthesized join as one table, keeping its own column order", () => {
    check([
      [
        "postgresql",
        "SELECT s.x FROM (SELECT * FROM a JOIN (b JOIN c USING (id)) ON a.id = b.id) s(x, y, z, w)",
        { a: ["email", "id"], b: ["id", "code"], c: ["id"] },
        ["x", "email"],
        true,
      ],
      [
        "postgresql",
        "SELECT s.c FROM (SELECT * FROM p JOIN (q JOIN r USING (email)) USING (id)) s(a, b, c, d)",
        { p: ["id", "code"], q: ["id", "email"], r: ["email", "n"] },
        ["c", "email"],
        true,
      ],
      [
        "postgresql",
        "SELECT q.* FROM p JOIN (q JOIN r USING (email)) USING (id)",
        { p: ["id", "code"], q: ["id", "email"], r: ["email", "n"] },
        ["id", "email"],
        true,
      ],
    ]);
  });

  it("spreads what an unlisted star or an unplaced value may put across the columns it may reach", () => {
    check([
      [
        "postgresql",
        "INSERT INTO archive (a, b) SELECT *, email FROM people ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.b RETURNING a",
        { archive: ["id", "a", "b"] },
        ["a", "b", "email"],
        false,
      ],
      [
        "sqlite",
        "INSERT INTO archive VALUES (1, (SELECT email FROM people LIMIT 1)) RETURNING memo",
        null,
        ["memo", "email"],
        false,
      ],
      // A row of values the agent typed carries nothing it did not know.
      ["sqlite", "INSERT INTO archive VALUES (1, 'x') RETURNING memo", null, ["memo"], true],
    ]);
  });

  it("keeps an outer column a name may belong to, as a possibility only", () => {
    check([
      [
        "postgresql",
        "SELECT (SELECT x FROM t2 LIMIT 1) AS y FROM (SELECT email AS x FROM people) s",
        null,
        ["x", "email", "y"],
        false,
      ],
      [
        "postgresql",
        "SELECT (SELECT x FROM t2 LIMIT 1) AS y FROM (SELECT email AS x FROM people) s",
        { t2: ["x"] },
        ["x", "y"],
        true,
      ],
    ]);
  });

  it("reads BigQuery struct fields and subscripts", () => {
    check([
      ["bigquery", "SELECT t.user.email FROM events t", null, ["user", "email"], true],
      [
        "bigquery",
        "SELECT s.email FROM (SELECT t.user.email FROM events t) s",
        null,
        ["user", "email"],
        true,
      ],
      [
        "bigquery",
        "SELECT p.profile['email'] AS v FROM people p",
        null,
        ["profile", "email", "v"],
        true,
      ],
    ]);
  });

  it("tells RETURNING's old row from its new one, and a qualifier that names nothing from a column", () => {
    const live = { people: ["id", "email", "memo"] };
    check([
      [
        "postgresql",
        "UPDATE people SET memo = email RETURNING new.memo",
        live,
        ["memo", "email"],
        true,
      ],
      ["postgresql", "UPDATE people SET memo = email RETURNING old.memo", live, ["memo"], true],
      [
        "postgresql",
        "UPDATE people SET memo = email RETURNING *",
        live,
        ["id", "email", "memo"],
        true,
      ],
      ["postgresql", "SELECT zz.email FROM people p", null, ["email"], false],
    ]);
  });

  it("puts BigQuery's REPLACE value in the column it replaces, and only it", () => {
    check([
      [
        "bigquery",
        "SELECT aa.* REPLACE (bb.email AS note) FROM aa, bb",
        { aa: ["id", "note"], bb: ["id", "email"] },
        ["id", "note", "email"],
        true,
      ],
      [
        "bigquery",
        "SELECT s.* REPLACE (1 AS note) FROM (SELECT id, email AS note FROM people) s",
        null,
        ["id", "note"],
        true,
      ],
    ]);
  });
});

describe("analyzeOutput, keys read from a document returned whole", () => {
  const users = { users: ["id", "profile"] };

  it("adds them when the document is returned, never when only another column is", () => {
    const sql = "SELECT profile FROM users WHERE profile->>'email' IS NOT NULL";
    check([
      ["postgresql", sql, null, ["profile", "email"], true],
      ["postgresql", sql, users, ["profile", "email"], true],
      [
        "postgresql",
        "SELECT id FROM users WHERE profile->>'email' IS NOT NULL",
        users,
        ["id"],
        true,
      ],
      [
        "postgresql",
        "SELECT * FROM users WHERE profile->>'email' IS NOT NULL",
        users,
        ["id", "profile", "email"],
        true,
      ],
      [
        "postgresql",
        "SELECT * FROM users WHERE profile->>'email' IS NOT NULL",
        null,
        ["email"],
        false,
      ],
      [
        "postgresql",
        "SELECT u FROM users u WHERE u.profile->>'email' IS NOT NULL",
        users,
        ["u", "id", "profile", "email"],
        true,
      ],
      [
        "mysql",
        "SELECT profile FROM users WHERE JSON_EXTRACT(profile, '$.email') IS NOT NULL",
        null,
        ["profile", "email"],
        true,
      ],
      [
        "postgresql",
        "SELECT u.profile FROM users u JOIN contacts c ON c.mail = u.profile->>'email'",
        null,
        ["profile", "email"],
        true,
      ],
    ]);
  });

  it("adds them only from the same table's column, never another table's of the same name", () => {
    const live = { a: ["id", "profile"], b: ["id", "profile"] };
    const other =
      "SELECT a.profile FROM a JOIN b ON a.id = b.id WHERE b.profile->>'email' IS NOT NULL";
    check([
      ["postgresql", other, live, ["profile"], true],
      ["postgresql", other, null, ["profile"], true],
      [
        "postgresql",
        "SELECT a.profile FROM a JOIN b ON a.id = b.id WHERE a.profile->>'email' IS NOT NULL",
        live,
        ["profile", "email"],
        true,
      ],
      // Two rows of one table hold documents of one column.
      [
        "postgresql",
        "SELECT m.profile FROM users m JOIN users e ON e.manager_id = m.id WHERE e.profile->>'email' IS NOT NULL",
        null,
        ["profile", "email"],
        true,
      ],
    ]);
  });

  it("follows the document through an unchanged alias, never through one that rebuilds it", () => {
    check([
      [
        "postgresql",
        "SELECT x.p FROM (SELECT profile AS p FROM users) x WHERE x.p->>'email' IS NOT NULL",
        null,
        ["p", "profile", "email"],
        true,
      ],
      [
        "postgresql",
        "WITH c AS (SELECT profile FROM users WHERE profile->>'email' IS NOT NULL) SELECT profile FROM c",
        users,
        ["profile", "email"],
        true,
      ],
      [
        "postgresql",
        "SELECT profile FROM a UNION ALL SELECT profile FROM b WHERE b.profile->>'email' IS NOT NULL",
        null,
        ["profile", "email"],
        true,
      ],
      [
        "postgresql",
        "SELECT profile - 'email' AS p FROM users WHERE profile->>'email' IS NOT NULL",
        users,
        ["p", "profile"],
        true,
      ],
      [
        "postgresql",
        "SELECT v.p FROM users u CROSS JOIN LATERAL (VALUES (u.profile)) v(p) WHERE u.profile->>'email' IS NOT NULL",
        users,
        ["p", "profile", "email"],
        true,
      ],
      // A part of the document is not the document.
      [
        "postgresql",
        "SELECT profile->'contact' AS c FROM users WHERE profile->>'ssn' IS NOT NULL",
        users,
        ["c", "profile", "contact"],
        true,
      ],
    ]);
  });

  it("follows the document wrapped whole in a constructor or an aggregate", () => {
    check([
      [
        "postgresql",
        "SELECT jsonb_build_object('payload', profile) AS o FROM users WHERE profile->>'email' IS NOT NULL",
        users,
        ["o", "profile", "email"],
        true,
      ],
      [
        "postgresql",
        "SELECT jsonb_agg(profile) FROM users WHERE profile->>'email' IS NOT NULL",
        users,
        ["jsonb_agg", "profile", "email"],
        true,
      ],
    ]);
  });

  it("learns keys only from a read, never from a document the statement builds or edits", () => {
    check([
      [
        "mysql",
        "SELECT profile FROM users WHERE JSON_SET(profile, '$.note', 'email') IS NOT NULL",
        users,
        ["profile"],
        true,
      ],
      [
        "mysql",
        "SELECT profile FROM users WHERE JSON_EXTRACT(profile, '$.email') IS NOT NULL",
        users,
        ["profile", "email"],
        true,
      ],
    ]);
  });

  it("returns what a write put in a column, read against the row as it was", () => {
    const live = { users: ["id", "profile", "backup"] };
    const removed =
      "UPDATE users SET profile = profile - 'email' WHERE profile->>'email' IS NOT NULL";
    const copied = "UPDATE users SET profile = backup WHERE profile->>'email' IS NOT NULL";
    check([
      ["postgresql", `${removed} RETURNING profile`, live, ["profile"], true],
      ["postgresql", `${removed} RETURNING new.profile`, live, ["profile"], true],
      ["postgresql", `${removed} RETURNING old.profile`, live, ["profile", "email"], true],
      ["postgresql", `${copied} RETURNING backup`, live, ["backup"], true],
      ["postgresql", `${copied} RETURNING profile`, live, ["profile", "backup"], true],
      [
        "postgresql",
        "INSERT INTO archive (memo) SELECT profile FROM users WHERE profile->>'email' IS NOT NULL ON CONFLICT (id) DO UPDATE SET other = EXCLUDED.memo RETURNING other",
        { archive: ["id", "memo", "other"], users: ["id", "profile"] },
        ["other", "memo", "profile", "email"],
        true,
      ],
    ]);
  });

  it("keeps a key whose column cannot be told apart, as untraced", () => {
    check([
      [
        "postgresql",
        "SELECT a.profile FROM a JOIN b ON a.id = b.id WHERE profile->>'email' IS NOT NULL",
        null,
        ["profile", "email"],
        false,
      ],
    ]);
  });
});

describe("analyzeOutput, round 3 of the cross-review", () => {
  const users = { users: ["id", "profile"] };
  const where = "WHERE profile->>'email' IS NOT NULL";

  it("reads BigQuery's bracket array literal", () => {
    check([
      [
        "bigquery",
        "SELECT id, [email, phone] AS c FROM users",
        null,
        ["id", "c", "email", "phone"],
        true,
      ],
    ]);
  });

  it("finds the document a key is read from through what hands it back whole", () => {
    check([
      [
        "postgresql",
        "SELECT profile FROM users WHERE coalesce(profile, '{}'::jsonb)->>'email' IS NOT NULL",
        users,
        ["profile", "email"],
        true,
      ],
      [
        "postgresql",
        "SELECT profile FROM users WHERE (CASE WHEN id > 0 THEN profile ELSE '{}'::jsonb END)->>'email' IS NOT NULL",
        users,
        ["profile", "email"],
        true,
      ],
      // Either column may hold the key.
      [
        "postgresql",
        "SELECT profile FROM users WHERE coalesce(profile, backup)->>'email' IS NOT NULL",
        { users: ["id", "profile", "backup"] },
        ["profile", "email"],
        false,
      ],
      [
        "postgresql",
        "SELECT u.profile FROM users u, jsonb_to_record(u.profile) AS r(email text)",
        users,
        ["profile", "email"],
        true,
      ],
    ]);
  });

  it("tells a function that wraps a document from one that reads or edits a path", () => {
    check([
      [
        "postgresql",
        `SELECT jsonb_build_array(profile, 'marker') AS a FROM users ${where}`,
        users,
        ["a", "profile", "marker", "email"],
        true,
      ],
      [
        "mysql",
        "SELECT JSON_ARRAY(profile, 'marker') FROM users WHERE JSON_EXTRACT(profile, '$.email') IS NOT NULL",
        users,
        ["profile", "marker", "email"],
        true,
      ],
      [
        "postgresql",
        `SELECT jsonb_extract_path(profile, k.name) AS v FROM users, keys k ${where}`,
        { ...users, keys: ["name"] },
        ["v", "profile", "name"],
        true,
      ],
      [
        "postgresql",
        "SELECT jsonb_extract_path(profile, 'contact') AS c FROM users WHERE profile->>'ssn' IS NOT NULL",
        users,
        ["c", "profile", "contact"],
        true,
      ],
    ]);
  });

  it("keeps a key whose document cannot be pinned, as untraced", () => {
    check([
      [
        "postgresql",
        `SELECT u.id, u.profile FROM users u, generate_series(1, 3) g ${where}`,
        null,
        ["id", "profile", "email"],
        false,
      ],
      [
        "postgresql",
        "SELECT u.profile FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND profile->>'email' LIKE '%@acme.com')",
        null,
        ["profile", "email"],
        false,
      ],
      [
        "postgresql",
        "SELECT (SELECT profile FROM orders LIMIT 1) AS p FROM users u WHERE u.profile->>'email' IS NOT NULL",
        null,
        ["p", "profile", "email"],
        false,
      ],
      // Nothing was read from either candidate: the name alone is known.
      [
        "postgresql",
        "SELECT (SELECT name FROM orders o WHERE o.user_id = u.id LIMIT 1) AS n FROM users u",
        null,
        ["n", "name"],
        true,
      ],
    ]);
  });

  it("counts one table column once, and keeps an INSERT's rows away from its target", () => {
    check([
      [
        "postgresql",
        "DELETE FROM sessions WHERE data->>'user' = '42' RETURNING id, data",
        null,
        ["id", "data", "user"],
        true,
      ],
      [
        "postgresql",
        "INSERT INTO users (id, profile) SELECT id, profile FROM staging ON CONFLICT (id) DO NOTHING RETURNING profile",
        users,
        ["profile"],
        true,
      ],
    ]);
  });

  it("follows writes alike with and without the target's columns", () => {
    const live = { users: ["id", "profile", "memo"], staging: ["id", "profile"] };
    const upsert = "INSERT INTO users (id, profile) SELECT id, profile FROM staging";
    const rows = ["(SELECT profile FROM users WHERE profile->>'ssn' = '1' LIMIT 1)", "('x')"];
    const both = (sql: string, names: string[]): Case[] => [
      ["postgresql", sql, live, names, true],
      ["postgresql", sql, null, names, true],
    ];
    check([
      ...both(
        `${upsert} ON CONFLICT (id) DO UPDATE SET memo = EXCLUDED.profile->>'ssn' RETURNING profile`,
        ["profile", "ssn"],
      ),
      ...both(
        `${upsert} WHERE staging.profile->>'ssn' IS NOT NULL ON CONFLICT (id) DO UPDATE SET profile = '{}' RETURNING profile`,
        ["profile", "ssn"],
      ),
      // The conflicting row keeps its old profile, read for ssn.
      ...both(
        "INSERT INTO users (id, profile) VALUES (1, '{}') ON CONFLICT (id) DO UPDATE SET memo = 'seen' WHERE users.profile->>'ssn' IS NULL RETURNING profile",
        ["profile", "ssn"],
      ),
      // Replaced on conflict, inserted otherwise: the old profile is never returned.
      ...both(
        "INSERT INTO users (id, profile) VALUES (1, '{}') ON CONFLICT (id) DO UPDATE SET profile = '{}' WHERE users.profile->>'ssn' IS NULL RETURNING profile",
        ["profile"],
      ),
      ...both(`INSERT INTO archive (memo) VALUES ${rows.join(", ")} RETURNING memo`, [
        "memo",
        "profile",
        "ssn",
      ]),
      ...both(
        `INSERT INTO archive (memo) VALUES ${[...rows].reverse().join(", ")} RETURNING memo`,
        ["memo", "profile", "ssn"],
      ),
    ]);
  });

  it("reads Snowflake and BigQuery fields hung on a column", () => {
    check([
      ["snowflake", "SELECT profile:email AS e FROM users", null, ["e", "profile", "email"], true],
      [
        "snowflake",
        "SELECT id, profile FROM users WHERE profile:email IS NOT NULL",
        null,
        ["id", "profile", "email"],
        true,
      ],
      [
        "bigquery",
        "SELECT * FROM events WHERE contact.email IS NOT NULL",
        { events: ["id", "contact"] },
        ["id", "contact", "email"],
        true,
      ],
      [
        "bigquery",
        "SELECT user.email FROM events",
        { events: ["id", "user"] },
        ["user", "email"],
        true,
      ],
      // No column of that name in reach: a misspelt qualifier, not a field.
      ["bigquery", "SELECT zz.email FROM events", { events: ["id", "user"] }, ["email"], false],
    ]);
  });

  it("learns the keys a statement tests the document for, never the values", () => {
    const sql = (test: string) => `SELECT profile FROM users WHERE ${test}`;
    check([
      ["postgresql", sql("profile ? 'ssn'"), users, ["profile", "ssn"], true],
      [
        "postgresql",
        sql("profile ?| array['ssn', 'email']"),
        users,
        ["profile", "ssn", "email"],
        true,
      ],
      [
        "postgresql",
        sql("jsonb_exists_any(profile, ARRAY['ssn'])"),
        users,
        ["profile", "ssn"],
        true,
      ],
      [
        "mysql",
        sql("JSON_CONTAINS_PATH(profile, 'one', '$.ssn')"),
        users,
        ["profile", "ssn"],
        true,
      ],
      ["postgresql", sql(`profile @> '{"ssn": "known"}'::jsonb`), users, ["profile", "ssn"], true],
      ["postgresql", sql(`profile @> '{"note": "ssn"}'::jsonb`), users, ["profile", "note"], true],
      ["postgresql", sql(`profile @> '["ssn"]'::jsonb`), users, ["profile"], true],
      ["postgresql", "SELECT profile ? 'ssn' AS has FROM users", users, ["has"], true],
    ]);
  });

  it("follows the document through CAST, CASE, aggregates, windows and scalar subqueries", () => {
    check([
      [
        "postgresql",
        `SELECT CAST(profile AS text) AS t FROM users ${where}`,
        users,
        ["t", "profile", "email"],
        true,
      ],
      [
        "postgresql",
        `SELECT CASE WHEN id > 0 THEN profile END AS c FROM users ${where}`,
        users,
        ["c", "profile", "email"],
        true,
      ],
      [
        "postgresql",
        `SELECT max(profile::text) AS m FROM users ${where}`,
        users,
        ["m", "profile", "email"],
        true,
      ],
      [
        "postgresql",
        `SELECT lag(profile) OVER (ORDER BY id) AS l FROM users ${where}`,
        users,
        ["l", "profile", "email"],
        true,
      ],
      [
        "postgresql",
        "SELECT (SELECT u2.profile FROM users u2 WHERE u2.id = u.id) AS s FROM users u WHERE u.profile->>'email' IS NOT NULL",
        users,
        ["s", "profile", "email"],
        true,
      ],
    ]);
  });

  it("resolves a deep chain of derived tables once", () => {
    let sql = "SELECT email AS x FROM people";
    for (let i = 0; i < 20; i++) sql = `SELECT x FROM (${sql}) t${i}`;
    const start = performance.now();
    check([["postgresql", sql, null, ["x", "email"], true]]);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
