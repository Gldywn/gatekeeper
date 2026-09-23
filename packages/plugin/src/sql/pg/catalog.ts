import { identifierLiteral, validIdentifier } from "./syntax";

/** Anything the analysis cannot prove. The message is a user-visible hold reason. */
export class Hold extends Error {}
export function hold(reason: string): never {
  throw new Hold(reason);
}

// OIDs below FirstNormalObjectId (src/include/access/transam.h) come from initdb. Later
// objects are user objects, even inside pg_catalog.
const FIRST_NORMAL_OID = 16384;

// Fixed pg_type OIDs of built-in types (src/include/catalog/pg_type.dat), to type literals.
export const T = {
  bool: 16,
  int8: 20,
  int4: 23,
  text: 25,
  numeric: 1700,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
} as const;

export interface CatalogRequest {
  relations: { schema: string; table: string }[];
  operators: string[];
  functions: string[];
  types: string[];
}

function list(values: string[]): string {
  return `ARRAY[${values.map(identifierLiteral).join(", ")}]::pg_catalog.text[]`;
}

// Catalog tables only: proposal names travel as escaped literals and nothing it contains
// runs. The temporary schema is never searched for functions or operators.
// The first row carries per-kind row counts so a truncated result is detected, not trusted.
export function catalogSql(request: CatalogRequest): string {
  if (!request.relations.length) throw new Error("Invalid relation");
  for (const r of request.relations)
    if (!validIdentifier(r.schema) || !validIdentifier(r.table))
      throw new Error("Invalid relation");
  const relations = request.relations
    .map((r, i) => `(${i}, ${identifierLiteral(r.schema)}, ${identifierLiteral(r.table)})`)
    .join(", ");
  const literals = Object.values(T).join(", ");
  const core = (oid: string, nsp: string) =>
    `(${oid}::pg_catalog.int8 < ${FIRST_NORMAL_OID} AND ${nsp} = cat.oid)`;
  const aggregateSupport = [
    "aggtransfn",
    "aggfinalfn",
    "aggcombinefn",
    "aggserialfn",
    "aggdeserialfn",
    "aggmtransfn",
    "aggminvtransfn",
    "aggmfinalfn",
    "aggsortop",
  ]
    .map((column) => `ag.${column}::pg_catalog.oid::pg_catalog.int8 < ${FIRST_NORMAL_OID}`)
    .join(" AND ");
  return `WITH RECURSIVE
  cat AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'pg_catalog'),
  rel(idx, nsp, name) AS (VALUES ${relations}),
  path AS (
    SELECT s.nsp, s.pos FROM pg_catalog.unnest(pg_catalog.current_schemas(true)) WITH ORDINALITY AS s(nsp, pos)
    WHERE pg_catalog.substr(s.nsp, 1, 8) <> 'pg_temp_'
  ),
  cols AS (
    SELECT r.idx, c.relkind::pg_catalog.text AS relkind, c.relrowsecurity AS rls, c.relhassubclass AS inherited,
      a.attnum AS num, a.attname::pg_catalog.text AS name, a.atttypid::pg_catalog.int8 AS type, a.attgenerated::pg_catalog.text AS generated,
      (a.attcollation::pg_catalog.int8 = 0 OR EXISTS (SELECT 1 FROM pg_catalog.pg_collation co, cat
        WHERE co.oid = a.attcollation AND ${core("co.oid", "co.collnamespace")})) AS collation_core
    FROM rel r
    JOIN pg_catalog.pg_namespace n ON n.nspname = r.nsp
    JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = r.name
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  ),
  ops AS (
    SELECT o.oid::pg_catalog.int8 AS oid, o.oprname::pg_catalog.text AS name, o.oprkind::pg_catalog.text AS kind, o.oprleft::pg_catalog.int8 AS "left",
      o.oprright::pg_catalog.int8 AS "right", o.oprresult::pg_catalog.int8 AS result, o.oprcode::pg_catalog.oid::pg_catalog.int8 AS code,
      ${core("o.oid", "o.oprnamespace")} AS core, n.nspname::pg_catalog.text AS schema, p.pos
    FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace
    JOIN path p ON p.nsp = n.nspname CROSS JOIN cat
    WHERE o.oprname = ANY (${list(request.operators)})
  ),
  funcs AS (
    SELECT p.oid::pg_catalog.int8 AS oid, p.proname::pg_catalog.text AS name, p.prokind::pg_catalog.text AS kind, p.provolatile::pg_catalog.text AS volatility,
      p.proretset AS retset, p.pronargs AS nargs, p.pronargdefaults AS ndefaults, p.provariadic::pg_catalog.int8 AS "variadic",
      p.proargtypes::pg_catalog.oid[]::pg_catalog.int8[] AS args, p.prorettype::pg_catalog.int8 AS result,
      ${core("p.oid", "p.pronamespace")} AS core, n.nspname::pg_catalog.text AS schema, s.pos,
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_aggregate ag
        WHERE ag.aggfnoid::pg_catalog.oid = p.oid AND NOT (${aggregateSupport})) AS support_core
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN path s ON s.nsp = n.nspname CROSS JOIN cat
    WHERE p.proname = ANY (${list(request.functions)})
  ),
  targets AS (
    SELECT t.name, pg_catalog.to_regtype(t.name)::pg_catalog.oid::pg_catalog.int8 AS oid
    FROM pg_catalog.unnest(${list(request.types)}) AS t(name)
  ),
  seed(oid) AS (
    SELECT type FROM cols WHERE type IS NOT NULL
    UNION SELECT "left" FROM ops UNION SELECT "right" FROM ops UNION SELECT result FROM ops
    UNION SELECT pg_catalog.unnest(args) FROM funcs UNION SELECT result FROM funcs
    UNION SELECT "variadic" FROM funcs UNION SELECT oid FROM targets WHERE oid IS NOT NULL
    UNION SELECT pg_catalog.unnest(ARRAY[${literals}]::pg_catalog.int8[])
  ),
  closure(oid, depth) AS (
    SELECT oid, 0 FROM seed WHERE oid <> 0
    UNION
    SELECT x.oid, c.depth + 1 FROM closure c JOIN pg_catalog.pg_type t ON t.oid::pg_catalog.int8 = c.oid
    CROSS JOIN LATERAL (VALUES (t.typbasetype::pg_catalog.int8), (t.typelem::pg_catalog.int8), (t.typarray::pg_catalog.int8)) AS x(oid)
    WHERE x.oid <> 0 AND c.depth < 4
  ),
  casts AS (
    SELECT ca.castsource::pg_catalog.int8 AS source, ca.casttarget::pg_catalog.int8 AS target, ca.castfunc::pg_catalog.int8 AS func,
      ca.castcontext::pg_catalog.text AS context, ca.castmethod::pg_catalog.text AS method
    FROM pg_catalog.pg_cast ca
    WHERE ca.castsource::pg_catalog.int8 IN (SELECT oid FROM closure)
      AND (ca.castcontext = 'i' OR ca.casttarget::pg_catalog.int8 IN (SELECT oid FROM targets))
  ),
  typeset AS (SELECT oid FROM closure UNION SELECT source FROM casts UNION SELECT target FROM casts),
  impl AS (
    SELECT p.oid::pg_catalog.int8 AS oid, p.proname::pg_catalog.text AS name, p.provolatile::pg_catalog.text AS volatility, p.proretset AS retset,
      ${core("p.oid", "p.pronamespace")} AS core
    FROM pg_catalog.pg_proc p CROSS JOIN cat
    WHERE p.oid::pg_catalog.int8 IN (SELECT code FROM ops UNION SELECT func FROM casts)
  ),
  types AS (
    SELECT pg_catalog.json_build_object('oid', t.oid::pg_catalog.int8, 'name', t.typname::pg_catalog.text,
      'schema', n.nspname::pg_catalog.text, 'core', ${core("t.oid", "t.typnamespace")},
      'kind', t.typtype::pg_catalog.text, 'category', t.typcategory::pg_catalog.text, 'base', t.typbasetype::pg_catalog.int8,
      'elem', t.typelem::pg_catalog.int8, 'array', t.typarray::pg_catalog.int8,
      'ioCore', EXISTS (SELECT 1 FROM pg_catalog.pg_proc i, pg_catalog.pg_proc o
        WHERE i.oid = t.typinput::pg_catalog.oid AND o.oid = t.typoutput::pg_catalog.oid
        AND ${core("i.oid", "i.pronamespace")} AND ${core("o.oid", "o.pronamespace")}))::pg_catalog.text AS item
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace CROSS JOIN cat
    WHERE t.oid::pg_catalog.int8 IN (SELECT oid FROM typeset)
  ),
  opclasses AS (
    SELECT pg_catalog.json_build_object('type', oc.opcintype::pg_catalog.int8)::pg_catalog.text AS item
    FROM pg_catalog.pg_opclass oc JOIN pg_catalog.pg_am am ON am.oid = oc.opcmethod CROSS JOIN cat
    WHERE oc.opcdefault AND am.amname IN ('btree', 'hash') AND oc.opcintype::pg_catalog.int8 IN (SELECT oid FROM typeset)
      AND NOT ${core("oc.oid", "oc.opcnamespace")}
  )
SELECT 'search' AS kind, pg_catalog.json_build_object('catalogFirst',
  (SELECT nsp FROM path ORDER BY pos LIMIT 1) = 'pg_catalog', 'counts', pg_catalog.json_build_object(
    'column', (SELECT pg_catalog.count(*) FROM cols), 'operator', (SELECT pg_catalog.count(*) FROM ops),
    'function', (SELECT pg_catalog.count(*) FROM funcs), 'target', (SELECT pg_catalog.count(*) FROM targets),
    'cast', (SELECT pg_catalog.count(*) FROM casts), 'impl', (SELECT pg_catalog.count(*) FROM impl),
    'type', (SELECT pg_catalog.count(*) FROM types), 'opclass', (SELECT pg_catalog.count(*) FROM opclasses)))::pg_catalog.text AS item
UNION ALL SELECT 'column', pg_catalog.row_to_json(cols)::pg_catalog.text FROM cols
UNION ALL SELECT 'operator', pg_catalog.row_to_json(ops)::pg_catalog.text FROM ops
UNION ALL SELECT 'function', pg_catalog.row_to_json(funcs)::pg_catalog.text FROM funcs
UNION ALL SELECT 'target', pg_catalog.row_to_json(targets)::pg_catalog.text FROM targets
UNION ALL SELECT 'cast', pg_catalog.row_to_json(casts)::pg_catalog.text FROM casts
UNION ALL SELECT 'impl', pg_catalog.row_to_json(impl)::pg_catalog.text FROM impl
UNION ALL SELECT 'type', item FROM types
UNION ALL SELECT 'opclass', item FROM opclasses`;
}

