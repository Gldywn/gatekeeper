import { describe, expect, it } from "vitest";
import {
  analyzeSql,
  analyzeTableOps,
  classifyColumn,
  clientColumns,
  looksLikeClientData,
  looksLikePii,
  piiColumns,
  sensitiveLiterals,
} from "./schema";

describe("analyzeTableOps", () => {
  const pg = "postgresql";

  it("returns no write targets for a plain read", () => {
    expect(analyzeTableOps("SELECT * FROM audit.users", pg)).toEqual({
      writes: [],
      reads: ["audit.users"],
      writeOp: null,
    });
  });

  it("splits an INSERT ... SELECT into its write target and read source", () => {
    expect(analyzeTableOps("INSERT INTO audit SELECT * FROM users", pg)).toEqual({
      writes: ["audit"],
      reads: ["users"],
      writeOp: "insert",
    });
  });

  it("reports a delete/update target as a write, and names the operation", () => {
    expect(analyzeTableOps("DELETE FROM users WHERE id = 1", pg)).toEqual({
      writes: ["users"],
      reads: [],
      writeOp: "delete",
    });
    expect(analyzeTableOps("UPDATE users SET name = 'x' WHERE id = 1", pg)).toEqual({
      writes: ["users"],
      reads: [],
      writeOp: "update",
    });
  });

  it("names the target of a SELECT ... INTO, which the table list never carries", () => {
    expect(analyzeTableOps("SELECT * INTO staging_copy FROM crm.people", pg)).toEqual({
      writes: ["staging_copy"],
      reads: ["crm.people"],
      writeOp: "create",
    });
  });

  it("names the SELECT ... INTO target when the read comes from a CTE", () => {
    expect(
      analyzeTableOps(
        "WITH recent AS (SELECT * FROM crm.people) SELECT * INTO staging_copy FROM recent",
        pg,
      ),
    ).toEqual({
      writes: ["staging_copy"],
      reads: ["crm.people", "recent"],
      writeOp: "create",
    });
  });

  it("names the target of a SELECT ... INTO in T-SQL, including a temporary table", () => {
    expect(analyzeTableOps("SELECT * INTO staging_copy FROM crm.people", "transactsql")).toEqual({
      writes: ["staging_copy"],
      reads: ["crm.people"],
      writeOp: "create",
    });
    expect(analyzeTableOps("SELECT * INTO #staging_copy FROM crm.people", "transactsql")).toEqual({
      writes: ["#staging_copy"],
      reads: ["crm.people"],
      writeOp: "create",
    });
  });

  it("names a SELECT ... INTO target carried by a later UNION branch", () => {
    expect(
      analyzeTableOps(
        "SELECT id FROM crm.people UNION SELECT id INTO staging_copy FROM billing.firms",
        pg,
      ),
    ).toEqual({
      writes: ["staging_copy"],
      reads: ["crm.people", "billing.firms"],
      writeOp: "create",
    });
  });

  it("reads a quoted SELECT ... INTO target as a table, not as a file path", () => {
    expect(analyzeTableOps('SELECT * INTO "Staging Copy" FROM crm.people', pg)).toEqual({
      writes: ["Staging Copy"],
      reads: ["crm.people"],
      writeOp: "create",
    });
  });

  it("names the file a MySQL INTO OUTFILE/DUMPFILE writes to, whatever quotes it uses", () => {
    expect(
      analyzeTableOps("SELECT id, email INTO OUTFILE '/tmp/people.csv' FROM crm.people", "mysql"),
    ).toEqual({
      writes: ["/tmp/people.csv"],
      reads: ["crm.people"],
      writeOp: "export",
    });
    expect(
      analyzeTableOps("SELECT id INTO DUMPFILE '/tmp/people.bin' FROM crm.people", "mysql"),
    ).toEqual({
      writes: ["/tmp/people.bin"],
      reads: ["crm.people"],
      writeOp: "export",
    });
    expect(
      analyzeTableOps('SELECT id INTO OUTFILE "/tmp/people.tsv" FROM crm.people', "mysql"),
    ).toEqual({
      writes: ["/tmp/people.tsv"],
      reads: ["crm.people"],
      writeOp: "export",
    });
  });

  it("does not report INTO @variable as a write target", () => {
    expect(analyzeTableOps("SELECT id INTO @handle FROM crm.people", "mysql")).toEqual({
      writes: [],
      reads: ["crm.people"],
      writeOp: null,
    });
  });

  it("names the view a CREATE VIEW defines, qualified when the SQL qualifies it", () => {
    expect(analyzeTableOps("CREATE VIEW people_v AS SELECT * FROM crm.people", pg)).toEqual({
      writes: ["people_v"],
      reads: ["crm.people"],
      writeOp: "create",
    });
    expect(
      analyzeTableOps("CREATE OR REPLACE VIEW billing.people_v AS SELECT * FROM crm.people", pg),
    ).toEqual({
      writes: ["billing.people_v"],
      reads: ["crm.people"],
      writeOp: "create",
    });
  });

  it("still reports a CREATE TABLE ... AS SELECT target exactly once", () => {
    expect(analyzeTableOps("CREATE TABLE staging_copy AS SELECT * FROM crm.people", pg)).toEqual({
      writes: ["staging_copy"],
      reads: ["crm.people"],
      writeOp: "create",
    });
  });

  it("returns null when the statement will not parse", () => {
    expect(analyzeTableOps("VACUUM", pg)).toBeNull();
  });
});

