import { planRead, type ReadSnapshot, resolveRead } from "../read-analysis";
import type { PgReadPlan } from "./plan";

// Synthetic stand-in for the rows catalogSql returns, for unit tests and the offline bench.
// A hand-written subset of built-in objects: it proves the rules, not a real catalog.

interface TypeSpec {
  name: string;
  schema?: string;
  kind?: string;
  category?: string;
  base?: string;
  elem?: string;
  ioCore?: boolean;
}
interface RoutineSpec {
  name: string;
  args: string[];
  result: string;
  kind?: string;
  volatility?: string;
  retset?: boolean;
  ndefaults?: number;
  variadic?: string;
  schema?: string;
  supportCore?: boolean;
  core?: boolean;
}
interface OperatorSpec {
  name: string;
  left?: string;
  right: string;
  result: string;
  code: string;
  volatility?: string;
  schema?: string;
  core?: boolean;
}
interface CastSpec {
  source: string;
  target: string;
  context: string;
  func?: string;
  volatility?: string;
  schema?: string;
  core?: boolean;
}
export interface FixtureColumn {
  type: string;
  generated?: string;
  collationCore?: boolean;
}
export interface FixtureOptions {
  catalogFirst?: boolean;
  relation?: Partial<{ relkind: string; rls: boolean; inherited: boolean }>;
  types?: TypeSpec[];
  operators?: OperatorSpec[];
  functions?: RoutineSpec[];
  casts?: CastSpec[];
  opclasses?: string[];
}

const CORE_TYPES: [number, string, string, number?][] = [
  [16, "bool", "B", 1000],
  [17, "bytea", "U", 1001],
  [19, "name", "S", 1003],
  [20, "int8", "N", 1016],
  [21, "int2", "N", 1005],
  [23, "int4", "N", 1007],
  [25, "text", "S", 1009],
  [26, "oid", "N", 1028],
  [114, "json", "U", 199],
  [700, "float4", "N", 1021],
  [701, "float8", "N", 1022],
  [1042, "bpchar", "S", 1014],
  [1043, "varchar", "S", 1015],
  [1082, "date", "D", 1182],
  [1083, "time", "D", 1183],
  [1114, "timestamp", "D", 1115],
  [1184, "timestamptz", "D", 1185],
  [1186, "interval", "T", 1187],
  [1266, "timetz", "D", 1270],
  [1700, "numeric", "N", 1231],
  [2205, "regclass", "N", 2210],
  [2950, "uuid", "U", 2951],
  [3802, "jsonb", "U", 3807],
];
const PSEUDO: [number, string][] = [
  [705, "unknown"],
  [2249, "record"],
  [2276, "any"],
  [2277, "anyarray"],
  [2281, "internal"],
  [2283, "anyelement"],
  [2776, "anynonarray"],
  [3500, "anyenum"],
  [5077, "anycompatible"],
  [5078, "anycompatiblearray"],
];
const ALIASES: Record<string, string> = {
  int: "int4",
  integer: "int4",
  bigint: "int8",
  boolean: "bool",
  decimal: "numeric",
  "double precision": "float8",
  "character varying": "varchar",
  "timestamp with time zone": "timestamptz",
};