export interface TypeInfo {
  oid: number;
  name: string;
  schema: string;
  core: boolean;
  kind: string;
  category: string;
  base: number;
  elem: number;
  array: number;
  ioCore: boolean;
}
export interface ColumnInfo {
  num: number;
  name: string;
  type: number;
  generated: string;
  collationCore: boolean;
}
export interface RelationInfo {
  relkind: string;
  rls: boolean;
  inherited: boolean;
  columns: ColumnInfo[];
}
export interface Routine {
  oid: number;
  name: string;
  core: boolean;
  args: number[];
  result: number;
  kind: string;
  /** Functions only. */
  volatility: string;
  retset: boolean;
  nargs: number;
  ndefaults: number;
  variadic: number;
  supportCore: boolean;
  /** Operators only: the implementing function. */
  code: number;
  schema: string;
}
export interface Cast {
  source: number;
  target: number;
  func: number;
  context: string;
  method: string;
}
export interface Impl {
  name: string;
  volatility: string;
  retset: boolean;
  core: boolean;
}
export interface Catalog {
  catalogFirst: boolean;
  relations: RelationInfo[];
  types: Map<number, TypeInfo>;
  operators: Routine[];
  functions: Routine[];
  casts: Cast[];
  targets: Map<string, number | null>;
  impl: Map<number, Impl>;
  userOpclass: Set<number>;
}