describe("looksLikePii", () => {
  it("flags person, contact, and secret columns regardless of separators", () => {
    for (const name of [
      "email",
      "customer_email",
      "phoneNumber",
      "phone",
      "home_address",
      "billing_address",
      "postal_code",
      "ssn",
      "date_of_birth",
      "first_name",
      "lastName",
      "iban",
      "password_hash",
      "api_token",
      "salary",
    ]) {
      expect(looksLikePii(name), name).toBe(true);
    }
  });

  it("does not flag ordinary columns", () => {
    for (const name of [
      "id",
      "user_id",
      "created_at",
      "amount",
      "status",
      "table_name",
      "product_name",
      "username",
    ]) {
      expect(looksLikePii(name), name).toBe(false);
    }
  });

  it("never flags identifier columns even when the name embeds a PII word", () => {
    for (const name of [
      "billingAddressId",
      "shippingAddressId",
      "address_id",
      "ADDRESS_ID",
      "order_id",
    ]) {
      expect(looksLikePii(name), name).toBe(false);
    }
  });
});

// A broad set of column names covering the personal and secret data a schema
// tends to hold: every one must be caught, and the id and generic columns around
// them must not be. Extend both lists as needed.
describe("looksLikePii across a broad column set", () => {
  it("catches the sensitive columns", () => {
    for (const name of [
      "IBAN",
      "BIC",
      "bankAccountIBAN",
      "bankAccountBIC",
      "bankAccountAddress",
      "bankAccountOwnerName",
      "ownerName",
      "cardNumber",
      "email",
      "contactEmail",
      "senderEmail",
      "targetEmail",
      "replyToEmail",
      "phone",
      "firstName",
      "lastName",
      "birthDate",
      "birthdate",
      "nationality",
      "address1",
      "address2",
      "formattedAddress",
      "zip",
      "password",
      "secret",
      "clientSecret",
      "token",
      "apiKey",
      "pin",
    ]) {
      expect(looksLikePii(name), name).toBe(true);
    }
  });

  it("leaves ids and generic columns alone", () => {
    for (const name of [
      "id",
      "userId",
      "companyId",
      "billingAddressId",
      "shippingAddressId",
      "addressId",
      "bankAccountId",
      "externalUserId",
      "cardId",
      "amount",
      "status",
      "title",
      "description",
      "slug",
      "quantity",
      "createdAt",
      "updatedAt",
      "hostname",
      "ip",
      "ipAddress",
      "ip_address",
      "ipv4",
      "client_ip",
    ]) {
      expect(looksLikePii(name), name).toBe(false);
    }
  });
});

