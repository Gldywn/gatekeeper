import { describe, expect, it } from "vitest";
import { classifyQuery } from "../classify";
import { prepareSql } from "../identifiers";
import { planRead, readMetadataSql, resolveRead } from "../read-analysis";
import {
  ACCEPTANCE_QUERIES,
  analyzeWithFixture as analyze,
  catalogRows,
  type FixtureOptions,
} from "./catalog-fixture";

// Synthetic catalog rows only: these tests prove the local rules, not a live PostgreSQL catalog.

const { attempts: ATTEMPTS, statuses: STATUSES } = ACCEPTANCE_QUERIES;

const enums: FixtureOptions["types"] = [
  { name: "intent_status", schema: "payment_orchestrator", kind: "e" },
  { name: "attempt_status", schema: "payment_orchestrator", kind: "e" },
  { name: "method_kind", schema: "payment_orchestrator", kind: "e" },
];
function tables(status = "text", attempt = "text", kind = "text") {
  return {
    "payment_orchestrator.payment_intent": {
      id: "text",
      updatedAt: "timestamp",
      metadata: "jsonb",
      status,
    },
    "payment_orchestrator.payment_attempt": {
      id: "text",
      payment_intent_id: "text",
      payment_method_kind: kind,
      status: attempt,
      captured_amount_cents: "int8",
    },
  };
}
// Extension-like objects on unrelated types, as pgvector, PostGIS or hstore install them.
const extensions: FixtureOptions = {
  types: [
    ...(enums ?? []),
    { name: "vector" },
    { name: "geometry" },
    { name: "hstore" },
    { name: "ltree" },
  ],
  operators: [
    {
      name: "=",
      left: "vector",
      right: "vector",
      result: "bool",
      code: "vector_eq",
      schema: "public",
    },
    {
      name: "<",
      left: "vector",
      right: "vector",
      result: "bool",
      code: "vector_lt",
      schema: "public",
    },
    {
      name: ">",
      left: "vector",
      right: "vector",
      result: "bool",
      code: "vector_gt",
      schema: "public",
    },
    {
      name: "=",
      left: "geometry",
      right: "geometry",
      result: "bool",
      code: "geometry_eq",
      schema: "public",
    },
    {
      name: "||",
      left: "hstore",
      right: "hstore",
      result: "hstore",
      code: "hs_concat",
      schema: "public",
    },
    {
      name: "->",
      left: "hstore",
      right: "text",
      result: "text",
      code: "hs_fetchval",
      schema: "public",
    },
    // ltree style concatenation accepting text, and || on a type text converts to implicitly.
    ...[
      ["text", "ltree", "ltree"],
      ["ltree", "text", "ltree"],
      ["geometry", "geometry", "geometry"],
    ].map(([left, right, result]) => ({
      name: "||",
      left,
      right,
      result,
      code: `${left}_${right}_cat`,
      schema: "public",
    })),
  ],
  functions: [{ name: "count", args: ["vector"], result: "int8", kind: "a", schema: "public" }],
  casts: [
    { source: "text", target: "geometry", context: "i", func: "geometry", schema: "public" },
    { source: "geometry", target: "text", context: "i", func: "text", schema: "public" },
  ],
};