const KINDS = ["column", "operator", "function", "target", "cast", "impl", "type", "opclass"];

function fail(): never {
  hold("Metadata unavailable");
}
function int(v: unknown): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) fail();
  return n;
}
function ints(v: unknown): number[] {
  if (!Array.isArray(v)) fail();
  return v.map(int);
}
function bool(v: unknown): boolean {
  if (typeof v !== "boolean") fail();
  return v;
}
function str(v: unknown, allowed?: string[]): string {
  if (typeof v !== "string" || (allowed && !allowed.includes(v))) fail();
  return v;
}

/** Host rows are data: every field is validated, and anything missing or conflicting holds. */
export function parseCatalog(rows: Record<string, unknown>[], relationCount: number): Catalog {
  const cat: Catalog = {
    catalogFirst: false,
    relations: [],
    types: new Map(),
    operators: [],
    functions: [],
    casts: [],
    targets: new Map(),
    impl: new Map(),
    userOpclass: new Set(),
  };
  let search = 0;
  let counts: Record<string, unknown> = {};
  const seenKinds: Record<string, number> = {};
  const seen = new Set<string>();
  const once = (key: string) => {
    if (seen.has(key)) fail();
    seen.add(key);
  };
  for (const row of rows) {
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(str(row.item));
    } catch {
      fail();
    }
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail();
    const kind = str(row.kind);
    seenKinds[kind] = (seenKinds[kind] ?? 0) + 1;
    switch (kind) {
      case "search":
        search++;
        cat.catalogFirst = bool(item.catalogFirst);
        if (item.counts === null || typeof item.counts !== "object") fail();
        counts = item.counts as Record<string, unknown>;
        break;
      case "column": {
        const idx = int(item.idx);
        if (idx >= relationCount) fail();
        const relation = {
          relkind: str(item.relkind),
          rls: bool(item.rls),
          inherited: bool(item.inherited),
        };
        const current = cat.relations[idx];
        if (
          current &&
          (current.relkind !== relation.relkind ||
            current.rls !== relation.rls ||
            current.inherited !== relation.inherited)
        )
          fail();
        cat.relations[idx] ??= { ...relation, columns: [] };
        if (item.name === null) break;
        once(`column:${idx}:${int(item.num)}`);
        cat.relations[idx].columns.push({
          num: int(item.num),
          name: str(item.name),
          type: int(item.type),
          generated: str(item.generated),
          collationCore: bool(item.collation_core),
        });
        break;
      }
      case "operator":
      case "function": {
        const operator = row.kind === "operator";
        once(`${row.kind}:${int(item.oid)}`);
        const args = operator
          ? [int(item.left), int(item.right)].filter((oid) => oid !== 0)
          : ints(item.args);
        (operator ? cat.operators : cat.functions).push({
          oid: int(item.oid),
          name: str(item.name),
          schema: str(item.schema),
          core: bool(item.core),
          args,
          result: int(item.result),
          kind: str(item.kind, operator ? ["b", "l"] : ["f", "a", "w", "p"]),
          volatility: operator ? "" : str(item.volatility, ["i", "s", "v"]),
          retset: operator ? false : bool(item.retset),
          nargs: operator ? args.length : int(item.nargs),
          ndefaults: operator ? 0 : int(item.ndefaults),
          variadic: operator ? 0 : int(item.variadic),
          supportCore: operator ? true : bool(item.support_core),
          code: operator ? int(item.code) : 0,
        });
        break;
      }
      case "target": {
        const name = str(item.name);
        if (cat.targets.has(name)) fail();
        cat.targets.set(name, item.oid === null ? null : int(item.oid));
        break;
      }
      case "cast":
        cat.casts.push({
          source: int(item.source),
          target: int(item.target),
          func: int(item.func),
          context: str(item.context, ["i", "a", "e"]),
          method: str(item.method, ["f", "b", "i"]),
        });
        break;
      case "impl":
        once(`impl:${int(item.oid)}`);
        cat.impl.set(int(item.oid), {
          name: str(item.name),
          volatility: str(item.volatility, ["i", "s", "v"]),
          retset: bool(item.retset),
          core: bool(item.core),
        });
        break;
      case "type":
        once(`type:${int(item.oid)}`);
        cat.types.set(int(item.oid), {
          oid: int(item.oid),
          name: str(item.name),
          schema: str(item.schema),
          core: bool(item.core),
          kind: str(item.kind),
          category: str(item.category),
          base: int(item.base),
          elem: int(item.elem),
          array: int(item.array),
          ioCore: bool(item.ioCore),
        });
        break;
      case "opclass":
        cat.userOpclass.add(int(item.type));
        break;
      default:
        fail();
    }
  }
  if (search !== 1) fail();
  for (const kind of KINDS) if (int(counts[kind]) !== (seenKinds[kind] ?? 0)) fail();
  for (let i = 0; i < relationCount; i++)
    if (!cat.relations[i]) hold("Metadata unavailable or relation unresolved");
  return cat;
}