describe("analyzeSql", () => {
  it("extracts tables and columns from a plain SELECT", () => {
    const result = analyzeSql("SELECT id, email FROM users", "postgresql");
    expect(result).not.toBeNull();
    expect(result?.tables).toEqual([{ schema: null, name: "users" }]);
    expect(result?.columns).toEqual(expect.arrayContaining(["id", "email"]));
    expect(result?.star).toBe(false);
  });

  it("marks SELECT * and returns no explicit columns", () => {
    const result = analyzeSql("SELECT * FROM customers", "postgresql");
    expect(result?.tables).toEqual([{ schema: null, name: "customers" }]);
    expect(result?.star).toBe(true);
    expect(result?.columns).toEqual([]);
  });

  it("keeps the schema qualifier of a qualified table", () => {
    const result = analyzeSql("SELECT * FROM audit.users", "postgresql");
    expect(result?.tables).toEqual([{ schema: "audit", name: "users" }]);
  });

  it("collects every table across a join", () => {
    const result = analyzeSql(
      "SELECT u.email FROM users u JOIN orders o ON o.user_id = u.id",
      "postgresql",
    );
    expect(result?.tables).toEqual(
      expect.arrayContaining([
        { schema: null, name: "users" },
        { schema: null, name: "orders" },
      ]),
    );
    expect(result?.columns).toEqual(expect.arrayContaining(["email", "user_id"]));
    expect(result?.star).toBe(false);
  });

  it("keeps output aliases apart from the source columns they rename", () => {
    const result = analyzeSql(
      'SELECT p.name AS customer_name, p."updatedAt" changed_at, p.email "Contact" FROM crm.people p',
      "postgresql",
    );
    expect(result?.columns).toEqual(["name", "updatedAt", "email"]);
    expect(result?.aliases).toEqual(["customer_name", "changed_at", "Contact"]);
  });

  it("collects aliases from a subquery, a CTE, a UNION branch, and a function call", () => {
    const cases: Array<[string, string[]]> = [
      ["SELECT name AS customer_name FROM (SELECT name FROM crm.people) s", ["customer_name"]],
      [
        "WITH x AS (SELECT name AS company_name FROM billing.firms) SELECT * FROM x",
        ["company_name"],
      ],
      ["SELECT name AS n FROM a UNION SELECT name AS company_name FROM b", ["n", "company_name"]],
      [
        "SELECT upper(name) AS company_name, count(*) AS total FROM billing.firms",
        ["company_name", "total"],
      ],
    ];
    for (const [sql, aliases] of cases) {
      expect(analyzeSql(sql, "postgresql")?.aliases, sql).toEqual(aliases);
    }
  });

  it("reads the key of a JSON accessor as an exposed name", () => {
    const cases: Array<[string, string, string[]]> = [
      ["postgresql", "SELECT profile->>'email' FROM crm.people", ["email"]],
      ["postgresql", "SELECT profile->'contact'->>'email' FROM crm.people", ["email", "contact"]],
      ["postgresql", "SELECT profile#>>'{contact,email}' FROM crm.people", ["contact", "email"]],
      ["postgresql", "SELECT profile#>'{contact}' FROM crm.people", ["contact"]],
      ["postgresql", "SELECT jsonb_extract_path_text(profile, 'email') FROM crm.people", ["email"]],
      [
        "postgresql",
        "SELECT jsonb_extract_path(profile, 'contact', 'email') FROM crm.people",
        ["contact", "email"],
      ],
      ["postgresql", "SELECT id FROM crm.people WHERE profile->>'email' IS NOT NULL", ["email"]],
      ["mysql", "SELECT profile->>'$.email' FROM people", ["email"]],
      ["mysql", "SELECT profile->'$.contact.email' FROM people", ["contact", "email"]],
      ["mysql", "SELECT JSON_EXTRACT(profile, '$.email') FROM people", ["email"]],
      ["mariadb", "SELECT JSON_EXTRACT(profile, '$.email') FROM people", ["email"]],
      ["sqlite", "SELECT json_extract(profile, '$.email') FROM people", ["email"]],
      ["transactsql", "SELECT JSON_VALUE(profile, '$.email') FROM people", ["email"]],
      ["bigquery", "SELECT JSON_EXTRACT_SCALAR(profile, '$.email') FROM people", ["email"]],
    ];
    for (const [dialect, sql, keys] of cases) {
      expect(analyzeSql(sql, dialect)?.jsonKeys, sql).toEqual(keys);
      expect(analyzeSql(sql, dialect)?.columns, sql).toEqual(expect.arrayContaining(["profile"]));
    }
  });

  it("reports no key for an array index or a plain column", () => {
    expect(analyzeSql("SELECT tags->0 FROM crm.people", "postgresql")?.jsonKeys).toEqual([]);
    expect(analyzeSql("SELECT profile->>'$' FROM people", "mysql")?.jsonKeys).toEqual([]);
    expect(analyzeSql("SELECT id, email FROM crm.people", "postgresql")?.jsonKeys).toEqual([]);
  });

  it("keeps a whole key that is not a path, dots included", () => {
    const cases: Array<[string, string[]]> = [
      ["SELECT profile->>'email.txt' FROM crm.people", ["email.txt"]],
      ["SELECT profile->>'a.email' FROM crm.people", ["a.email"]],
      [
        "SELECT jsonb_extract_path_text(profile, 'contact.email') FROM crm.people",
        ["contact.email"],
      ],
    ];
    for (const [sql, keys] of cases) {
      expect(analyzeSql(sql, "postgresql")?.jsonKeys, sql).toEqual(keys);
    }
  });

  it("reads a subscripted key and an array path operand", () => {
    const cases: Array<[string, string, string[]]> = [
      ["postgresql", "SELECT profile['email'] FROM crm.people", ["email"]],
      ["snowflake", "SELECT profile['contact']['email'] FROM crm.people", ["contact", "email"]],
      [
        "postgresql",
        "SELECT profile #> ARRAY['contact','email'] FROM crm.people",
        ["contact", "email"],
      ],
    ];
    for (const [dialect, sql, keys] of cases) {
      expect(analyzeSql(sql, dialect)?.jsonKeys, sql).toEqual(keys);
    }
  });

  it("matches a JSON function through its schema qualifier", () => {
    expect(
      analyzeSql(
        "SELECT pg_catalog.jsonb_extract_path_text(profile, 'email') FROM crm.people",
        "postgresql",
      )?.jsonKeys,
    ).toEqual(["email"]);
  });

  it("reads no key from a call that builds or parses a document", () => {
    // The document an extractor reads comes first; a leading string is a key being
    // written, not one being exposed.
    expect(
      analyzeSql("SELECT json_build_object('email', 1) FROM t", "postgresql")?.jsonKeys,
    ).toEqual([]);
    expect(
      analyzeSql('SELECT PARSE_JSON(\'{"email":"x"}\') FROM t', "snowflake")?.jsonKeys,
    ).toEqual([]);
  });

  it("collects the output aliases of a RETURNING clause", () => {
    const cases: Array<[string, string[]]> = [
      [
        "UPDATE billing.firms SET status = 'closed' RETURNING name AS contact_email",
        ["contact_email"],
      ],
      [
        "INSERT INTO billing.firms (name) VALUES ('Acme') RETURNING name AS company_name",
        ["company_name"],
      ],
      ["DELETE FROM billing.firms WHERE id = 1 RETURNING name contact_email", ["contact_email"]],
    ];
    for (const [sql, aliases] of cases) {
      expect(analyzeSql(sql, "postgresql")?.aliases, sql).toEqual(aliases);
    }
  });

  it("collects the column list a relation alias renames its columns with", () => {
    const cases: Array<[string, string[]]> = [
      [
        "SELECT * FROM (SELECT id, name FROM billing.firms) f(firm_id, company_name)",
        ["firm_id", "company_name"],
      ],
      ["SELECT * FROM billing.firms f(firm_id, company_name)", ["firm_id", "company_name"]],
      [
        "SELECT * FROM crm.people p JOIN (SELECT name FROM billing.firms) f(company_name) ON true",
        ["company_name"],
      ],
      [
        "SELECT * FROM crm.people p CROSS JOIN LATERAL unnest(p.tags) AS t(contact_email)",
        ["contact_email"],
      ],
      ["SELECT * FROM (VALUES ('a')) AS t(company_name)", ["company_name"]],
      [
        "UPDATE billing.firms f SET status = 'closed' FROM (SELECT id FROM crm.people) p(contact_email) WHERE f.id = p.id",
        ["contact_email"],
      ],
    ];
    for (const [sql, aliases] of cases) {
      expect(analyzeSql(sql, "postgresql")?.aliases, sql).toEqual(aliases);
    }
  });

  it("does not take a relation alias that renames no column for an output name", () => {
    for (const sql of [
      "SELECT name FROM billing.firms f",
      "SELECT * FROM (SELECT name FROM billing.firms) f",
      "SELECT * FROM (VALUES ('a')) AS f",
    ]) {
      expect(analyzeSql(sql, "postgresql")?.aliases, sql).toEqual([]);
    }
  });

  it("collects a table function's alias as the output column it names", () => {
    const cases: Array<[string, string, string[]]> = [
      ["SELECT * FROM unnest(ARRAY['a']) AS contact_email", "postgresql", ["contact_email"]],
      ["SELECT * FROM generate_series(1, 3) contact_email", "postgresql", ["contact_email"]],
      [
        "SELECT * FROM crm.people p CROSS JOIN LATERAL unnest(p.tags) AS contact_email",
        "postgresql",
        ["contact_email"],
      ],
      ["SELECT * FROM firms, UNNEST(tags) AS contact_email", "bigquery", ["contact_email"]],
    ];
    for (const [sql, dialect, aliases] of cases) {
      expect(analyzeSql(sql, dialect)?.aliases, sql).toEqual(aliases);
    }
  });

  it("cannot tell a quoted relation alias holding parentheses from a column list", () => {
    // The parser strips the quotes, so the alias arrives exactly like a column list. Accepted
    // as an over-report: the annotation errs toward showing a name rather than hiding one.
    expect(analyzeSql('SELECT * FROM billing.firms AS "f(email)"', "postgresql")?.aliases).toEqual([
      "email",
    ]);
  });

  it("exposes the column list a CTE renames its columns with", () => {
    // The parser folds a CTE column list into columnList, so it reaches the classifier
    // as a source column rather than an alias; assert the exposure, not the bucket.
    const parsed = analyzeSql(
      "WITH x(company_name) AS (SELECT name FROM billing.firms) SELECT * FROM x",
      "postgresql",
    );
    expect(parsed).not.toBeNull();
    expect(clientColumns(parsed as NonNullable<typeof parsed>, [])).toEqual(["company_name"]);
  });

  it("returns null when the statement cannot be parsed", () => {
    expect(analyzeSql("this is not a query at all !@#", "postgresql")).toBeNull();
  });
});