describe("acceptance: ordinary PostgreSQL investigations", () => {
  it.each([
    ["text columns", tables(), {}],
    ["enum columns", tables("intent_status", "attempt_status", "method_kind"), { types: enums }],
    [
      "enums with unrelated extensions",
      tables("intent_status", "attempt_status", "method_kind"),
      extensions,
    ],
  ])("makes the payment attempts query locally eligible with %s", (_, relations, options) => {
    const snapshot = analyze(ATTEMPTS, relations, options as FixtureOptions);
    expect(snapshot.reasons).toEqual([]);
    const input = snapshot.input;
    expect(input?.withheldLiterals).toBe(true);
    expect(input?.sql).not.toMatch(/AUTHORIZED|CAPTURED/);
    expect(input?.sql).toContain("'orderRef'");
    expect(input?.sql).not.toContain("':'");
    expect(
      Object.fromEntries(input?.dependencies.map((d) => [`${d.table}.${d.column}`, d.usage]) ?? []),
    ).toEqual({
      "payment_intent.id": "both",
      "payment_intent.updatedAt": "both",
      "payment_intent.metadata": "both",
      "payment_intent.status": "control",
      "payment_attempt.payment_method_kind": "output",
      "payment_attempt.status": "both",
      "payment_attempt.captured_amount_cents": "output",
      "payment_attempt.payment_intent_id": "control",
    });
  });
  it.each([
    ["text status", tables(), {}],
    ["enum status", tables("intent_status"), { types: enums }],
    [
      "enum status with unrelated extension operators, casts and aggregates",
      tables("intent_status"),
      extensions,
    ],
  ])("makes the status count locally eligible with %s", (_, relations, options) => {
    const snapshot = analyze(STATUSES, relations, options as FixtureOptions);
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.dependencies).toEqual([
      expect.objectContaining({ table: "payment_intent", column: "status", usage: "both" }),
    ]);
  });
  it.each([
    [
      "a user equality operator on the enum",
      {
        types: enums,
        operators: [
          {
            name: "=",
            left: "intent_status",
            right: "intent_status",
            result: "bool",
            code: "status_eq",
            schema: "public",
          },
        ],
      },
      /Custom function or operator/,
    ],
    [
      "a user array_agg overload on text",
      {
        types: enums,
        functions: [
          { name: "array_agg", args: ["text"], result: "_text", kind: "a", schema: "public" },
        ],
      },
      /Custom function or operator/,
    ],
    [
      "a user implicit cast from the enum to text",
      {
        types: enums,
        casts: [
          {
            source: "method_kind",
            target: "text",
            context: "i",
            func: "kind_text",
            schema: "public",
          },
        ],
      },
      /Custom cast/,
    ],
    [
      "a user || on the enum",
      {
        types: enums,
        operators: [
          {
            name: "||",
            left: "method_kind",
            right: "text",
            result: "text",
            code: "kind_cat",
            schema: "public",
          },
        ],
      },
      /Custom function or operator/,
    ],
    [
      "public searched before pg_catalog",
      { types: enums, catalogFirst: false },
      /catalog must come first/,
    ],
    [
      "a user default operator class on the enum",
      { types: enums, opclasses: ["method_kind"] },
      /operator class/,
    ],
    ["a view", { types: enums, relation: { relkind: "v" } }, /Views/],
    ["row level security", { types: enums, relation: { rls: true } }, /RLS/],
  ])("keeps the attempts query manual with %s", (_, options, reason) => {
    const snapshot = analyze(
      ATTEMPTS,
      tables("intent_status", "attempt_status", "method_kind"),
      options as FixtureOptions,
    );
    expect(snapshot.complete).toBe(false);
    expect(snapshot.reasons[0]).toMatch(reason);
  });
  it.each([
    ["a custom base type status", { types: [{ name: "status_t", ioCore: false }] }, "status_t"],
    [
      "a domain over an unsupported base type",
      { types: [{ name: "vector" }, { name: "status_d", kind: "d", base: "vector" }] },
      "status_d",
    ],
  ])("keeps the status count manual with %s", (_, options, status) => {
    expect(analyze(STATUSES, tables(status), options as FixtureOptions).complete).toBe(false);
  });
  it("follows the search path: pg_catalog hides a same-signature count, not an overload", () => {
    const shadow: FixtureOptions = {
      functions: [{ name: "count", args: [], result: "int8", kind: "a", schema: "public" }],
    };
    expect(analyze(STATUSES, tables(), shadow).reasons).toEqual([]);
    const overload: FixtureOptions = {
      functions: [{ name: "count", args: ["text"], result: "int8", kind: "a", schema: "public" }],
    };
    const sql = "SELECT count(status) AS n FROM payment_orchestrator.payment_intent";
    expect(analyze(sql, tables(), {}).reasons).toEqual([]);
    expect(analyze(sql, tables(), overload).reasons[0]).toMatch(/Custom function or operator/);
  });
  it("accepts a domain over text as a source and compares it through its base type", () => {
    const options: FixtureOptions = {
      types: [{ name: "code_d", kind: "d", base: "text", category: "S" }],
    };
    const snapshot = analyze(
      "SELECT status, count(*) AS n FROM payment_orchestrator.payment_intent WHERE status = 'OPEN' GROUP BY status",
      tables("code_d"),
      options,
    );
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.dependencies[0]).toMatchObject({ type: "public.code_d" });
  });
  it.each([
    "SELECT pi.metadata FROM payment_orchestrator.payment_intent pi",
    "SELECT pi.metadata -> 'orderRef' FROM payment_orchestrator.payment_intent pi",
    "SELECT jsonb_pretty(pi.metadata) FROM payment_orchestrator.payment_intent pi",
    "SELECT pi.metadata::text FROM payment_orchestrator.payment_intent pi",
    "SELECT concat(pi.metadata) FROM payment_orchestrator.payment_intent pi",
    "WITH m AS (SELECT metadata AS m FROM payment_orchestrator.payment_intent) SELECT m FROM m",
    "SELECT d.m FROM (SELECT metadata AS m FROM payment_orchestrator.payment_intent) d",
    "SELECT array_agg(pi.metadata) FROM payment_orchestrator.payment_intent pi",
    "SELECT * FROM payment_orchestrator.payment_intent",
  ])("never returns a whole or wrapped JSON document: %s", (sql) => {
    expect(analyze(sql, tables()).complete).toBe(false);
  });
  it("keeps raw JSON grouping as a control dependency", () => {
    const snapshot = analyze(
      "SELECT count(*) AS n FROM payment_orchestrator.payment_intent GROUP BY metadata",
      tables(),
    );
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.dependencies).toEqual([
      expect.objectContaining({ column: "metadata", usage: "control" }),
    ]);
  });
});