/** A value's possible types: known OIDs, an untyped string literal, or unresolved. */
export type Ty = number[] | "unknown" | "top";

// Values that identify or expose server internals rather than user data.
const SYSTEM_TYPES = new Set([
  "oid",
  "name",
  "tid",
  "xid",
  "xid8",
  "cid",
  "int2vector",
  "oidvector",
  "pg_lsn",
  "pg_snapshot",
  "txid_snapshot",
  "aclitem",
  "pg_node_tree",
  "pg_ndistinct",
  "pg_dependencies",
  "pg_mcv_list",
  "pg_brin_bloom_summary",
  "pg_brin_minmax_multi_summary",
  "gtsvector",
  "refcursor",
]);

// A reviewed exception list, not a property of the signature: STABLE alone does not rule
// out reads of configuration or catalog data, so every other STABLE function stays manual.
const REVIEWED_STABLE = new Set([
  "now",
  "statement_timestamp",
  "transaction_timestamp",
  "date_trunc",
  "date_part",
  "extract",
  "age",
  "timezone",
  "to_char",
  "to_date",
  "to_timestamp",
  "to_number",
  "date",
  "timestamp",
  "timestamptz",
  "time",
  "timetz",
  "anytextcat",
  "textanycat",
  "concat",
  "concat_ws",
  "format",
]);