describe("piiColumns", () => {
  it("checks only referenced columns when there is no star", () => {
    const parsed = { columns: ["id", "email"], star: false };
    expect(piiColumns(parsed, ["id", "email", "phone"])).toEqual(["email"]);
  });

  it("expands to every table column under SELECT *", () => {
    const parsed = { columns: [], star: true };
    expect(piiColumns(parsed, ["id", "email", "phone", "status"])).toEqual(["email", "phone"]);
  });

  it("returns nothing when no column looks sensitive", () => {
    const parsed = { columns: ["id", "status"], star: false };
    expect(piiColumns(parsed, ["id", "status", "amount"])).toEqual([]);
  });

  it("flags an output alias that reads as personal even when its source column does not", () => {
    // "name" alone is deliberately not PII; the alias is what the result set exposes.
    const parsed = { columns: ["name"], aliases: ["contact_email"], star: false };
    expect(piiColumns(parsed, ["id", "name"])).toEqual(["contact_email"]);
  });

  it("keeps flagging the source column when its alias is innocuous", () => {
    const parsed = { columns: ["email"], aliases: ["e"], star: false };
    expect(piiColumns(parsed, ["id", "email"])).toEqual(["email"]);
  });

  it("flags a JSON key the containing column hides", () => {
    const parsed = { columns: ["profile"], jsonKeys: ["email"], star: false };
    expect(piiColumns(parsed, ["id", "profile"])).toEqual(["email"]);
  });
});