describe("resolution regressions: implicit effects and overloads", () => {
  const flags: FixtureOptions["types"] = [
    { name: "flag_e", kind: "e" },
    { name: "tier_a", kind: "e" },
    { name: "tier_b", kind: "e" },
  ];
  const items = {
    "public.items": {
      sku: "text",
      quantity: "int4",
      price: "numeric",
      flag: "flag_e",
      a: "tier_a",
      b: "tier_b",
      code: "code_d",
    },
  };
  const userCast = (source: string, target: string): FixtureOptions["casts"] => [
    { source, target, context: "i", func: `${source}_to_${target}`, schema: "public" },
  ];
  it.each([
    ["SELECT sku FROM public.items WHERE flag", userCast("flag_e", "bool")],
    ["SELECT sku FROM public.items WHERE NOT flag", userCast("flag_e", "bool")],
    ["SELECT count(*) FILTER (WHERE flag) AS n FROM public.items", userCast("flag_e", "bool")],
    [
      "SELECT CASE WHEN quantity > 1 THEN a ELSE b END AS tier FROM public.items",
      userCast("tier_a", "tier_b"),
    ],
    ["SELECT coalesce(a, b) AS tier FROM public.items", userCast("tier_a", "tier_b")],
    ["SELECT sku FROM public.items WHERE a IN (b)", userCast("tier_a", "tier_b")],
  ])("runs custom implicit casts only with manual review: %s", (sql, casts) => {
    const options: FixtureOptions = {
      types: [...(flags ?? []), { name: "code_d", kind: "d", base: "text", category: "S" }],
      casts,
    };
    expect(analyze(sql, items, options).reasons[0]).toMatch(/Custom cast/);
    expect(analyze(sql, items, { types: options.types }).reasons[0] ?? "").not.toMatch(
      /Custom cast/,
    );
  });
  it("treats an aggregate-looking call as whatever the catalog resolves", () => {
    const plain: FixtureOptions = {
      functions: [{ name: "count", args: ["text"], result: "int8", schema: "public" }],
    };
    const sql = "SELECT count(sku) AS n FROM public.items";
    const relations = { "public.items": { sku: "text" } };
    expect(analyze(sql, relations).reasons).toEqual([]);
    expect(analyze(sql, relations, plain).reasons[0]).toMatch(/Custom function or operator/);
  });
  it("holds a pg_catalog qualified call that resolves to a user object in pg_catalog", () => {
    const planted: FixtureOptions = {
      functions: [
        { name: "lower", args: ["int4"], result: "text", schema: "pg_catalog", core: false },
      ],
    };
    const relations = { "public.items": { sku: "text", quantity: "int4" } };
    expect(
      analyze("SELECT pg_catalog.lower(sku) AS l FROM public.items", relations).reasons,
    ).toEqual([]);
    expect(
      analyze("SELECT pg_catalog.lower(quantity) AS l FROM public.items", relations, planted)
        .reasons[0],
    ).toMatch(/Custom function or operator/);
  });
  it("keeps domain identity for exact operator matches before its base type", () => {
    const types: FixtureOptions["types"] = [
      { name: "code_d", kind: "d", base: "text", category: "S" },
    ];
    const sql = "SELECT count(*) AS n FROM public.items WHERE code = 'A'";
    const relations = { "public.items": { code: "code_d" } };
    expect(analyze(sql, relations, { types }).reasons).toEqual([]);
    const onDomain: FixtureOptions = {
      types,
      operators: [
        {
          name: "=",
          left: "code_d",
          right: "code_d",
          result: "bool",
          code: "code_eq",
          schema: "public",
        },
      ],
    };
    expect(analyze(sql, relations, onDomain).reasons[0]).toMatch(/Custom function or operator/);
  });
  it("keeps defaulted and variadic overloads competing at another arity", () => {
    const defaulted: FixtureOptions = {
      functions: [
        { name: "lower", args: ["text", "int4"], result: "text", ndefaults: 1, schema: "public" },
      ],
    };
    const variadic: FixtureOptions = {
      functions: [
        { name: "lower", args: ["_text"], result: "text", variadic: "text", schema: "public" },
      ],
    };
    const relations = { "public.items": { sku: "text" } };
    const sql = "SELECT lower(sku) AS l FROM public.items";
    expect(analyze(sql, relations, defaulted).reasons[0]).toMatch(/Custom function or operator/);
    expect(analyze(sql, relations, variadic).reasons[0]).toMatch(/Custom function or operator/);
  });
  it("keeps an unknown literal from shortcutting a function match", () => {
    const unknownArg: FixtureOptions = {
      functions: [{ name: "lower", args: ["int4"], result: "text", schema: "public" }],
    };
    const relations = { "public.items": { sku: "text" } };
    expect(
      analyze("SELECT sku, lower('A') AS l FROM public.items", relations, unknownArg).reasons[0],
    ).toMatch(/Custom function or operator/);
  });
  it("types NULLIF as its promoted first argument", () => {
    const relations = { "public.items": { quantity: "int4", price: "numeric" } };
    expect(
      analyze("SELECT nullif(quantity, price) AS q FROM public.items", relations).reasons,
    ).toEqual([]);
    expect(analyze("SELECT nullif(quantity, 0) AS q FROM public.items", relations).reasons).toEqual(
      [],
    );
  });
  it("aggregates application enums and native arrays", () => {
    const relations = { "public.items": { flag: "flag_e", sku: "text", quantity: "int4" } };
    const snapshot = analyze(
      "SELECT array_agg(flag ORDER BY flag) AS flags, array_agg(sku) AS skus, array_agg(quantity) AS q FROM public.items",
      relations,
      { types: flags },
    );
    expect(snapshot.reasons).toEqual([]);
  });
  it("refuses metadata rows with missing or conflicting facts", () => {
    const sql = "SELECT sku FROM public.items";
    const relations = { "public.items": { sku: "text" } };
    const planned = planRead(sql, "postgresql");
    if (typeof planned === "string") throw new Error(planned);
    const rows = catalogRows(planned, relations);
    const edit = (kind: string, change: (item: Record<string, unknown>) => void) =>
      rows.map((row) => {
        if (row.kind !== kind) return row;
        const item = JSON.parse(String(row.item));
        change(item);
        return { kind, item: JSON.stringify(item) };
      });
    expect(resolveRead(planned, rows).complete).toBe(true);
    for (const broken of [
      edit("column", (i) => delete i.generated),
      edit("column", (i) => delete i.collation_core),
      edit("column", (i) => (i.type = "25x")),
      edit("type", (i) => delete i.ioCore),
      edit("search", (i) => (i.catalogFirst = "yes")),
      [...rows, rows.find((r) => r.kind === "search") as Record<string, unknown>],
      [...rows, rows.find((r) => r.kind === "column") as Record<string, unknown>],
      [...rows, { kind: "surprise", item: "{}" }],
      rows.slice(0, -1),
      rows.filter((r) => r.kind !== "cast"),
      rows.filter((r) => r.kind !== "type"),
    ])
      expect(resolveRead(planned, broken).complete).toBe(false);
  });
  it("detects a truncated result that lost a user operator class row", () => {
    const planned = planRead(STATUSES, "postgresql");
    if (typeof planned === "string") throw new Error(planned);
    const rows = catalogRows(planned, tables("intent_status"), {
      types: enums,
      opclasses: ["intent_status"],
    });
    expect(resolveRead(planned, rows).reasons[0]).toMatch(/operator class/);
    expect(
      resolveRead(
        planned,
        rows.filter((r) => r.kind !== "opclass"),
      ).reasons,
    ).toEqual(["Metadata unavailable"]);
  });
  it("keeps typed literals typed after withholding their values", () => {
    const snapshot = analyze(
      "SELECT count(*) AS n FROM public.items WHERE created >= date '2026-01-01' AND created < timestamp '2026-02-01' + interval '1 day'",
      { "public.items": { created: "timestamp" } },
      {
        operators: [
          {
            name: "+",
            left: "timestamp",
            right: "interval",
            result: "timestamp",
            code: "timestamp_pl_interval",
          },
          {
            name: ">=",
            left: "timestamp",
            right: "date",
            result: "bool",
            code: "timestamp_ge_date",
          },
        ],
      },
    );
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.sql).toContain("CAST($1 AS DATE)");
    expect(snapshot.input?.sql).toContain("CAST($2 AS TIMESTAMP)");
    expect(snapshot.input?.sql).toContain("CAST($3 AS INTERVAL)");
    expect(snapshot.input?.sql).not.toMatch(/2026|1 day/);
  });
});