const cmp = ["=", "<>", "<", ">", "<=", ">="];
const scalars = [
  "int4",
  "int8",
  "text",
  "numeric",
  "bool",
  "uuid",
  "date",
  "timestamp",
  "timestamptz",
  "float8",
  "interval",
  "jsonb",
  "bpchar",
];
const CORE_OPERATORS: OperatorSpec[] = [
  ...scalars.flatMap((t) =>
    cmp.map((name) => ({ name, left: t, right: t, result: "bool", code: `${t}cmp` })),
  ),
  ...cmp.flatMap((name) => [
    { name, left: "int4", right: "int8", result: "bool", code: "int48cmp" },
    { name, left: "int8", right: "int4", result: "bool", code: "int84cmp" },
    { name, left: "anyenum", right: "anyenum", result: "bool", code: "enumcmp" },
    { name, left: "anyarray", right: "anyarray", result: "bool", code: "arraycmp" },
    { name, left: "record", right: "record", result: "bool", code: "recordcmp" },
    { name, left: "oid", right: "oid", result: "bool", code: "oidcmp" },
  ]),
  ...["+", "-", "*", "/"].flatMap((name) =>
    ["int4", "int8", "numeric", "float8"].map((t) => ({
      name,
      left: t,
      right: t,
      result: t,
      code: `${t}arith`,
    })),
  ),
  ...["int4", "int8", "numeric", "float8"].map((t) => ({
    name: "-",
    right: t,
    result: t,
    code: `${t}um`,
  })),
  ...["+", "-"].map((name) => ({
    name,
    left: "timestamptz",
    right: "interval",
    result: "timestamptz",
    code: name === "+" ? "timestamptz_pl_interval" : "timestamptz_mi_interval",
    volatility: "s",
  })),
  ...cmp.map((name) => ({
    name,
    left: "timestamp",
    right: "timestamptz",
    result: "bool",
    code: "timestamp_lt_timestamptz",
    volatility: "s",
  })),
  { name: "||", left: "text", right: "text", result: "text", code: "textcat" },
  {
    name: "||",
    left: "anynonarray",
    right: "text",
    result: "text",
    code: "anytextcat",
    volatility: "s",
  },
  {
    name: "||",
    left: "text",
    right: "anynonarray",
    result: "text",
    code: "textanycat",
    volatility: "s",
  },
  {
    name: "||",
    left: "anycompatiblearray",
    right: "anycompatible",
    result: "anycompatiblearray",
    code: "array_append",
  },
  {
    name: "||",
    left: "anycompatible",
    right: "anycompatiblearray",
    result: "anycompatiblearray",
    code: "array_prepend",
  },
  {
    name: "||",
    left: "anycompatiblearray",
    right: "anycompatiblearray",
    result: "anycompatiblearray",
    code: "array_cat",
  },
  { name: "||", left: "jsonb", right: "jsonb", result: "jsonb", code: "jsonb_concat" },
  { name: "->", left: "jsonb", right: "text", result: "jsonb", code: "jsonb_object_field" },
  { name: "->", left: "jsonb", right: "int4", result: "jsonb", code: "jsonb_array_element" },
  { name: "->", left: "json", right: "text", result: "json", code: "json_object_field" },
  { name: "->>", left: "jsonb", right: "text", result: "text", code: "jsonb_object_field_text" },
  { name: "->>", left: "jsonb", right: "int4", result: "text", code: "jsonb_array_element_text" },
  { name: "->>", left: "json", right: "text", result: "text", code: "json_object_field_text" },
  { name: "#>", left: "jsonb", right: "_text", result: "jsonb", code: "jsonb_extract_path_op" },
  {
    name: "#>>",
    left: "jsonb",
    right: "_text",
    result: "text",
    code: "jsonb_extract_path_text_op",
  },
  { name: "?", left: "jsonb", right: "text", result: "bool", code: "jsonb_exists" },
  { name: "@>", left: "jsonb", right: "jsonb", result: "bool", code: "jsonb_contains" },
  ...[
    ["~~", "textlike"],
    ["!~~", "textnlike"],
    ["~~*", "texticlike"],
    ["!~~*", "texticnlike"],
    ["~", "textregexeq"],
  ].map(([name, code]) => ({ name, left: "text", right: "text", result: "bool", code })),
];
const agg = (name: string, args: string[], result: string): RoutineSpec => ({
  name,
  args,
  result,
  kind: "a",
});
const CORE_FUNCTIONS: RoutineSpec[] = [
  agg("count", [], "int8"),
  agg("count", ["any"], "int8"),
  agg("sum", ["int4"], "int8"),
  agg("sum", ["int8"], "numeric"),
  agg("sum", ["numeric"], "numeric"),
  agg("sum", ["float8"], "float8"),
  agg("avg", ["int4"], "numeric"),
  agg("avg", ["int8"], "numeric"),
  agg("avg", ["numeric"], "numeric"),
  ...["min", "max"].flatMap((name) =>
    [
      "int4",
      "int8",
      "numeric",
      "text",
      "date",
      "timestamp",
      "timestamptz",
      "float8",
      "anyenum",
      "anyarray",
    ].map((t) => agg(name, [t], t)),
  ),
  agg("array_agg", ["anynonarray"], "anyarray"),
  agg("array_agg", ["anyarray"], "anyarray"),
  agg("string_agg", ["text", "text"], "text"),
  agg("bool_or", ["bool"], "bool"),
  { name: "row_number", args: [], result: "int8", kind: "w" },
  { name: "rank", args: [], result: "int8", kind: "w" },
  { name: "lag", args: ["anyelement"], result: "anyelement", kind: "w" },
  { name: "lag", args: ["anyelement", "int4"], result: "anyelement", kind: "w" },
  { name: "jsonb_typeof", args: ["jsonb"], result: "text" },
  { name: "jsonb_exists", args: ["jsonb", "text"], result: "bool" },
  { name: "jsonb_array_length", args: ["jsonb"], result: "int4" },
  { name: "jsonb_pretty", args: ["jsonb"], result: "text" },
  { name: "lower", args: ["text"], result: "text" },
  { name: "upper", args: ["text"], result: "text" },
  { name: "length", args: ["text"], result: "int4" },
  { name: "md5", args: ["text"], result: "text" },
  { name: "now", args: [], result: "timestamptz", volatility: "s" },
  { name: "date_trunc", args: ["text", "timestamp"], result: "timestamp" },
  { name: "date_trunc", args: ["text", "timestamptz"], result: "timestamptz", volatility: "s" },
  { name: "extract", args: ["text", "timestamp"], result: "numeric" },
  { name: "extract", args: ["text", "timestamptz"], result: "numeric", volatility: "s" },
  { name: "extract", args: ["text", "date"], result: "numeric" },
  { name: "to_char", args: ["timestamptz", "text"], result: "text", volatility: "s" },
  { name: "to_char", args: ["numeric", "text"], result: "text", volatility: "s" },
  { name: "concat", args: ["any"], result: "text", volatility: "s", variadic: "any" },
  { name: "current_setting", args: ["text"], result: "text", volatility: "s" },
  { name: "current_setting", args: ["text", "bool"], result: "text", volatility: "s" },
  { name: "pg_get_viewdef", args: ["text"], result: "text", volatility: "s" },
  { name: "random", args: [], result: "float8", volatility: "v" },
  { name: "nextval", args: ["regclass"], result: "int8", volatility: "v" },
  { name: "generate_series", args: ["int4", "int4"], result: "int4", retset: true },
  { name: "round", args: ["numeric", "int4"], result: "numeric", ndefaults: 1 },
];
const CORE_CASTS: CastSpec[] = [
  { source: "int4", target: "int8", context: "i", func: "int8" },
  { source: "int4", target: "numeric", context: "i", func: "numeric" },
  { source: "int8", target: "numeric", context: "i", func: "numeric" },
  { source: "int4", target: "float8", context: "i", func: "float8" },
  { source: "int8", target: "float8", context: "i", func: "float8" },
  { source: "numeric", target: "float8", context: "i", func: "float8" },
  { source: "int4", target: "oid", context: "i" },
  { source: "varchar", target: "text", context: "i" },
  { source: "text", target: "varchar", context: "i" },
  { source: "bpchar", target: "text", context: "i", func: "text" },
  { source: "date", target: "timestamp", context: "i", func: "timestamp" },
  { source: "date", target: "timestamptz", context: "i", func: "timestamptz", volatility: "s" },
  {
    source: "timestamp",
    target: "timestamptz",
    context: "i",
    func: "timestamptz",
    volatility: "s",
  },
  { source: "timestamptz", target: "date", context: "a", func: "date", volatility: "s" },
  { source: "timestamptz", target: "timestamp", context: "a", func: "timestamp", volatility: "s" },
  { source: "timestamp", target: "date", context: "a", func: "date" },
  { source: "int8", target: "int4", context: "a", func: "int4" },
  { source: "numeric", target: "numeric", context: "i", func: "numeric" },
  { source: "varchar", target: "varchar", context: "i", func: "varchar" },
];