// Built-in arithmetic and comparison operators over date/time, interval, numeric and boolean
// values read nothing beyond their operands and the session time zone, whatever their volatility.
const SCALAR_OPERATORS = new Set(["+", "-", "=", "<>", "<", "<=", ">", ">="]);
const SCALAR_OPERANDS = new Set(["D", "T", "N", "B"]);

// Reviewed JSON reductions that return only a screened key's scalar, its presence or a type
// name, never the rest of the document. Every other use of a document stays opaque.
const JSON_REDUCTIONS: Record<string, "key" | "type"> = {
  "->>": "key",
  "#>>": "key",
  "?": "key",
  jsonb_exists: "key",
  jsonb_typeof: "type",
  json_typeof: "type",
};
const POLYMORPHIC =
  /^any(element|nonarray|enum|array|compatible|compatiblenonarray|compatiblearray)$/;

export interface CallArg {
  ty: Ty;
  opaque: boolean;
  /** A static string literal, which is a JSON key or path when a JSON argument is present. */
  key?: string;
}
export interface CallResult {
  ty: Ty;
  opaque: boolean;
  /** Arguments consumed as JSON keys or paths, which stay visible to the evaluator. */
  keys: number[];
  /** Parameter types of every candidate PostgreSQL may still choose. */
  params: number[][];
}

export class Resolver {
  readonly cat: Catalog;
  constructor(cat: Catalog) {
    this.cat = cat;
  }

  type(oid: number): TypeInfo | undefined {
    return this.cat.types.get(oid);
  }

  /** The type followed by the base types of its domains. */
  ancestors(oid: number): number[] {
    const out: number[] = [];
    for (let t = this.type(oid); t && out.length < 8; t = this.type(t.base)) {
      out.push(t.oid);
      if (t.kind !== "d") break;
    }
    return out.length ? out : [oid];
  }

  /** undefined when metadata for the type or one of its bases is missing. */
  private some(oid: number, test: (t: TypeInfo) => boolean): boolean | undefined {
    const chain = this.ancestors(oid).map((o) => this.type(o));
    if (chain.some((t) => !t)) return undefined;
    return chain.some((t) => test(t as TypeInfo));
  }

  isArray(oid: number): boolean | undefined {
    return this.some(oid, (t) => t.category === "A");
  }

  jsonish(oid: number): boolean {
    if (this.some(oid, (t) => t.core && (t.name === "json" || t.name === "jsonb")) !== false)
      return true;
    return this.ancestors(oid).some((o) => {
      const t = this.type(o);
      return t?.category === "A" && t.elem !== 0 && this.jsonish(t.elem);
    });
  }

  system(oid: number): boolean {
    const t = this.type(oid);
    if (!t) return true;
    if (t.core && (SYSTEM_TYPES.has(t.name) || /^reg[a-z]+$/.test(t.name))) return true;
    if (t.kind === "d") return this.system(t.base);
    if (t.category === "A" && t.elem) return this.system(t.elem);
    return false;
  }

  /** Values that can be read, compared and returned by server-shipped code only. */
  value(oid: number): boolean {
    const t = this.type(oid);
    if (!t || this.system(oid) || t.kind === "p") return false;
    if (t.kind === "d") return this.value(t.base);
    if (t.category === "A") return t.ioCore && t.elem !== 0 && this.value(t.elem);
    if (t.kind === "e") return t.ioCore;
    return t.core && t.ioCore && ["b", "r", "m"].includes(t.kind);
  }

  typeName(oid: number): string {
    const t = this.type(oid);
    if (!t) return "unknown";
    const qualified = `${t.schema}.${t.name}`;
    return t.core || qualified.length > 63 ? t.name : qualified;
  }

  /** Sorting, grouping and DISTINCT use the type's default operator class, not a name lookup. */
  sortable(ty: Ty): void {
    if (ty === "top") hold("Unresolved ordering or grouping type");
    if (ty === "unknown") return;
    for (const oid of ty) {
      if (!this.value(oid)) hold("Unresolved ordering or grouping type");
      const related = this.ancestors(oid).flatMap((o) => [o, this.type(o)?.elem ?? 0]);
      if (related.some((o) => this.cat.userOpclass.has(o)))
        hold("Custom operator class needs manual review");
    }
  }

  private pseudoAccepts(arg: number, param: TypeInfo): boolean {
    const array = this.isArray(arg);
    const kinds = this.ancestors(arg).map((o) => this.type(o)?.kind);
    const is = (kind: string) => kinds.includes(kind) || kinds.includes(undefined);
    switch (param.name) {
      case "anyarray":
      case "anycompatiblearray":
        return array !== false;
      case "anynonarray":
      case "anycompatiblenonarray":
        return array !== true;
      case "anyenum":
        return is("e");
      case "anyrange":
      case "anycompatiblerange":
        return is("r");
      case "anymultirange":
      case "anycompatiblemultirange":
        return is("m");
      case "record":
        return is("c");
      case "internal":
        return false;
      default:
        return true;
    }
  }