describe("reviewed STABLE exceptions", () => {
  const events = { "public.events": { happened: "timestamp", seen: "timestamptz", kind: "text" } };
  it.each([
    "SELECT kind FROM public.events WHERE seen >= now() - interval '7 days'",
    "SELECT kind FROM public.events WHERE happened < now()",
    "SELECT date_trunc('day', seen) AS day, count(*) AS n FROM public.events GROUP BY 1",
    "SELECT to_char(seen, 'YYYY-MM') AS month FROM public.events",
  ])("admits time zone dependent built-ins: %s", (sql) => {
    expect(analyze(sql, events).reasons).toEqual([]);
  });
  it.each([
    ["current_setting('TimeZone')", /Function effects/],
    ["pg_get_viewdef('v')", /Function effects/],
    ["random()", /Function effects/],
  ])("keeps other STABLE or VOLATILE built-ins manual: %s", (call, reason) => {
    expect(analyze(`SELECT kind, ${call} AS x FROM public.events`, events).reasons[0]).toMatch(
      reason,
    );
  });
  it("does not extend a reviewed name to a user function", () => {
    const planted: FixtureOptions = {
      functions: [
        {
          name: "to_char",
          args: ["text", "text"],
          result: "text",
          volatility: "s",
          schema: "public",
        },
      ],
    };
    expect(
      analyze("SELECT to_char(kind, 'x') AS k FROM public.events", events, planted).reasons[0],
    ).toMatch(/Custom function or operator/);
  });
});

describe("operand-typed rules for polymorphic and scalar operators", () => {
  const tiers: FixtureOptions["types"] = [
    { name: "tier_a", kind: "e" },
    { name: "tier_b", kind: "e" },
  ];
  const relations = {
    "public.plans": {
      a_list: "_tier_a",
      b: "tier_b",
      a: "tier_a",
      seen: "timestamptz",
      note: "text",
    },
  };
  it("checks the common type of compatible polymorphic arguments", () => {
    const sql = "SELECT a_list || b AS merged FROM public.plans";
    const cast: FixtureOptions = {
      types: tiers,
      casts: [
        { source: "tier_b", target: "tier_a", context: "i", func: "b_to_a", schema: "public" },
      ],
    };
    expect(analyze(sql, relations, cast).reasons[0]).toMatch(/Custom cast/);
    expect(
      analyze("SELECT array_agg(a ORDER BY a) AS tiers FROM public.plans", relations, {
        types: tiers,
      }).reasons,
    ).toEqual([]);
  });
  it("admits a STABLE built-in operator only over native temporal, numeric or boolean operands", () => {
    const sql = "SELECT note FROM public.plans WHERE seen > now() - interval '1 day'";
    expect(analyze(sql, relations, { types: tiers }).reasons).toEqual([]);
    const user = (right: string): FixtureOptions => ({
      types: tiers,
      operators: [
        {
          name: "-",
          left: "timestamptz",
          right,
          result: "timestamptz",
          code: "shift",
          schema: "public",
        },
      ],
    });
    // Same signature: hidden behind pg_catalog. Different signature: chosen, so held.
    expect(analyze(sql, relations, user("interval")).reasons).toEqual([]);
    expect(
      analyze("SELECT note FROM public.plans WHERE seen - 1 > now()", relations, user("int4"))
        .reasons[0],
    ).toMatch(/Custom function or operator/);
    const textual: FixtureOptions = {
      types: tiers,
      operators: [
        {
          name: "%",
          left: "text",
          right: "text",
          result: "bool",
          code: "similarity_op",
          volatility: "s",
        },
      ],
    };
    expect(
      analyze("SELECT note FROM public.plans WHERE note % 'x'", relations, textual).reasons[0],
    ).toMatch(/Function effects/);
  });
});

