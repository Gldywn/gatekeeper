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

  it("ignores non-sensitive filters and identifier comparisons", () => {
    expect(sensitiveLiterals("SELECT id FROM t WHERE status = 'active'", "postgresql")).toEqual([]);
    expect(sensitiveLiterals("SELECT id FROM t WHERE id = 5", "postgresql")).toEqual([]);
    expect(sensitiveLiterals("SELECT id FROM t WHERE company_id = 42", "postgresql")).toEqual([]);
  });

  it("returns nothing when the SQL will not parse", () => {
    expect(sensitiveLiterals("not a query", "postgresql")).toEqual([]);
  });

  it("resolves the column through a function, cast, or COALESCE wrapper", () => {
    const cases: Array<[string, string[]]> = [
      ["SELECT id FROM billing.firms WHERE lower(company_name) = 'acme'", ["acme"]],
      ["SELECT id FROM billing.firms WHERE company_name::text = 'ACME'", ["ACME"]],
      ["SELECT id FROM billing.firms WHERE CAST(company_name AS text) = 'ACME'", ["ACME"]],
      ["SELECT id FROM billing.firms WHERE COALESCE(company_name, '') = 'ACME'", ["ACME"]],
      ["SELECT id FROM billing.firms WHERE lower(trim(company_name)) = 'acme'", ["acme"]],
      ["SELECT id FROM billing.firms WHERE 'ACME' = upper(company_name)", ["ACME"]],
      ["SELECT id FROM crm.people GROUP BY id HAVING max(salary) = '90000'", ["90000"]],
    ];
    for (const [sql, literals] of cases) {
      expect(sensitiveLiterals(sql, "postgresql").sort(), sql).toEqual(literals);
    }
  });

  it("flags the literals of an IN list, a BETWEEN range, and an ANY/ALL array", () => {
    const cases: Array<[string, string[]]> = [
      [
        "SELECT id FROM billing.firms WHERE lower(company_name) IN ('acme', 'beta')",
        ["acme", "beta"],
      ],
      [
        "SELECT id FROM crm.people WHERE birth_date BETWEEN '1990-01-01' AND '1991-01-01'",
        ["1990-01-01", "1991-01-01"],
      ],
      [
        "SELECT id FROM crm.people WHERE birth_date NOT BETWEEN '1990-01-01' AND '1991-01-01'",
        ["1990-01-01", "1991-01-01"],
      ],
      [
        "SELECT id FROM billing.firms WHERE company_name = ANY(ARRAY['ACME', 'BETA'])",
        ["ACME", "BETA"],
      ],
      ["SELECT id FROM billing.firms WHERE company_name <> ALL(ARRAY['ACME'])", ["ACME"]],
    ];
    for (const [sql, literals] of cases) {
      expect(sensitiveLiterals(sql, "postgresql").sort(), sql).toEqual(literals);
    }
  });

  it("flags a literal compared with a pattern or regex operator", () => {
    for (const op of ["~", "~*", "!~", "!~*", "SIMILAR TO", "NOT SIMILAR TO", "NOT ILIKE"]) {
      const sql = `SELECT id FROM billing.firms WHERE company_name ${op} 'acme'`;
      expect(sensitiveLiterals(sql, "postgresql"), sql).toEqual(["acme"]);
    }
  });

  it("reads the value forms the parser leaves as raw text", () => {
    const cases: Array<[string, string[]]> = [
      ["SELECT id FROM billing.firms WHERE company_name = E'ACME'", ["ACME"]],
      ["SELECT id FROM billing.firms WHERE company_name = $$ACME$$", ["ACME"]],
      ["SELECT id FROM billing.firms WHERE company_name = $tag$ACME$tag$", ["ACME"]],
      ["SELECT id FROM billing.firms WHERE company_name IS DISTINCT FROM 'ACME'", ["ACME"]],
      ["SELECT id FROM crm.people WHERE note = E'jane@example.test'", ["jane@example.test"]],
    ];
    for (const [sql, literals] of cases) {
      expect(sensitiveLiterals(sql, "postgresql").sort(), sql).toEqual(literals);
    }
  });

  it("leaves a bind parameter and an IS NULL check alone", () => {
    expect(
      sensitiveLiterals("SELECT id FROM billing.firms WHERE company_name = $1", "postgresql"),
    ).toEqual([]);
    expect(
      sensitiveLiterals(
        "SELECT id FROM billing.firms WHERE company_name IS NOT NULL",
        "postgresql",
      ),
    ).toEqual([]);
  });

  it("flags a wrapped call only when one of its arguments is sensitive", () => {
    expect(
      sensitiveLiterals(
        "SELECT id FROM billing.firms WHERE concat(city, status) = 'ACME'",
        "postgresql",
      ),
    ).toEqual([]);
    expect(
      sensitiveLiterals(
        "SELECT id FROM billing.firms WHERE concat(company_name, status) = 'ACME'",
        "postgresql",
      ),
    ).toEqual(["ACME"]);
  });

  it("never reaches into a subquery for the literals of an outer comparison", () => {
    expect(
      sensitiveLiterals(
        "SELECT id FROM billing.firms WHERE company_name IN (SELECT label FROM crm.tags WHERE status = 'active')",
        "postgresql",
      ),
    ).toEqual([]);
  });
});