  // False only with proof that PostgreSQL cannot implicitly coerce arg to param: missing
  // metadata, domains, arrays, composites and polymorphism all keep the candidate.
  mayCoerce(arg: number, param: number): boolean {
    if (arg === param) return true;
    const p = this.type(param);
    const a = this.type(arg);
    if (!p || !a) return true;
    if (p.kind === "p") return this.pseudoAccepts(arg, p);
    if (p.kind === "d") return true;
    const chain = this.ancestors(arg);
    if (chain.includes(param)) return true;
    const array = this.isArray(arg);
    // Array to array coercion follows element casts; array to scalar needs a pg_cast entry.
    if (array === undefined || (array && p.category === "A")) return true;
    if (chain.some((o) => this.type(o)?.kind === "c") || p.kind === "c") return true;
    return this.cat.casts.some(
      (c) => chain.includes(c.source) && c.target === param && c.context === "i",
    );
  }

  private param(r: Routine, i: number): number {
    if (r.variadic && i >= r.args.length - 1) return r.variadic;
    return r.args[i] ?? 0;
  }

  private excluded(r: Routine, args: CallArg[]): boolean {
    return args.some((a, i) => {
      if (!Array.isArray(a.ty)) return false;
      const param = this.param(r, i);
      return a.ty.every((oid) => !this.mayCoerce(oid, param));
    });
  }

  private implAllowed(oid: number, reason: string, scalarOperator = false): void {
    const impl = this.cat.impl.get(oid);
    if (!impl?.core || impl.retset) hold(reason);
    if (scalarOperator && impl.volatility === "s") return;
    this.effects(impl.volatility, impl.name);
  }

  private scalarOperator(r: Routine): boolean {
    return (
      SCALAR_OPERATORS.has(r.name) &&
      [...r.args, r.result].every((oid) => {
        const t = this.type(oid);
        return (
          !!t && t.core && t.kind === "b" && SCALAR_OPERANDS.has(t.category) && !this.system(oid)
        );
      })
    );
  }

  private effects(volatility: string, name: string): void {
    if (volatility === "i") return;
    if (volatility === "s" && REVIEWED_STABLE.has(name)) return;
    hold(`Function effects need manual review: ${name}`);
  }

  // Checks the effects of every implicit conversion between two types, array elements
  // included. False when PostgreSQL has no such conversion.
  private castEffects(from: number, to: number): boolean {
    const chain = this.ancestors(from);
    if (chain.includes(to)) return true;
    const direct = this.cat.casts.filter(
      (c) => chain.includes(c.source) && c.target === to && c.context === "i",
    );
    for (const c of direct) if (c.func) this.implAllowed(c.func, "Custom cast needs manual review");
    const f = this.type(from);
    const t = this.type(to);
    if (f?.category === "A" && t?.category === "A" && f.elem && t.elem)
      return this.castEffects(f.elem, t.elem) || direct.length > 0;
    return direct.length > 0;
  }

  private coercions(args: CallArg[], r: Routine): void {
    const polymorphic: Ty[] = [];
    args.forEach((a, i) => {
      if (!Array.isArray(a.ty)) return;
      const param = this.param(r, i);
      const p = this.type(param);
      if (p?.kind === "p" && POLYMORPHIC.test(p.name)) {
        const arrayParam = /array$/.test(p.name) && !/nonarray$/.test(p.name);
        polymorphic.push(arrayParam ? a.ty.map((oid) => this.type(oid)?.elem || oid) : a.ty);
      }
      for (const oid of a.ty) this.castEffects(oid, param);
    });
    // Polymorphic arguments are coerced to one common type, possibly through casts.
    this.common(polymorphic);
  }

  /** Conditions coerce to boolean outside any function call, possibly through a cast. */
  coerce(ty: Ty, target: number): void {
    if (ty === "top") hold("Unresolved SQL dependencies");
    if (ty === "unknown") return;
    for (const oid of ty) if (!this.castEffects(oid, target)) hold("Unresolved SQL dependencies");
  }

  /** CASE, COALESCE, GREATEST, LEAST and IN lists coerce every branch to one common type. */
  common(tys: Ty[]): Ty {
    if (tys.includes("top")) return "top";
    const known = [...new Set(tys.flatMap((t) => (Array.isArray(t) ? t : [])))];
    if (!known.length) return [T.text];
    for (const a of known) for (const b of known) if (a !== b) this.castEffects(a, b);
    return known;
  }