describe("quoted routine names", () => {
  it("resolves a quoted coalesce as a catalog function, not the grammar construct", () => {
    const relations = { "public.items": { quantity: "int4" } };
    expect(
      analyze("SELECT coalesce(quantity, 0) AS q FROM public.items", relations).reasons,
    ).toEqual([]);
    const planted: FixtureOptions = {
      functions: [{ name: "coalesce", args: ["int4", "int4"], result: "int4", schema: "public" }],
    };
    expect(
      analyze('SELECT "coalesce"(quantity, 0) AS q FROM public.items', relations, planted)
        .reasons[0],
    ).toMatch(/Custom function or operator/);
  });
});

describe("set operations and literal projections", () => {
  const flows = {
    "public.transfers": {
      status: "text",
      amount: "int8",
      created: "timestamp",
      secret_note: "text",
    },
    "public.debits": { status: "text", amount: "int8", created: "timestamp" },
    "public.refunds": { status: "text", amount: "int8", created: "timestamp" },
  };
  const labelled =
    "SELECT 'transfer' AS kind, status, count(*) AS n, sum(amount) AS total FROM public.transfers GROUP BY status UNION ALL SELECT 'debit' AS kind, status, count(*) AS n, sum(amount) AS total FROM public.debits GROUP BY status ORDER BY 1, 2";
  it("resolves a labelled UNION ALL with its trailing ORDER BY on the whole result", () => {
    const snapshot = analyze(labelled, flows);
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.sql).toContain("UNION ALL");
    expect(snapshot.input?.sql).not.toMatch(/'transfer'|'debit'/);
    expect(
      snapshot.input?.dependencies.map((d) => `${d.table}.${d.column}:${d.usage}`).sort(),
    ).toEqual([
      "debits.amount:output",
      "debits.status:both",
      "transfers.amount:output",
      "transfers.status:both",
    ]);
  });
  it("accepts a constant check_name and a source-free clock branch", () => {
    const snapshot = analyze(
      "SELECT 'captured' AS check_name, status AS detail FROM public.transfers UNION ALL SELECT 'checked', now()::text",
      flows,
    );
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.sql).not.toContain("captured");
    expect(snapshot.input?.dependencies).toEqual([
      expect.objectContaining({ table: "transfers", column: "status", usage: "output" }),
    ]);
    expect(analyze("SELECT now()::text AS clock", flows).complete).toBe(false);
  });
  it("keeps sensitive sources and nonconstant aliases local", () => {
    expect(
      analyze("SELECT email AS check_name FROM public.transfers", {
        "public.transfers": { email: "text" },
      }).reasons[0],
    ).toMatch(/Sensitive/);
    expect(analyze("SELECT status AS check_name FROM public.transfers", flows).reasons[0]).toMatch(
      /Sensitive/,
    );
  });
  it.each([
    "SELECT status FROM public.transfers UNION ALL SELECT status FROM public.debits UNION ALL SELECT status FROM public.refunds",
    "SELECT status FROM public.transfers UNION SELECT status FROM public.debits",
    "SELECT status FROM public.transfers INTERSECT SELECT status FROM public.debits INTERSECT SELECT status FROM public.refunds",
    "SELECT status FROM public.transfers EXCEPT SELECT status FROM public.debits",
    "SELECT status FROM public.transfers UNION ALL SELECT status FROM public.debits ORDER BY status LIMIT 5",
    "WITH t AS (SELECT status FROM public.transfers) SELECT status FROM t UNION ALL SELECT status FROM t",
    "SELECT kind FROM (SELECT 'a' AS kind FROM public.transfers UNION ALL SELECT 'b' AS kind FROM public.debits) k",
  ])("resolves ordinary set operations: %s", (sql) => {
    expect(analyze(sql, flows).reasons).toEqual([]);
  });
  it("keeps the right operand of EXCEPT as a control dependency", () => {
    const snapshot = analyze(
      "SELECT status FROM public.transfers EXCEPT SELECT status FROM public.debits",
      flows,
    );
    expect(
      snapshot.input?.dependencies.map((d) => `${d.table}.${d.column}:${d.usage}`).sort(),
    ).toEqual(["debits.status:control", "transfers.status:output"]);
  });
  it.each([
    [
      "SELECT status FROM public.transfers UNION SELECT status FROM public.debits INTERSECT SELECT status FROM public.refunds",
      /precedence/,
    ],
    [
      "SELECT status FROM public.transfers UNION ALL SELECT status, amount FROM public.debits",
      /Unresolved/,
    ],
    [
      "SELECT status FROM public.transfers UNION ALL SELECT status FROM public.debits ORDER BY lower(status)",
      /Unresolved/,
    ],
    [
      "SELECT status FROM public.transfers UNION ALL SELECT secret_note FROM public.transfers",
      /Sensitive/,
    ],
    [
      "SELECT status FROM public.transfers UNION ALL SELECT current_setting('x') FROM public.debits",
      /Function effects/,
    ],
    [
      "SELECT status FROM public.transfers UNION ALL (SELECT status FROM public.debits ORDER BY 1 LIMIT 1)",
      /Unresolved relation/,
    ],
    ["SELECT status FROM public.transfers UNION ALL SELECT email FROM public.debits", /Sensitive/],
  ])("keeps unsafe or ambiguous set operations manual: %s", (sql, reason) => {
    expect(analyze(sql, flows).reasons[0]).toMatch(reason);
  });
  it("checks common-type casts and row comparison per set operation", () => {
    const tiers: FixtureOptions["types"] = [
      { name: "tier_a", kind: "e" },
      { name: "tier_b", kind: "e" },
    ];
    const relations = { "public.x": { a: "tier_a" }, "public.y": { b: "tier_b" } };
    const cast: FixtureOptions = {
      types: tiers,
      casts: [
        { source: "tier_b", target: "tier_a", context: "i", func: "b_to_a", schema: "public" },
      ],
    };
    expect(
      analyze("SELECT a FROM public.x UNION ALL SELECT b FROM public.y", relations, cast)
        .reasons[0],
    ).toMatch(/Custom cast/);
    const opclass: FixtureOptions = { types: tiers, opclasses: ["tier_a"] };
    const same = { "public.x": { a: "tier_a" }, "public.y": { a: "tier_a" } };
    expect(
      analyze("SELECT a FROM public.x UNION ALL SELECT a FROM public.y", same, opclass).reasons,
    ).toEqual([]);
    expect(
      analyze("SELECT a FROM public.x INTERSECT SELECT a FROM public.y", same, opclass).reasons[0],
    ).toMatch(/operator class/);
  });
  it("returns bare literal projections after literal screening, withheld from Jev", () => {
    const snapshot = analyze(
      "SELECT 'Someone Personal' AS label, 42 AS answer, NULL AS nothing, DATE '2026-01-01' AS day, status FROM public.transfers",
      flows,
    );
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.sql).not.toMatch(/Someone Personal|2026-01-01/);
    expect(snapshot.input?.sql).toContain("CAST($2 AS INTEGER)");
    expect(snapshot.input?.sql).toContain("CAST($3 AS DATE)");
    expect(
      analyze("SELECT 'alex@example.invalid' AS contact FROM public.transfers", flows).reasons[0],
    ).toMatch(/Sensitive/);
  });
});