describe("looksLikeClientData", () => {
  it("flags a client company's identity and commercial terms", () => {
    for (const name of [
      "company",
      "company_name",
      "companyName",
      "organization",
      "organisation_name",
      "raison_sociale",
      "employer",
      "client_name",
      "customerName",
      "account_name",
      "headcount",
      "contract_value",
      "contractAmount",
      "siren",
      "siret",
      "vat",
      "tva",
      "rcs",
      "mrr",
      "arr",
    ]) {
      expect(looksLikeClientData(name), name).toBe(true);
    }
  });

  it("does not flag ids, generic columns, or short-token substrings", () => {
    for (const name of [
      "company_id",
      "companyId",
      "account_id",
      "id",
      "status",
      "amount",
      "price",
      "created_at",
      "private", // must not match the exact token "vat"
      "array", // must not match the exact token "arr"
      "category",
    ]) {
      expect(looksLikeClientData(name), name).toBe(false);
    }
  });
});

describe("classifyColumn", () => {
  it("labels personal PII, client data, or neither, with PII winning a tie", () => {
    expect(classifyColumn("email")).toBe("pii");
    expect(classifyColumn("company_name")).toBe("client");
    expect(classifyColumn("company_email")).toBe("pii");
    expect(classifyColumn("company_id")).toBeNull();
    expect(classifyColumn("status")).toBeNull();
    expect(classifyColumn("ip")).toBeNull();
  });
});