/** Rows shaped like catalogSql output for the names a plan requests. */
export function catalogRows(
  plan: PgReadPlan,
  relations: Record<string, Record<string, string | FixtureColumn>>,
  options: FixtureOptions = {},
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const add = (kind: string, item: unknown) => rows.push({ kind, item: JSON.stringify(item) });
  const oids = new Map<string, number>();
  const types: Record<string, unknown>[] = [];
  const typeRow = (
    oid: number,
    name: string,
    category: string,
    extra: Record<string, unknown> = {},
  ) => {
    oids.set(name, oid);
    types.push({
      oid,
      name,
      schema: "pg_catalog",
      core: true,
      kind: "b",
      category,
      base: 0,
      elem: 0,
      array: 0,
      ioCore: true,
      ...extra,
    });
  };
  for (const [oid, name, category, array] of CORE_TYPES) {
    typeRow(oid, name, category, { array: array ?? 0 });
    if (array) typeRow(array, `_${name}`, "A", { elem: oid });
  }
  for (const [oid, name] of PSEUDO) typeRow(oid, name, "P", { kind: "p", ioCore: true });
  let next = 90000;
  for (const t of options.types ?? []) {
    const oid = next++;
    const array = next++;
    oids.set(t.name, oid);
    oids.set(`_${t.name}`, array);
    types.push({
      oid,
      name: t.name,
      schema: t.schema ?? "public",
      core: false,
      kind: t.kind ?? "b",
      category: t.category ?? (t.kind === "e" ? "E" : "U"),
      base: t.base ?? 0,
      elem: t.elem ?? 0,
      array,
      ioCore: t.ioCore ?? t.kind !== "b",
    });
    types.push({
      oid: array,
      name: `_${t.name}`,
      schema: t.schema ?? "public",
      core: false,
      kind: "b",
      category: "A",
      base: 0,
      elem: oid,
      array: 0,
      ioCore: true,
    });
  }
  const oid = (name: string): number => {
    const found = oids.get(ALIASES[name] ?? name);
    if (found === undefined) throw new Error(`Fixture type ${name}`);
    return found;
  };
  for (const t of types) {
    if (typeof t.base === "string") t.base = oid(t.base);
    if (typeof t.elem === "string") t.elem = oid(t.elem);
    add("type", t);
  }
  plan.relations.forEach((r, idx) => {
    const columns = relations[`${r.schema}.${r.table}`];
    if (!columns) return;
    const base = { idx, relkind: "r", rls: false, inherited: false, ...options.relation };
    const entries = Object.entries(columns);
    if (!entries.length) add("column", { ...base, name: null });
    entries.forEach(([name, spec], i) => {
      const c = typeof spec === "string" ? { type: spec } : spec;
      add("column", {
        ...base,
        num: i + 1,
        name,
        type: oid(c.type),
        generated: c.generated ?? "",
        collation_core: c.collationCore ?? true,
      });
    });
  });
  let impl = 5000;
  const implRow = (name: string, volatility = "i", core = true) => {
    add("impl", { oid: impl, name, volatility, retset: false, core });
    return impl++;
  };
  for (const o of [...CORE_OPERATORS, ...(options.operators ?? [])]) {
    if (!plan.operators.includes(o.name)) continue;
    const core = o.core ?? (o.schema ?? "pg_catalog") === "pg_catalog";
    add("operator", {
      oid: impl + 20000,
      name: o.name,
      kind: o.left ? "b" : "l",
      left: o.left ? oid(o.left) : 0,
      right: oid(o.right),
      result: oid(o.result),
      code: implRow(o.code, o.volatility, core),
      core,
      schema: o.schema ?? "pg_catalog",
      pos: core ? 1 : 2,
    });
  }
  let fn = 1000;
  for (const f of [...CORE_FUNCTIONS, ...(options.functions ?? [])]) {
    if (!plan.functions.includes(f.name)) continue;
    const core = f.core ?? (f.schema ?? "pg_catalog") === "pg_catalog";
    add("function", {
      oid: core ? fn++ : next++,
      name: f.name,
      kind: f.kind ?? "f",
      volatility: f.volatility ?? "i",
      retset: f.retset ?? false,
      nargs: f.args.length,
      ndefaults: f.ndefaults ?? 0,
      variadic: f.variadic ? oid(f.variadic) : 0,
      args: f.args.map(oid),
      result: oid(f.result),
      core,
      schema: f.schema ?? "pg_catalog",
      pos: core ? 1 : 2,
      support_core: f.supportCore ?? true,
    });
  }
  for (const c of [...CORE_CASTS, ...(options.casts ?? [])]) {
    const core = c.core ?? (c.schema ?? "pg_catalog") === "pg_catalog";
    add("cast", {
      source: oid(c.source),
      target: oid(c.target),
      func: c.func ? implRow(c.func, c.volatility, core) : 0,
      context: c.context,
      method: c.func ? "f" : "b",
    });
  }
  for (const name of plan.types) {
    const known = oids.get(ALIASES[name] ?? name);
    add("target", { name, oid: known ?? null });
  }
  for (const name of options.opclasses ?? []) add("opclass", { type: oid(name) });
  const counts: Record<string, number> = Object.fromEntries(
    ["column", "operator", "function", "target", "cast", "impl", "type", "opclass"].map((k) => [
      k,
      0,
    ]),
  );
  for (const row of rows) counts[String(row.kind)] = (counts[String(row.kind)] ?? 0) + 1;
  return [
    {
      kind: "search",
      item: JSON.stringify({ catalogFirst: options.catalogFirst ?? true, counts }),
    },
    ...rows,
  ];
}