describe("set operation common types fold left to right", () => {
  const tiers: FixtureOptions["types"] = [{ name: "tier_a", kind: "e" }];
  const relations = { "public.x": { a: "tier_a", status: "text" } };
  const sql =
    "SELECT 'gold' AS tier FROM public.x UNION ALL SELECT 'silver' AS tier FROM public.x UNION ALL SELECT a FROM public.x";
  it("keeps the text produced by two unknown literals before the next typed branch", () => {
    const textCast: FixtureOptions = {
      types: tiers,
      casts: [
        { source: "text", target: "tier_a", context: "i", func: "text_to_tier", schema: "public" },
      ],
    };
    expect(analyze(sql, relations, { types: tiers }).complete).toBe(true);
    expect(analyze(sql, relations, textCast).reasons[0]).toMatch(/Custom cast/);
  });
});

// Inferred alternatives for the exported shapes: prefixed text or varchar identifiers
// (tre_acc_..., tre_peu_...), a uuid owner and enum statuses. No real catalog was read.
describe("exported shapes under alternative inferred types", () => {
  const statuses: FixtureOptions["types"] = [
    { name: "account_status", schema: "treasury", kind: "e" },
    { name: "owner_kind", schema: "treasury", kind: "e" },
    { name: "transfer_status", schema: "treasury", kind: "e" },
    { name: "debit_status", schema: "treasury", kind: "e" },
  ];
  const nested =
    "SELECT id, account_holder_id, provider, status, \"createdAt\" FROM treasury.accounts WHERE account_holder_id IN (SELECT id FROM treasury.account_holders WHERE owner_id = '00000000-0000-4000-8000-00000000c002' AND owner_type = 'BUSINESS') ORDER BY \"createdAt\"";
  const endUsers =
    "SELECT id, user_id, provider, jsonb_typeof(provider_metadata) AS metadata_type FROM treasury.provider_end_users WHERE id IN ('tre_peu_0001', 'tre_peu_0002')";
  const flows =
    "SELECT 'transfer_out' AS kind, t.status, count(*) AS orders, sum(t.amount) AS total_cents FROM treasury.transfer_orders t JOIN treasury.accounts a ON a.id = t.source_account_id WHERE a.account_holder_id = 'tre_ahd_0001' GROUP BY t.status UNION ALL SELECT 'debit_in' AS kind, d.status, count(*) AS orders, sum(d.amount) AS total_cents FROM treasury.debit_orders d JOIN treasury.accounts a ON a.id = d.source_account_id WHERE a.account_holder_id = 'tre_ahd_0001' GROUP BY d.status ORDER BY 1, 2";
  it.each(["text", "varchar"])(
    "resolves %s identifiers with a uuid owner and enum statuses",
    (id) => {
      const relations = {
        "treasury.accounts": {
          id,
          account_holder_id: id,
          provider: "text",
          status: "account_status",
          createdAt: "timestamp",
          source_account_id: id,
        },
        "treasury.account_holders": { id, owner_id: "uuid", owner_type: "owner_kind" },
        "treasury.provider_end_users": {
          id,
          user_id: id,
          provider: "text",
          provider_metadata: "jsonb",
        },
        "treasury.transfer_orders": {
          status: "transfer_status",
          amount: "int8",
          source_account_id: id,
        },
        "treasury.debit_orders": { status: "debit_status", amount: "int8", source_account_id: id },
      };
      for (const sql of [nested, endUsers, flows]) {
        const snapshot = analyze(sql, relations, { types: statuses });
        expect(snapshot.reasons, sql).toEqual([]);
        expect(snapshot.input?.sql).not.toMatch(/tre_(?:peu|ahd)_0001|00000000-0000-4000/);
      }
      expect(analyze(flows, relations, { types: statuses }).input?.sql).toMatch(
        /ORDER BY 1 ASC, 2 ASC/,
      );
    },
  );
});