  private resultOf(r: Routine, args: CallArg[]): Ty {
    const ret = this.type(r.result);
    if (!ret) return "top";
    if (ret.kind !== "p") return [r.result];
    if (!POLYMORPHIC.test(ret.name)) return "top";
    const scalar = new Set<number>();
    const arrays = new Set<number>();
    let unresolved = false;
    args.forEach((a, i) => {
      const p = this.type(this.param(r, i));
      if (p?.kind !== "p" || !POLYMORPHIC.test(p.name) || a.ty === "unknown") return;
      if (a.ty === "top") {
        unresolved = true;
        return;
      }
      const arrayParam = /array$/.test(p.name) && !/nonarray$/.test(p.name);
      for (const oid of a.ty) {
        if (!arrayParam) scalar.add(oid);
        else if (this.isArray(oid) !== false) {
          arrays.add(oid);
          const elem = this.type(oid)?.elem;
          if (elem) scalar.add(elem);
          else unresolved = true;
        }
      }
    });
    if (unresolved) return "top";
    // Unknown literals alone resolve polymorphic parameters as text.
    if (!scalar.size && !arrays.size) scalar.add(T.text);
    if (!/array$/.test(ret.name) || /nonarray$/.test(ret.name)) return [...scalar];
    const out = new Set(arrays);
    // A binding without an array type makes PostgreSQL raise an error, so it returns nothing.
    for (const oid of scalar) if (this.type(oid)?.array) out.add(this.type(oid)?.array as number);
    return [...out];
  }

  private exact(candidates: Routine[], args: CallArg[], operator: boolean): Routine | undefined {
    const single = (ty: Ty): number | undefined =>
      Array.isArray(ty) && ty.length === 1 ? ty[0] : undefined;
    const tys = args.map((a) => a.ty);
    let wanted: number[] | undefined;
    if (tys.every((ty) => single(ty) !== undefined)) wanted = tys.map((ty) => single(ty) as number);
    else if (operator && tys.length === 2) {
      // For operators only, one unknown literal takes the other operand's type in the exact check.
      const [l, r] = tys;
      const known = l === "unknown" ? single(r) : r === "unknown" ? single(l) : undefined;
      if (known !== undefined) wanted = [known, known];
    }
    if (!wanted) return undefined;
    const match = (w: number[]) =>
      candidates.filter(
        (c) =>
          c.args.length === w.length &&
          (operator || (c.nargs === w.length && !c.variadic)) &&
          c.args.every((t, i) => t === w[i]),
      );
    let found = match(wanted);
    // Against a domain, an unknown literal also matches an operator on the domain's base type.
    if (!found.length && operator && tys.includes("unknown")) {
      const domain = this.type(wanted[0]);
      if (domain?.kind === "d") found = match([domain.base, domain.base]);
    }
    if (found.length !== 1) return undefined;
    // Defaulted or variadic functions can compete at another declared arity.
    if (
      !operator &&
      candidates.some(
        (c) => c !== found[0] && (c.ndefaults || c.variadic) && !this.excluded(c, args),
      )
    )
      return undefined;
    return found[0];
  }

  private resolve(
    candidates: Routine[],
    args: CallArg[],
    name: string,
    operator: boolean,
  ): CallResult {
    if (!this.cat.catalogFirst) hold("PostgreSQL catalog must come first in the search path");
    // With pg_catalog searched first, it hides later objects with an identical signature.
    const visible = candidates.filter(
      (c) =>
        c.core ||
        !candidates.some(
          (o) =>
            o.core && o.args.length === c.args.length && o.args.every((t, i) => t === c.args[i]),
        ),
    );
    // PostgreSQL resolves one concrete type per argument, so each possible combination is
    // resolved on its own; past a bound, the combinations are resolved jointly.
    let combos: CallArg[][] = [args];
    for (const [i, a] of args.entries())
      if (Array.isArray(a.ty) && a.ty.length > 1 && combos.length * a.ty.length <= 64)
        combos = combos.flatMap((combo) =>
          (a.ty as number[]).map((oid) => combo.map((c, j) => (j === i ? { ...c, ty: [oid] } : c))),
        );
    const results: Ty[] = [];
    const params: number[][] = [];
    for (const combo of combos) {
      const exact = this.exact(visible, combo, operator);
      const remaining = exact ? [exact] : visible.filter((c) => !this.excluded(c, combo));
      if (!remaining.length) continue;
      for (const r of remaining) {
        this.admit(r, combo, name, operator);
        results.push(this.resultOf(r, combo));
        params.push(combo.map((_, i) => this.param(r, i)));
      }
    }
    if (!results.length) hold(`Unresolved function or operator: ${name}`);
    const ty: Ty = results.some((t) => t === "top")
      ? "top"
      : [...new Set(results.flatMap((t) => t as number[]))];
    const json = args.some(
      (a) => a.opaque || (Array.isArray(a.ty) && a.ty.some((o) => this.jsonish(o))),
    );
    const keys = json ? args.flatMap((a, i) => (a.key !== undefined ? [i] : [])) : [];
    const reduction = JSON_REDUCTIONS[name];
    const reduced = reduction === "type" || (reduction === "key" && keys.includes(1));
    return { ty, opaque: !reduced && args.some((a) => a.opaque), keys, params };
  }