/** Full local analysis of one proposal against the synthetic catalog. */
export function analyzeWithFixture(
  sql: string,
  relations: Record<string, Record<string, string | FixtureColumn>>,
  options?: FixtureOptions,
): ReadSnapshot {
  const plan = planRead(sql, "postgresql");
  if (typeof plan === "string") return { complete: false, reasons: [plan] };
  return resolveRead(plan, catalogRows(plan, relations, options));
}

/** The two investigations Auto mode must not refuse merely for their syntax. */
export const ACCEPTANCE_QUERIES = {
  attempts: `SELECT pi.id, pi."updatedAt", pi.metadata ->> 'orderRef' AS order_ref,
  array_agg(pa.payment_method_kind || ':' || pa.status || ':' || pa.captured_amount_cents::text
            ORDER BY pa.payment_method_kind) AS attempts
FROM payment_orchestrator.payment_intent pi
JOIN payment_orchestrator.payment_attempt pa ON pa.payment_intent_id = pi.id
WHERE pi.status = 'AUTHORIZED'
  AND EXISTS (SELECT 1 FROM payment_orchestrator.payment_attempt c
              WHERE c.payment_intent_id = pi.id AND c.status = 'CAPTURED')
GROUP BY pi.id, pi."updatedAt", pi.metadata
ORDER BY pi."updatedAt"`,
  statuses:
    "SELECT status, count(*) AS n FROM payment_orchestrator.payment_intent GROUP BY status ORDER BY status",
};