describe("typed JSON scalar extraction", () => {
  const requests = { "public.requests": { id: "uuid", response_data: "jsonb" } };
  it("types an extracted JSON value the query casts to boolean, which fails at runtime otherwise", () => {
    const snapshot = analyze(
      "SELECT id, (response_data #>> '{data,membership,legalRepresentative}')::boolean AS legal_representative FROM public.requests",
      requests,
    );
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.input?.sql).toContain("::BOOLEAN");
  });
});

describe("generated catalog SQL", () => {
  // VARIADIC is reserved: the unquoted reference failed live with a syntax error.
  it("quotes the reserved variadic column", () => {
    const plan = planRead(
      "SELECT sku, product_name, price FROM public.products LIMIT 3",
      "postgresql",
    );
    if (typeof plan === "string") throw new Error(plan);
    const sql = readMetadataSql(plan);
    expect(sql).toContain('AS "variadic"');
    expect(sql).toContain('SELECT "variadic" FROM funcs');
    expect(sql).not.toMatch(/[^"]\bvariadic\b[^"]/);
  });
});

describe("parser-only PostgreSQL spellings", () => {
  const orders = {
    "public.orders": {
      id: "int8",
      amount: "numeric",
      paid: "bool",
      note: "text",
      seen: "timestamptz",
    },
  };
  const parsed = (sql: string) => classifyQuery(sql, "postgresql");

  it.each([
    "timestamp with time zone",
    "TIMESTAMP  WITHOUT TIME ZONE",
    "timestamptz",
    "uuid",
    "jsonb",
    "json",
    "numeric",
    "int8",
    "bigint",
    "integer",
    "text",
    "boolean",
    "bool",
    "inet",
  ])("parses the built-in typed literal %s 'value' as a single read", (type) => {
    expect(parsed(`SELECT id FROM public.orders WHERE note = ${type} 'v'`)).toEqual({
      class: "read",
      parseOk: true,
      blocked: false,
    });
  });
  it.each([
    ["seen >= timestamp with time zone '2026-01-01 00:00:00+00'", "timestamptz"],
    ["id = int8 '7'", "bigint"],
    ["id = bigint '7'", "bigint"],
    ["amount > numeric '1.5'", "numeric"],
    ["paid = boolean 'true'", "boolean"],
  ])("resolves %s against the catalog with its declared type", (predicate, type) => {
    const snapshot = analyze(`SELECT id FROM public.orders WHERE ${predicate}`, orders);
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.input?.sql).toContain(`AS ${type.toUpperCase()})`);
  });
  it("parses FETCH FIRST n ROWS ONLY as LIMIT n for analysis only", () => {
    const sql = "SELECT id FROM public.orders ORDER BY id FETCH FIRST 5 ROWS ONLY";
    expect(parsed(sql)).toMatchObject({ class: "read", parseOk: true });
    expect(prepareSql(sql, "postgresql").sql).toContain("limit 5");
    expect(analyze("SELECT id FROM public.orders FETCH FIRST 1 ROW ONLY", orders).complete).toBe(
      true,
    );
  });
  it.each([
    [
      "a second statement",
      "SELECT id FROM public.orders WHERE note = text 'a'; DELETE FROM public.orders",
    ],
    [
      "a hidden write",
      "WITH d AS (DELETE FROM public.orders RETURNING id) SELECT id FROM d WHERE id = int8 '1'",
    ],
    [
      "FETCH before a write",
      "SELECT id FROM public.orders FETCH FIRST 1 ROWS ONLY; UPDATE public.orders SET note = text 'x'",
    ],
  ])("still refuses %s", (_, sql) => {
    expect(planRead(sql, "postgresql")).toBe("A parsed single read is required");
  });
  it.each([
    ["a user-defined type", "SELECT id FROM public.orders WHERE note = mood 'happy'"],
    [
      "timetz, which has no faithful parser cast",
      "SELECT id FROM public.orders WHERE note = timetz '10:00+00'",
    ],
    ["a schema-qualified type", "SELECT id FROM public.orders WHERE note = public.text 'a'"],
    ["FETCH without a literal count", "SELECT id FROM public.orders FETCH FIRST ROW ONLY"],
    ["FETCH WITH TIES", "SELECT id FROM public.orders ORDER BY id FETCH FIRST 5 ROWS WITH TIES"],
  ])("keeps %s unparsed", (_, sql) => {
    expect(parsed(sql).parseOk).toBe(false);
    expect(planRead(sql, "postgresql")).toBe("A parsed single read is required");
  });
  it.each([
    ["a string", "SELECT id FROM public.orders WHERE note = 'uuid ''x'' fetch first 5 rows only'"],
    [
      "a comment",
      "SELECT id FROM public.orders /* text 'x' fetch first 5 rows only */ WHERE id = 1",
    ],
    ["a quoted identifier", 'SELECT "text" FROM public.orders WHERE id = 1'],
  ])("leaves type names and FETCH inside %s untouched", (_, sql) => {
    const prepared = prepareSql(sql, "postgresql").sql;
    expect(prepared).not.toContain("CAST(");
    expect(prepared).not.toContain("limit 5");
  });
});