describe("clientColumns", () => {
  it("checks only referenced columns when there is no star", () => {
    const parsed = { columns: ["id", "company_name"], star: false };
    expect(clientColumns(parsed, ["id", "company_name", "email"])).toEqual(["company_name"]);
  });

  it("expands to every table column under SELECT *", () => {
    const parsed = { columns: [], star: true };
    expect(clientColumns(parsed, ["id", "siren", "company", "status"])).toEqual([
      "siren",
      "company",
    ]);
  });

  it("flags a JSON key the containing column hides", () => {
    const parsed = { columns: ["profile"], jsonKeys: ["company_name"], star: false };
    expect(clientColumns(parsed, ["id", "profile"])).toEqual(["company_name"]);
  });

  it("is disjoint from piiColumns: a personal column never counts as client data", () => {
    const parsed = { columns: ["email", "company"], star: false };
    expect(piiColumns(parsed, [])).toEqual(["email"]);
    expect(clientColumns(parsed, [])).toEqual(["company"]);
  });
});

describe("sensitiveLiterals", () => {
  it("flags a literal bound to a sensitive column", () => {
    expect(sensitiveLiterals("SELECT id FROM c WHERE company_name = 'ACME'", "postgresql")).toEqual(
      ["ACME"],
    );
  });

  it("flags every literal in an IN list on a sensitive column", () => {
    expect(
      sensitiveLiterals(
        "SELECT id FROM c WHERE client_name IN ('ACME', 'BETA')",
        "postgresql",
      ).sort(),
    ).toEqual(["ACME", "BETA"]);
  });

  it("flags a literal whose shape is itself PII, even on a plain column", () => {
    expect(sensitiveLiterals("SELECT id FROM t WHERE note = 'john@doe.com'", "postgresql")).toEqual(
      ["john@doe.com"],
    );
    expect(
      sensitiveLiterals("SELECT id FROM t WHERE ref = 'FR7630006000011234567890189'", "postgresql"),
    ).toEqual(["FR7630006000011234567890189"]);
  });

  it("flags a literal assigned to a sensitive column by an UPDATE", () => {
    expect(
      sensitiveLiterals(
        "UPDATE billing.firms SET company_name = 'ACME' WHERE id = 1",
        "postgresql",
      ),
    ).toEqual(["ACME"]);
    expect(
      sensitiveLiterals("UPDATE billing.firms SET \"companyName\" = 'ACME'", "postgresql"),
    ).toEqual(["ACME"]);
  });

  it("flags an inserted literal, on every VALUES row", () => {
    expect(
      sensitiveLiterals(
        "INSERT INTO billing.firms (id, company_name) VALUES (1, 'ACME'), (2, 'BETA')",
        "postgresql",
      ).sort(),
    ).toEqual(["ACME", "BETA"]);
  });

  it("flags the literals of an upsert, both inserted and updated", () => {
    expect(
      sensitiveLiterals(
        `INSERT INTO billing.firms (id, company_name) VALUES (1, 'ACME')
           ON CONFLICT (id) DO UPDATE SET company_name = 'BETA'`,
        "postgresql",
      ).sort(),
    ).toEqual(["ACME", "BETA"]);
  });

  it("reads MySQL's INSERT ... SET and ON DUPLICATE KEY UPDATE assignments", () => {
    expect(
      sensitiveLiterals("INSERT INTO firms SET id = 1, company_name = 'ACME'", "mysql"),
    ).toEqual(["ACME"]);
    expect(
      sensitiveLiterals(
        `INSERT INTO firms (id, company_name) VALUES (1, 'ACME')
           ON DUPLICATE KEY UPDATE company_name = 'BETA'`,
        "mysql",
      ).sort(),
    ).toEqual(["ACME", "BETA"]);
  });

  it("flags a written literal through REPLACE, a CTE-wrapped UPDATE, a quoted column, and a PII target", () => {
    const cases: Array<[string, string, string[]]> = [
      ["REPLACE INTO firms (id, company_name) VALUES (1, 'ACME')", "mysql", ["ACME"]],
      [
        "WITH x AS (UPDATE billing.firms SET company_name = 'ACME' RETURNING id) SELECT * FROM x",
        "postgresql",
        ["ACME"],
      ],
      [
        "INSERT INTO billing.firms (id, \"companyName\") VALUES (1, 'ACME')",
        "postgresql",
        ["ACME"],
      ],
      ["UPDATE crm.people SET phone = '0600000000' WHERE id = 1", "postgresql", ["0600000000"]],
    ];
    for (const [sql, dialect, literals] of cases) {
      expect(sensitiveLiterals(sql, dialect), sql).toEqual(literals);
    }
  });

  it("ignores a write that carries no sensitive value", () => {
    expect(
      sensitiveLiterals("UPDATE billing.firms SET status = 'active' WHERE id = 1", "postgresql"),
    ).toEqual([]);
    // INSERT ... SELECT: the projection holds source columns, never values to zip.
    expect(
      sensitiveLiterals(
        "INSERT INTO billing.firms (id, company_name) SELECT id, name FROM crm.people",
        "postgresql",
      ),
    ).toEqual([]);
  });

  it("ignores non-sensitive filters and identifier comparisons", () => {
    expect(sensitiveLiterals("SELECT id FROM t WHERE status = 'active'", "postgresql")).toEqual([]);
    expect(sensitiveLiterals("SELECT id FROM t WHERE id = 5", "postgresql")).toEqual([]);
    expect(sensitiveLiterals("SELECT id FROM t WHERE company_id = 42", "postgresql")).toEqual([]);
  });

  it("flags a literal compared to a sensitive JSON key", () => {
    expect(
      sensitiveLiterals(
        "SELECT id FROM crm.people WHERE profile->>'company_name' = 'ACME'",
        "postgresql",
      ),
    ).toEqual(["ACME"]);
    expect(
      sensitiveLiterals(
        "SELECT id FROM crm.people WHERE profile#>>'{contact,company_name}' IN ('ACME', 'BETA')",
        "postgresql",
      ).sort(),
    ).toEqual(["ACME", "BETA"]);
    expect(
      sensitiveLiterals(
        "SELECT id FROM people WHERE JSON_EXTRACT(profile, '$.company_name') = 'ACME'",
        "mysql",
      ),
    ).toEqual(["ACME"]);
  });

  it("flags a literal compared to a subscripted key", () => {
    expect(
      sensitiveLiterals(
        "SELECT id FROM crm.people WHERE profile['company_name'] = 'ACME'",
        "postgresql",
      ),
    ).toEqual(["ACME"]);
  });

  it("ignores a literal compared to a document a call builds", () => {
    expect(
      sensitiveLiterals("SELECT id FROM t WHERE json_build_object('email', 1) = 'x'", "postgresql"),
    ).toEqual([]);
  });

  it("ignores a literal compared to a JSON key that is not sensitive", () => {
    expect(
      sensitiveLiterals(
        "SELECT id FROM crm.people WHERE profile->>'status' = 'active'",
        "postgresql",
      ),
    ).toEqual([]);
  });

  it("returns nothing when the SQL will not parse", () => {
    expect(sensitiveLiterals("not a query", "postgresql")).toEqual([]);
  });
});
