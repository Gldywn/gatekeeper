import { describe, expect, it } from "vitest";
import { classifyQuery } from "./classify";
import { analyzeWithFixture, type FixtureOptions } from "./pg/catalog-fixture";
import {
  planRead,
  type ReadPlan,
  readMetadataSql,
  readSearchPathSql,
  resolveRead,
  searchPathVerified,
  sensitiveReference,
} from "./read-analysis";

// Synthetic catalog rows only. These prove the local rules, not a live PostgreSQL catalog.
type Columns = Record<string, string>;
function analyze(sql: string, relations: Record<string, Columns>, options?: FixtureOptions) {
  return analyzeWithFixture(sql, relations, options);
}
function plan(sql: string): ReadPlan {
  const result = planRead(sql, "postgresql");
  expect(result, sql).not.toBeTypeOf("string");
  if (typeof result === "string") throw new Error(result);
  return result;
}
const products = { "public.products": { sku: "text", quantity: "int4", price: "numeric" } };
const deps = (snapshot: ReturnType<typeof analyze>) =>
  snapshot.input?.dependencies.map((d) => `${d.table}.${d.column}`);

describe("shared read analysis", () => {
  it("resolves membership projections with quoted dates and a withheld ID predicate", () => {
    const columns: Columns = { id: "text", user_id: "text", is_owner: "bool", status: "text" };
    for (const c of ["createdAt", "updatedAt"]) columns[c] = "timestamptz";
    const snapshot = analyze(
      `SELECT id, user_id, is_owner, status, "createdAt", "updatedAt"
      FROM treasury.account_memberships WHERE account_id = 'synthetic-account' ORDER BY "createdAt"`,
      { "treasury.account_memberships": { ...columns, account_id: "text" } },
    );
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.sql).not.toContain("synthetic-account");
    expect(snapshot.input?.dependencies.find((d) => d.column === "account_id")?.usage).toBe(
      "control",
    );
    expect(snapshot.input?.dependencies.find((d) => d.column === "createdAt")?.usage).toBe("both");
  });
  it("resolves JSON type, existence and static-path reads without sharing predicate values", () => {
    const sql = `SELECT id, jsonb_typeof(provider_metadata) AS metadata_type,
      jsonb_exists(provider_metadata, 'identificationLevels') AS has_identification_levels,
      provider_metadata #>> '{identificationLevels,PVID}' AS level_pvid,
      jsonb_typeof(provider_metadata -> 'lastIdentification') AS last_identification_type
      FROM treasury.provider_end_users WHERE id = 'synthetic-user'`;
    const relations = {
      "treasury.provider_end_users": { id: "text", provider_metadata: "jsonb" },
    };
    const snapshot = analyze(sql, relations);
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.dependencies).toContainEqual({
      schema: "treasury",
      table: "provider_end_users",
      column: "provider_metadata",
      type: "jsonb",
      usage: "output",
    });
    expect(snapshot.input?.sql).toContain("'{identificationLevels,PVID}'");
    expect(snapshot.input?.sql).toContain("'lastIdentification'");
    expect(snapshot.input?.sql).toContain("'identificationLevels'");
    expect(snapshot.input?.sql).not.toContain("synthetic-user");
    expect(snapshot.input?.withheldLiterals).toBe(true);
    const lookup = readMetadataSql(plan(sql));
    expect(lookup).toContain("E'jsonb_typeof', E'jsonb_exists'");
    expect(lookup).not.toContain("synthetic-user");
    expect(lookup).not.toContain("identificationLevels");
  });
  it("keeps JSON keys visible in predicates and nested extraction", () => {
    const snapshot = analyze(
      "SELECT metadata -> 'levels' ->> 'status' AS status FROM public.records WHERE metadata #>> '{record,id}' = 'synthetic-id'",
      { "public.records": { metadata: "jsonb" } },
    );
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.sql).toContain("'{record,id}'");
    expect(snapshot.input?.sql).not.toContain("synthetic-id");
  });
  it.each([
    "SELECT jsonb_exists(metadata, 'email') FROM public.records",
    "SELECT jsonb_typeof(metadata -> 'company_name') FROM public.records",
    "SELECT metadata #>> '{record,api_key}' AS status FROM public.records",
    "SELECT metadata ->> 'email' IS NOT NULL AS present FROM public.records",
    "SELECT id FROM public.records WHERE metadata ->> 'email' = 'alex@example.invalid'",
    "SELECT metadata ->> dynamic_key FROM public.records",
    "SELECT jsonb_typeof(reveal(metadata)) FROM public.records",
    "SELECT public.jsonb_typeof(metadata) FROM public.records",
    "SELECT jsonb_exists(metadata, dynamic_key) FROM public.records",
    "SELECT metadata #>> '{}' FROM public.records",
    "SELECT jsonb_exists(metadata, 'alex@example.invalid') FROM public.records",
    "SELECT metadata ->> 'status' FROM public.records FOR UPDATE",
    "SELECT metadata ->> 'order-ref' FROM public.records",
    "SELECT jsonb_array_length(metadata) FROM public.records",
    "SELECT length(metadata::text) FROM public.records",
    'SELECT metadata @> \'{"tier":"gold"}\' AS gold FROM public.records',
  ])("keeps sensitive, unresolved or opaque JSON expressions local: %s", (sql) => {
    expect(
      analyze(sql, { "public.records": { id: "text", metadata: "jsonb", dynamic_key: "text" } })
        .complete,
    ).toBe(false);
  });
  it.each([
    "SELECT metadata FROM public.records",
    "SELECT metadata, jsonb_typeof(metadata) FROM public.records",
    "SELECT * FROM public.records",
  ])("does not mistake inspected JSON for permission to project its whole payload: %s", (sql) => {
    expect(analyze(sql, { "public.records": { metadata: "jsonb" } }).complete).toBe(false);
  });
  it("names only the operators, functions and casts the proposal uses in its catalog query", () => {
    const query = plan(
      "SELECT quantity::numeric, lower(sku) FROM public.products WHERE quantity >= 1 AND sku LIKE 'a%'",
    );
    const lookup = readMetadataSql(query);
    expect(lookup).toContain("o.oprname = ANY (ARRAY[E'>=', E'~~']::pg_catalog.text[])");
    expect(lookup).toContain("p.proname = ANY (ARRAY[E'lower']::pg_catalog.text[])");
    expect(lookup).toContain("pg_catalog.unnest(ARRAY[E'numeric']::pg_catalog.text[])");
    expect(lookup).not.toContain("'a%'");
  });
  it.each([
    "SELECT quantity FROM public.products WHERE quantity NOT IN (1, 2)",
    "SELECT quantity FROM public.products WHERE quantity BETWEEN 1 AND 2",
    "SELECT quantity FROM public.products WHERE sku ILIKE 'synthetic%'",
    "SELECT p.quantity FROM public.products p JOIN public.rates r USING (sku)",
  ])("resolves keyword operators through the catalog: %s", (sql) => {
    expect(
      analyze(sql, { ...products, "public.rates": { sku: "text", amount: "numeric" } }).reasons,
    ).toEqual([]);
  });
  it("resolves filtered aggregates, temporal casts and a correlated absence check", () => {
    const sql = `SELECT o.source_entity_type,
      count(*) FILTER (WHERE o."createdAt" >= timestamptz '2026-01-01 00:00:00+00') AS recent,
      count(*) AS total, min(o."createdAt")::date AS oldest, max(o."createdAt")::date AS newest
      FROM public.orders o JOIN public.accounts a ON a.id = o.source_account_id
      WHERE a.provider = 'synthetic-provider' AND o.status = 'PENDING'
      AND NOT EXISTS (SELECT 1 FROM public.attempts t WHERE t.order_id = o.id)
      GROUP BY o.source_entity_type ORDER BY o.source_entity_type`;
    const relations = {
      "public.orders": {
        id: "uuid",
        source_entity_type: "text",
        createdAt: "timestamptz",
        source_account_id: "uuid",
        status: "text",
      },
      "public.accounts": { id: "uuid", provider: "text" },
      "public.attempts": { order_id: "uuid" },
    };
    const snapshot = analyze(sql, relations);
    expect(snapshot.reasons).toEqual([]);
    expect(deps(snapshot)?.sort()).toEqual(
      [
        "orders.source_entity_type",
        "orders.createdAt",
        "accounts.id",
        "orders.source_account_id",
        "accounts.provider",
        "orders.status",
        "attempts.order_id",
        "orders.id",
      ].sort(),
    );
    const shared = snapshot.input?.sql ?? "";
    expect(shared).toContain("FILTER (WHERE");
    expect(shared).toContain("NOT EXISTS");
    expect(shared).not.toContain("2026-01-01");
    expect(shared).not.toContain("synthetic-provider");
    expect(shared).not.toContain("PENDING");
    const { "public.attempts": _, ...missing } = relations;
    expect(analyze(sql, missing).complete).toBe(false);
    expect(analyze(sql, relations, { relation: { rls: true } }).complete).toBe(false);
  });
  it("resolves nearest scopes without letting an inner alias borrow an outer column", () => {
    const relations = {
      "public.orders": { quantity: "int4", order_id: "int4" },
      "public.attempts": { order_id: "int4" },
    };
    const sql =
      "SELECT o.quantity FROM public.orders o WHERE EXISTS (SELECT 1 FROM public.attempts o WHERE o.order_id = 1)";
    expect(deps(analyze(sql, relations))).toEqual(["orders.quantity", "attempts.order_id"]);
    expect(analyze(sql, { ...relations, "public.attempts": { other: "int4" } }).complete).toBe(
      false,
    );
    const bare =
      "SELECT quantity FROM public.orders WHERE EXISTS (SELECT 1 FROM public.attempts WHERE order_id = 1)";
    expect(deps(analyze(bare, relations))).toEqual(["orders.quantity", "attempts.order_id"]);
    expect(deps(analyze(bare, { ...relations, "public.attempts": { other: "int4" } }))).toEqual([
      "orders.quantity",
      "orders.order_id",
    ]);
  });
  it.each([
    "SELECT count(*) FILTER (WHERE email IS NOT NULL) FROM public.orders",
    "SELECT count(*) FILTER (WHERE quantity > 0) FROM public.orders WHERE EXISTS (SELECT 1 FROM public.attempts WHERE company_name IS NOT NULL)",
    "SELECT quantity FROM public.orders WHERE EXISTS (SELECT 1 FROM public.attempts WHERE value = 'alex@example.invalid')",
    "SELECT min(birth_date)::date FROM public.orders",
    "SELECT quantity FROM public.orders WHERE EXISTS (SELECT reveal(quantity) FROM public.attempts)",
    "SELECT quantity FROM public.orders WHERE EXISTS (SELECT 1 FROM public.attempts FOR UPDATE)",
    "SELECT quantity FROM public.orders WHERE EXISTS (WITH changed AS (DELETE FROM public.attempts RETURNING *) SELECT 1 FROM changed)",
    "SELECT min(quantity)::custom_type FROM public.orders",
    'SELECT min(quantity)::"DATE" FROM public.orders',
    "SELECT count(*) FILTER (WHERE reveal(quantity) > 0) FROM public.orders",
  ])("keeps unsafe or unresolved reporting dependencies manual: %s", (sql) =>
    expect(
      analyze(sql, {
        "public.orders": { quantity: "int4", email: "text", birth_date: "date" },
        "public.attempts": { value: "text", company_name: "text" },
      }).complete,
    ).toBe(false),
  );
  it.each([
    [
      "SELECT id, provider, \"createdAt\" FROM public.account_holders WHERE owner_id = 'synthetic-id' AND owner_type = 'company' ORDER BY \"createdAt\"",
      true,
    ],
    [
      'SELECT id, "userId", "companyId" FROM public.account_holders WHERE "companyId" = \'synthetic-id\' AND "userId" IN (\'first-id\', \'second-id\')',
      true,
    ],
    [
      "SELECT id FROM public.account_holders WHERE owner_id IN (SELECT id FROM public.account_holders WHERE owner_id = 'synthetic-id') ORDER BY \"createdAt\"",
      true,
    ],
  ])("resolves ordinary investigation reads including IN subqueries: %s", (sql, supported) => {
    expect(classifyQuery(sql as string)).toEqual({ class: "read", parseOk: true, blocked: false });
    const snapshot = analyze(sql as string, {
      "public.account_holders": {
        id: "text",
        provider: "text",
        createdAt: "timestamptz",
        owner_id: "text",
        owner_type: "text",
        userId: "text",
        companyId: "text",
      },
    });
    expect(snapshot.complete).toBe(supported);
  });
  it.each([
    "createdAt",
    "thresholdForFunds",
    "created on",
    "créé le",
    'a"b',
    "a.b",
    "a::b",
    "*",
    "a\\b",
  ])(
    "preserves the exact quoted column %s through catalog resolution and serialization",
    (column) => {
      const quoted = `"${column.replaceAll('"', '""')}"`;
      const sql = `SELECT "P".${quoted} AS "Chosen Value" FROM "Sales Space"."Products Été" AS "P" ORDER BY "Chosen Value"`;
      expect(plan(sql).relations).toEqual([{ schema: "Sales Space", table: "Products Été" }]);
      const snapshot = analyze(sql, {
        "Sales Space.Products Été": { [column]: "text", email: "text" },
      });
      expect(snapshot.reasons).toEqual([]);
      expect(snapshot.input?.dependencies).toEqual([
        { schema: "Sales Space", table: "Products Été", column, type: "text", usage: "both" },
      ]);
      expect(snapshot.input?.sql).toContain(quoted);
    },
  );
  it("does not resolve a quoted column against its lowercase sibling", () => {
    const both = { "public.products": { createdAt: "timestamp", createdat: "text" } };
    expect(
      analyze('SELECT "createdAt" FROM public.products', both).input?.dependencies[0],
    ).toMatchObject({
      column: "createdAt",
      type: "timestamp",
    });
    expect(
      analyze("SELECT CreatedAt FROM PUBLIC.PRODUCTS", both).input?.dependencies[0],
    ).toMatchObject({
      column: "createdat",
      type: "text",
    });
    expect(
      analyze('SELECT "createdAt" FROM public.products', {
        "public.products": { createdat: "text" },
      }).complete,
    ).toBe(false);
  });
  it("resolves quoted join aliases and USING names without confusing their case", () => {
    const snapshot = analyze(
      'SELECT "Left"."itemId", "Right"."unitPrice" FROM "Sales"."Products" AS "Left" JOIN "Sales"."Rates" AS "Right" USING ("itemId")',
      {
        "Sales.Products": { itemId: "int4" },
        "Sales.Rates": { itemId: "int4", unitPrice: "numeric" },
      },
    );
    expect(snapshot.reasons).toEqual([]);
    expect(deps(snapshot)?.sort()).toEqual(["Products.itemId", "Rates.itemId", "Rates.unitPrice"]);
    expect(analyze('SELECT p.quantity FROM public.products AS "P"', products).complete).toBe(false);
  });
  it.each([
    'SELECT "Email" AS "Stock" FROM "Sales"."Products"',
    'SELECT "unitPrice" AS "Company Name" FROM "Sales"."Products"',
    'SELECT "quantity" FROM public.products WHERE "E mail" IS NOT NULL',
    'SELECT "E""mail" IS NOT NULL AS "Present" FROM public.products',
  ])("keeps sensitivity checks on decoded names: %s", (sql) => {
    expect(planRead(sql, "postgresql")).toMatch(/^Sensitive source or alias:/);
  });
  it("checks decoded star fields and keeps a quoted star distinct", () => {
    const relations = {
      "public.products": { createdAt: "timestamp", "E mail": "text", "*": "int4" },
    };
    expect(analyze('SELECT "P".* FROM public.products "P"', relations).reasons).toEqual([
      "Sensitive source or alias: E mail",
    ]);
    expect(
      analyze('SELECT "*" FROM public.products', relations).input?.dependencies.map(
        (d) => d.column,
      ),
    ).toEqual(["*"]);
  });
  it("quotes arbitrary relation names as data in catalog queries", () => {
    const sql = readMetadataSql(plan('SELECT "createdAt" FROM "a\'b"."x\' OR TRUE; --"'));
    expect(sql).toContain("E'a''b'");
    expect(sql).toContain("E'x'' OR TRUE; --'");
  });
  it.each([
    "id",
    "order_item_id",
    "product_id",
    "user_id",
    "customer_id",
    "company_id",
    "orderItemId",
    "customerID",
  ])("does not classify the identifier name %s as sensitive", (name) =>
    expect(sensitiveReference(name)).toBe(false),
  );
  it("resolves IDs in projections, aliases, predicates and both sides of joins", () => {
    const snapshot = analyze(
      "SELECT p.id AS order_item_id, r.customer_id FROM public.products p JOIN public.rates r ON p.id = r.product_id WHERE r.company_id = 42 ORDER BY p.id",
      {
        "public.products": { id: "int4" },
        "public.rates": { product_id: "int4", customer_id: "int4", company_id: "int4" },
      },
    );
    expect(snapshot.reasons).toEqual([]);
    expect(deps(snapshot)?.sort()).toEqual(
      ["products.id", "rates.customer_id", "rates.product_id", "rates.company_id"].sort(),
    );
  });
  it("allows catalog-expanded IDs while keeping sensitive sources and literals local", () => {
    expect(
      analyze("SELECT * FROM public.products", {
        "public.products": { id: "int4", order_item_id: "int4" },
      }).complete,
    ).toBe(true);
    expect(
      analyze("SELECT * FROM public.products", { "public.products": { id: "int4", email: "text" } })
        .reasons,
    ).toEqual(["Sensitive source or alias: email"]);
    for (const sql of [
      "SELECT email AS order_item_id FROM public.products",
      "SELECT company_name AS company_id FROM public.products",
      "SELECT id FROM public.products WHERE email IS NOT NULL",
      "SELECT id FROM public.products WHERE sku = 'alex@example.invalid'",
    ])
      expect(planRead(sql, "postgresql"), sql).toBeTypeOf("string");
  });
  it.each(["created_at", "updated_at", "createdAt", "account_created_at", "account_status"])(
    "does not treat operational metadata %s as identifying data",
    (name) => expect(sensitiveReference(name)).toBe(false),
  );
  it("resolves operational fields without treating relation names as returned identities", () => {
    const snapshot = analyze(
      "SELECT accounts.id, accounts.created_at AS account_created_at, accounts.status, company.threshold_for_funds FROM customer_data.accounts accounts JOIN customer_data.company company ON accounts.company_id = company.id WHERE accounts.status = 'pending' ORDER BY accounts.created_at",
      {
        "customer_data.accounts": {
          id: "int4",
          created_at: "timestamp",
          status: "text",
          company_id: "int4",
          email: "text",
        },
        "customer_data.company": {
          id: "int4",
          threshold_for_funds: "numeric",
          company_name: "text",
        },
      },
    );
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.sql).not.toContain("pending");
    expect(snapshot.input?.sql).toContain("company");
  });
  it.each([
    "SELECT product_name FROM public.users",
    "SELECT product_name FROM customer_data.products",
    "SELECT COUNT(*) FROM public.users",
  ])("leaves contextual disclosure decisions to Jev: %s", (sql) => {
    const schema = sql.includes("customer_data") ? "customer_data.products" : "public.users";
    expect(analyze(sql, { [schema]: { product_name: "text", email: "text" } }).reasons).toEqual([]);
  });
  it.each([
    "SELECT email AS account_created_at FROM public.accounts",
    "SELECT status AS company_name FROM public.accounts",
    "SELECT id FROM public.accounts WHERE email IS NOT NULL",
    "SELECT email IS NOT NULL AS has_contact FROM public.accounts",
    "SELECT company_name FROM public.company",
    "SELECT birth_date FROM public.accounts",
    "SELECT api_key FROM public.accounts",
    "SELECT status FROM public.accounts WHERE code = 'alex@example.invalid'",
  ])("keeps explicit sensitive dependencies local: %s", (sql) => {
    expect(planRead(sql, "postgresql")).toMatch(/Sensitive/);
  });
  it("keeps system schemas manual", () => {
    expect(planRead("SELECT status FROM pg_catalog.accounts", "postgresql")).toBe(
      "Sensitive or system schema",
    );
  });
  it.each([
    "SELECT quantity FROM public.products WHERE quantity > 0 LIMIT 10",
    "SELECT sku FROM public.products ORDER BY price DESC LIMIT 10 OFFSET 2",
    "SELECT DISTINCT sku FROM public.products",
    "SELECT sku FROM public.products OFFSET 2",
    "SELECT SUM(quantity + 1) AS total FROM public.products",
    "SELECT sku, SUM(quantity) AS total FROM public.products GROUP BY sku HAVING SUM(quantity) > 1 ORDER BY total DESC",
    "SELECT COUNT(*) AS total FROM public.products",
    "SELECT p.* FROM public.products p",
    "SELECT * FROM public.products",
    "SELECT sku, CASE WHEN quantity > 10 THEN 'high' ELSE 'low' END AS level FROM public.products",
    "SELECT sku, row_number() OVER (PARTITION BY sku ORDER BY price DESC) AS rank FROM public.products",
    "WITH stock AS (SELECT sku, quantity FROM public.products WHERE quantity > 0) SELECT sku, quantity FROM stock",
    "SELECT d.sku FROM (SELECT sku FROM public.products) d",
    "SELECT sku, (SELECT max(price) FROM public.products) AS top FROM public.products",
    "SELECT sku, coalesce(quantity, 0) AS quantity FROM public.products",
    "SELECT date_trunc('day', now()) AS day FROM public.products",
    "SELECT sku, lower(sku) AS code FROM public.products",
    "SELECT sku FROM public.products GROUP BY 1 ORDER BY 1",
    "SELECT CURRENT_DATE AS today, sku FROM public.products",
  ])("resolves supported reads: %s", (sql) => {
    expect(analyze(sql, products)).toMatchObject({
      complete: true,
      reasons: [],
      input: { dialect: "postgresql" },
    });
  });
  it("keeps predicate dependencies and withholds literal values explicitly", () => {
    const snapshot = analyze(
      "SELECT quantity FROM public.products WHERE sku = 'private label' OR sku = 'private label'",
      products,
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.input?.withheldLiterals).toBe(true);
    expect(snapshot.input?.sql).not.toContain("private label");
    expect(snapshot.input?.sql.match(/\$1/g)).toHaveLength(2);
    expect(snapshot.input?.dependencies.map((d) => [d.column, d.usage])).toEqual([
      ["quantity", "output"],
      ["sku", "control"],
    ]);
  });
  it("resolves same-named fields to the right joined sources and expands only the selected star", () => {
    const relations = {
      ...products,
      "public.rates": { sku: "text", email: "text", amount: "numeric" },
    };
    const result = analyze(
      "SELECT p.* FROM public.products p JOIN public.rates r ON p.sku = r.sku",
      relations,
    );
    expect(result.complete).toBe(true);
    expect(result.input?.dependencies).not.toContainEqual(
      expect.objectContaining({ column: "email" }),
    );
    expect(
      analyze(
        "SELECT sku FROM public.products p JOIN public.rates r ON p.quantity = r.amount",
        relations,
      ).complete,
    ).toBe(false);
  });
  it("expands stars before sensitivity decisions and distinguishes COUNT(*)", () => {
    const secret = { "public.products": { quantity: "int4", email: "text" } };
    expect(analyze("SELECT * FROM public.products", secret).reasons).toEqual([
      "Sensitive source or alias: email",
    ]);
    expect(analyze("SELECT COUNT(*) FROM public.products", secret)).toMatchObject({
      complete: true,
      input: { dependencies: [] },
    });
  });
  it("respects GROUP BY input precedence instead of borrowing ORDER BY alias resolution", () => {
    expect(
      analyze(
        "SELECT quantity AS price FROM public.products GROUP BY price, quantity",
        products,
      ).input?.dependencies.map((d) => d.column),
    ).toEqual(["quantity", "price"]);
    expect(
      analyze(
        "SELECT quantity AS price FROM public.products ORDER BY price",
        products,
      ).input?.dependencies.map((d) => d.column),
    ).toEqual(["quantity"]);
    expect(
      analyze("SELECT quantity AS stock FROM public.products GROUP BY stock", products).complete,
    ).toBe(true);
  });
  it.each([
    "SELECT quantity FROM public.products WHERE email IS NOT NULL",
    "SELECT email IS NOT NULL AS available FROM public.products",
    "SELECT quantity FROM public.products WHERE sku = 'a@example.invalid'",
    "SELECT current_setting('role') FROM public.products",
    "SELECT current_setting('app.jwt_secret', true) FROM public.products",
    "SELECT pg_get_viewdef('v') FROM public.products",
    "SELECT harmless(quantity) FROM public.products",
    "SELECT quantity FROM public.products WHERE harmless(quantity) = 1",
    "SELECT quantity FROM public.products ORDER BY harmless(quantity)",
    "SELECT quantity::custom_type FROM public.products",
    "SELECT quantity::regclass FROM public.products",
    "SELECT quantity FROM public.products WHERE quantity OPERATOR(public.=) 1",
    "SELECT (SELECT email FROM public.users LIMIT 1) AS value FROM public.products",
    "SELECT p.quantity FROM public.products p JOIN public.rates r ON r.email = p.sku",
    "SELECT random() FROM public.products",
    "SELECT nextval('seq') FROM public.products",
    "SELECT generate_series(1, quantity) FROM public.products",
    "SELECT quantity FROM public.products WHERE quantity IS DISTINCT FROM 1",
    "SELECT CURRENT_USER, sku FROM public.products",
    "WITH RECURSIVE r AS (SELECT 1 AS n) SELECT n FROM r",
    "SELECT sku, rank() OVER w FROM public.products WINDOW w AS (ORDER BY price)",
    "SELECT sku FROM public.products, LATERAL (SELECT 1) l",
    "SELECT ARRAY[quantity] FROM public.products",
    'SELECT quantity::"int4" FROM public.products',
    "SELECT sku FROM public.products GROUP BY ROLLUP (sku)",
  ])("never mistakes unsupported or sensitive expressions for verified sources: %s", (sql) => {
    expect(
      analyze(sql, {
        ...products,
        "public.rates": { sku: "text", email: "text" },
        "public.users": { email: "text" },
      }).complete,
    ).toBe(false);
  });
  it("fails on missing metadata, hidden sources and uncertain resolution", () => {
    const sql = "SELECT SUM(quantity) FROM public.products";
    for (const relation of [{ relkind: "v" }, { relkind: "f" }, { rls: true }, { inherited: true }])
      expect(analyze(sql, products, { relation }).complete, JSON.stringify(relation)).toBe(false);
    for (const column of [
      { type: "int4", generated: "s" },
      { type: "int4", collationCore: false },
    ])
      expect(
        analyze(sql, { "public.products": { quantity: column } } as never).complete,
        JSON.stringify(column),
      ).toBe(false);
    expect(analyze(sql, products, { catalogFirst: false }).complete).toBe(false);
    expect(analyze(sql, {}).complete).toBe(false);
    const p = plan(sql);
    expect(resolveRead(p, []).complete).toBe(false);
    expect(resolveRead(p, [{ kind: "search", item: "not json" }]).complete).toBe(false);
  });
  it("verifies the search path with qualified calls before the catalog query", () => {
    expect(readSearchPathSql()).toBe(
      "SELECT pg_catalog.array_to_json(pg_catalog.current_schemas(true))::pg_catalog.text AS path",
    );
    expect(searchPathVerified([{ path: '["pg_temp_3","pg_catalog","public"]' }])).toBe(true);
    expect(searchPathVerified([{ path: '["public","pg_catalog"]' }])).toBe(false);
    expect(searchPathVerified([{ path: "{pg_catalog}" }])).toBe(false);
    expect(searchPathVerified([])).toBe(false);
  });
});
