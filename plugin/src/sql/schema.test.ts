import { describe, expect, it } from "vitest";
import {
  analyzeSql,
  classifyColumn,
  clientColumns,
  looksLikeClientData,
  looksLikePii,
  piiColumns,
  sensitiveLiterals,
} from "./schema";

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
});