  private admit(r: Routine, args: CallArg[], name: string, operator: boolean): void {
    if (!r.core) hold(`Custom function or operator needs manual review: ${name}`);
    if (operator)
      this.implAllowed(
        r.code,
        `Custom operator needs manual review: ${name}`,
        this.scalarOperator(r),
      );
    else {
      if (r.retset || !r.supportCore || !["f", "a", "w"].includes(r.kind))
        hold(`Function effects need manual review: ${name}`);
      this.effects(r.volatility, r.name);
    }
    const types = [...args.map((_, i) => this.param(r, i)), r.result];
    if (types.some((oid) => this.type(oid)?.kind !== "p" && this.system(oid)))
      hold(`System data needs manual review: ${name}`);
    this.coercions(args, r);
  }

  operator(name: string, args: CallArg[]): CallResult {
    const kind = args.length === 2 ? "b" : "l";
    return this.resolve(
      this.cat.operators.filter((o) => o.name === name && o.kind === kind),
      args,
      name,
      true,
    );
  }

  // A parser label such as aggr_func does not prove the object is an aggregate, so every
  // kind competes. A pg_catalog qualifier narrows the schema only, not the ownership.
  func(name: string, args: CallArg[], qualified: boolean): CallResult {
    const argc = args.length;
    const candidates = this.cat.functions.filter(
      (f) =>
        f.name === name &&
        (!qualified || f.schema === "pg_catalog") &&
        (argc === f.nargs ||
          (argc < f.nargs && argc >= f.nargs - f.ndefaults) ||
          (f.variadic !== 0 && argc >= f.nargs - 1)),
    );
    return this.resolve(candidates, args, name, false);
  }

  /** An explicit cast must reach a built-in value type through built-in conversions. */
  cast(arg: CallArg, target: string): CallResult {
    if (!this.cat.catalogFirst) hold("PostgreSQL catalog must come first in the search path");
    const oid = this.cat.targets.get(target);
    if (!oid) hold("Unresolved cast");
    const t = this.type(oid);
    if (!t || t.kind === "d" || !this.value(oid)) hold("Cast target needs manual review");
    const typmod = this.cat.casts.find((c) => c.source === oid && c.target === oid && c.func);
    if (typmod) this.implAllowed(typmod.func, "Custom cast needs manual review");
    if (arg.ty === "top") hold("Unresolved cast");
    if (arg.ty !== "unknown")
      for (const source of arg.ty) {
        if (!this.value(source)) hold("Cast source needs manual review");
        const chain = this.ancestors(source);
        if (chain.includes(oid)) continue;
        const path = this.cat.casts.find((c) => chain.includes(c.source) && c.target === oid);
        if (path?.func) this.implAllowed(path.func, "Custom cast needs manual review");
        else if (!path) {
          // Without a pg_cast entry, PostgreSQL only converts through text I/O to or from strings.
          const strings = [source, oid].some((o) =>
            this.ancestors(o).some((a) => this.type(a)?.category === "S"),
          );
          if (!strings) hold("Unresolved cast");
        }
      }
    return { ty: [oid], opaque: arg.opaque, keys: [], params: [] };
  }
}

// Runs before the catalog query and calls only qualified functions, so an unsafe search
// path is detected before any unqualified operator could resolve to custom code.
export const SEARCH_PATH_SQL =
  "SELECT pg_catalog.array_to_json(pg_catalog.current_schemas(true))::pg_catalog.text AS path";

export function catalogFirst(rows: Record<string, unknown>[]): boolean {
  if (rows.length !== 1 || typeof rows[0].path !== "string") return false;
  let path: unknown;
  try {
    path = JSON.parse(rows[0].path);
  } catch {
    return false;
  }
  if (!Array.isArray(path) || !path.every((s) => typeof s === "string")) return false;
  // The temporary schema is searched first for relations and types, never for routines.
  return path.find((s) => !s.startsWith("pg_temp_")) === "pg_catalog";
}