describe("live parser holds on the synthetic products table", () => {
  const products = { "public.products": { sku: "text", product_name: "text", price: "numeric" } };
  it.each([
    "SELECT sku, product_name FROM public.products FETCH FIRST 3 ROWS ONLY",
    "SELECT sku FROM public.products WHERE price > numeric '5' LIMIT 3",
  ])("plans %s completely", (sql) => {
    expect(classifyQuery(sql, "postgresql")).toMatchObject({ class: "read", parseOk: true });
    const snapshot = analyze(sql, products);
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.complete).toBe(true);
  });
});

describe("ordinary PostgreSQL backslash strings", () => {
  it("parses a phone comparison but keeps personal data local", () => {
    const sql =
      "SELECT regexp_replace(a.phone, '\\D', '', 'g') = regexp_replace(b.phone, '\\D', '', 'g') AS same_phone FROM public.users a, public.users b WHERE a.id = 1 AND b.id = 2 LIMIT 1";
    expect(classifyQuery(sql, "postgresql")).toMatchObject({ class: "read", parseOk: true });
    expect(planRead(sql, "postgresql")).toBe("Sensitive input stays on this machine");
  });

  it("keeps setting-dependent ordinary strings manual", () => {
    const sql = "SELECT sku FROM public.products WHERE sku = '\\D' LIMIT 1";
    expect(classifyQuery(sql, "postgresql")).toMatchObject({ class: "read", parseOk: true });
    expect(planRead(sql, "postgresql")).toBe("String escape semantics require manual review");
    expect(classifyQuery(sql.replace("'\\D'", "E'\\D'"), "postgresql")).toMatchObject({
      class: "read",
      parseOk: true,
    });
    const doubled = "SELECT sku FROM public.products WHERE sku = 'it''s \\D' LIMIT 1";
    expect(classifyQuery(doubled, "postgresql").parseOk).toBe(true);
    expect(planRead(doubled, "postgresql")).toBe("String escape semantics require manual review");
    const hiddenKey = "SELECT metadata ->> '\\x65mail' FROM public.orders LIMIT 1";
    expect(planRead(hiddenKey, "postgresql")).toBe("String escape semantics require manual review");
  });

  it("refuses ambiguous escaped quotes and a following write", () => {
    const ambiguous = "SELECT sku FROM public.products WHERE sku = 'a\\'b' LIMIT 1";
    expect(classifyQuery(ambiguous, "postgresql").parseOk).toBe(false);
    const second = "SELECT sku FROM public.products WHERE sku = '\\D'; DELETE FROM public.products";
    expect(classifyQuery(second, "postgresql")).toMatchObject({ blocked: true });
    expect(planRead(second, "postgresql")).toBe("A parsed single read is required");
  });
});

describe("evaluator input values", () => {
  const products = { "public.products": { sku: "text", price: "numeric" } };

  it("withholds quoted IDs and numeric values while preserving SQL structure", () => {
    const sql =
      "SELECT 42 AS sample_id, sku FROM public.products WHERE sku = 'sku_demo_123' AND price > 37 ORDER BY 1 LIMIT 5 OFFSET 2";
    const snapshot = analyze(sql, products);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.input?.withheldLiterals).toBe(true);
    expect(snapshot.input?.sql).not.toContain("sku_demo_123");
    expect(snapshot.input?.sql).not.toMatch(/\b(?:42|37)\b/);
    expect(snapshot.input?.sql).toMatch(/ORDER BY 1/i);
    expect(snapshot.input?.sql).toMatch(/LIMIT 5 OFFSET 2/i);
  });

  it("uses separate parameters for text and numeric forms of the same value", () => {
    const snapshot = analyze(
      "SELECT sku FROM public.products WHERE sku = '37' AND price > 37",
      products,
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.input?.sql).toMatch(/sku = \$1/);
    expect(snapshot.input?.sql).toMatch(/price > CAST\(\$2 AS INTEGER\)/);
  });
});
