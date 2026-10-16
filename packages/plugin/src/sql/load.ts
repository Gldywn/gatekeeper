import { stripExplain } from "./classify";
import { prepareSql } from "./identifiers";
import { identifierLiteral, preparePgSql } from "./pg/syntax";
import { parser } from "./sql-parser";

// The proposal is never planned before approval: the PostgreSQL planner evaluates
// IMMUTABLE and STABLE functions, and EXPLAIN takes the statement's locks.

type Node = Record<string, unknown>;

export type Segment = string | { code: string };
export type Line = Segment[];

export interface Rel {
  schema: string | null;
  table: string;
}

// What the host learned about one relation. null always means unknown, never empty.
export interface RelFacts {
  rows: number | null;
  kind?: "view" | "foreign";
  rls: boolean | null;
  // Classic inheritance: a parent's key does not constrain its children's rows.
  inherited: boolean;
  // Every column that appears in any index, at any position.
  indexed: Set<string> | null;
  primaryKey: string[] | null;
  columns: string[] | null;
}

export type Facts = Map<string, RelFacts>;

export interface LoadResult {
  lines: Line[];
  notes: Line[];
  estimates: { table: string; rows: number }[];
  heavy: boolean;
  // False when part of the check could not run; Auto mode then holds the query.
  complete: boolean;
}

export const LARGE_ROWS = 1_000_000;
const PREVIEW_LIMIT = 1000;
const MAX_BLOCKS = 64;
const MAX_DEPTH = 8;
export const MAX_RELATIONS = 16;

export const relKey = (r: Rel): string => `${r.schema ?? ""}\u0000${r.table}`;
const code = (value: string): Segment => ({ code: value });

interface Source {
  alias: string;
  // Absent for derived tables, CTE references and table functions: no estimate of their own.
  rel?: Rel;
  joinedBy: "first" | "comma" | "cross" | "on" | "using";
}

interface Block {
  sources: Source[];
  where: unknown;
  ons: unknown[];
  noWhere: boolean;
  limited: boolean;
  preview: boolean;
}

interface Write {
  op: "update" | "delete";
  target: number;
  block: Block;
}

interface Lock {
  rel?: Rel;
  line: (t: string) => Line;
  hint: string;
}

export interface LoadPlan {
  dialect: string;
  blocks: Block[];
  writes: Write[];
  locks: Lock[];
  hints: string[];
  relations: Rel[];
  // False when part of the statement could not be read or is not modelled.
  covered: boolean;
}

function node(value: unknown): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function label(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (node(value)) return label(value.expr ?? value.value);
  return null;
}

class Incomplete extends Error {}

function conjuncts(expr: unknown): unknown[] {
  if (node(expr) && expr.type === "binary_expr" && String(expr.operator).toUpperCase() === "AND")
    return [...conjuncts(expr.left), ...conjuncts(expr.right)];
  return expr == null ? [] : [expr];
}

// A nested statement is a block of its own: expression walks stop there, so a correlated
// reference never counts as a filter on the enclosing query.
function isStatement(value: unknown): value is Node & { ast: Node } {
  return node(value) && node(value.ast);
}

function visitExpr(expr: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(expr)) {
    for (const item of expr) visitExpr(item, visit);
    return;
  }
  if (!node(expr) || isStatement(expr)) return;
  visit(expr);
  for (const value of Object.values(expr)) visitExpr(value, visit);
}

function columnRefs(expr: unknown): { table: string | null; column: string }[] {
  const refs: { table: string | null; column: string }[] = [];
  visitExpr(expr, (n) => {
    if (n.type !== "column_ref") return;
    const column = label(n.column);
    if (column && column !== "*") refs.push({ table: label(n.table), column });
  });
  return refs;
}

const LITERALS = new Set([
  "number",
  "single_quote_string",
  "double_quote_string",
  "string",
  "bool",
  "boolean",
  "natural_string",
  "hex_string",
  "full_hex_string",
  "bit_string",
]);

// Only a comparison between two sides links two sources; a column named inside a CASE
// branch or an OR operand proves nothing about how their rows pair up.
const COMPARISONS = new Set(["=", "<>", "!=", "<", ">", "<=", ">=", "LIKE", "ILIKE"]);

function literal(expr: unknown): boolean {
  if (!node(expr)) return false;
  if (expr.type === "cast") return literal(expr.expr);
  return LITERALS.has(String(expr.type));
}

// WHERE TRUE or WHERE 1 = 1 restricts nothing.
function tautology(expr: unknown): boolean {
  if (!node(expr)) return false;
  if ((expr.type === "bool" || expr.type === "boolean") && expr.value === true) return true;
  return (
    expr.type === "binary_expr" &&
    expr.operator === "=" &&
    literal(expr.left) &&
    literal(expr.right) &&
    JSON.stringify(expr.left) === JSON.stringify(expr.right)
  );
}

function aggregates(columns: unknown): boolean {
  let found = false;
  visitExpr(columns, (n) => {
    if (n.type === "aggr_func" || n.type === "window_func" || n.over != null) found = true;
  });
  return found;
}

function distinct(value: unknown): boolean {
  return typeof value === "string" ? value !== "" : node(value) && value.type != null;
}

function limitParts(limit: unknown): { count?: number; offset: boolean } {
  if (!node(limit) || !Array.isArray(limit.value) || !limit.value.length) return { offset: false };
  const sep = String(limit.seperator ?? "").toLowerCase();
  const values = limit.value.map((v) => (node(v) && v.type === "number" ? Number(v.value) : NaN));
  if (sep === ",") return { count: values[1], offset: true };
  return { count: values[0], offset: sep === "offset" || values.length > 1 };
}

const INDEX_HINT = "CREATE INDEX without CONCURRENTLY blocks writes on the table during the build.";
const REINDEX_HINT = "REINDEX without CONCURRENTLY blocks writes on the table.";
const ALTER_HINT = "ALTER TABLE may lock and rewrite the table.";
const REWRITE_HINT = "VACUUM FULL and CLUSTER lock and rewrite the table.";
const REFRESH_HINT = "REFRESH MATERIALIZED VIEW without CONCURRENTLY blocks reads of the view.";
const LOCK_HINT = "LOCK TABLE holds an explicit lock on the table.";

class Walker {
  readonly blocks: Block[] = [];
  readonly writes: Write[] = [];
  readonly locks: Lock[] = [];
  covered = true;

  statement(ast: unknown, ctes: Set<string>, depth: number): void {
    if (depth > MAX_DEPTH || this.blocks.length > MAX_BLOCKS) throw new Incomplete();
    if (!node(ast)) return;
    const scope = this.ctes(ast.with, ctes, depth);
    switch (ast.type) {
      case "select":
        this.select(ast, scope, depth);
        return;
      case "update":
      case "delete":
        this.write(ast, scope, depth);
        return;
      case "insert":
      case "replace":
        if (node(ast.values) && ast.values.type === "select")
          this.statement(ast.values, scope, depth + 1);
        return;
      case "create":
        this.create(ast, scope, depth);
        return;
      case "alter":
        this.lock(ast.table, (t) => ["ALTER TABLE may lock and rewrite ", code(t)], ALTER_HINT);
        return;
      case "lock":
        for (const item of Array.isArray(ast.tables) ? ast.tables : [])
          this.lock(
            node(item) ? item.table : null,
            (t) => ["LOCK TABLE holds an explicit lock on ", code(t)],
            LOCK_HINT,
          );
        return;
      default:
        // Not modelled, so not checked: never an all-clear.
        this.covered = false;
        return;
    }
  }

  private ctes(clause: unknown, outer: Set<string>, depth: number): Set<string> {
    if (!Array.isArray(clause)) return outer;
    const scope = new Set(outer);
    for (const cte of clause) {
      if (!node(cte)) throw new Incomplete();
      const name = label(cte.name);
      if (name) scope.add(name);
      // PostgreSQL emits the body directly, MySQL keeps it in a statement wrapper.
      this.statement(isStatement(cte.stmt) ? cte.stmt.ast : cte.stmt, scope, depth + 1);
    }
    return scope;
  }

  private create(ast: Node, ctes: Set<string>, depth: number): void {
    const keyword = String(ast.keyword ?? "").toLowerCase();
    if (keyword === "index" && !ast.concurrently)
      this.lock(
        ast.table,
        (t) => [
          "CREATE INDEX without CONCURRENTLY blocks writes on ",
          code(t),
          " during the build",
        ],
        INDEX_HINT,
      );
    if (keyword === "table" && node(ast.query_expr))
      this.statement(ast.query_expr, ctes, depth + 1);
  }

  private lock(table: unknown, line: (t: string) => Line, hint: string): void {
    const item = Array.isArray(table) ? table[0] : table;
    const name = node(item) ? label(item.table) : null;
    const schema = node(item) ? label(item.db) : null;
    this.locks.push({ rel: name ? { schema, table: name } : undefined, line, hint });
  }

  private source(item: unknown, index: number, ctes: Set<string>, depth: number): Source {
    if (!node(item)) throw new Incomplete();
    const join = String(item.join ?? "").toUpperCase();
    // A parenthesized set-operation branch comes back as a FROM item joined by "union", and
    // a comma after JOIN ... ON is swallowed into the ON as an expression list.
    if (join && !join.endsWith("JOIN")) throw new Incomplete();
    if (node(item.on) && item.on.type === "expr_list") throw new Incomplete();
    // A lateral item can read its siblings; how its rows pair up with them is not modelled.
    if (String(item.prefix ?? "").toUpperCase() === "LATERAL") this.covered = false;
    // The PostgreSQL grammar reads "a CROSS JOIN b" as a aliased "cross", then a bare JOIN.
    const joinedBy: Source["joinedBy"] =
      index === 0
        ? "first"
        : !join
          ? "comma"
          : item.using != null
            ? "using"
            : join.startsWith("CROSS") || item.on == null
              ? "cross"
              : "on";
    const alias = label(item.as);
    if (node(item.expr)) {
      if (isStatement(item.expr)) this.statement(item.expr.ast, ctes, depth + 1);
      else this.covered = false;
      return { alias: alias ?? `#${index}`, joinedBy };
    }
    const table = label(item.table);
    if (!table) {
      this.covered = false;
      return { alias: alias ?? `#${index}`, joinedBy };
    }
    const schema = label(item.db);
    if (schema === null && ctes.has(table)) return { alias: alias ?? table, joinedBy };
    return { alias: alias ?? table, rel: { schema, table }, joinedBy };
  }

  private block(
    from: unknown[],
    where: unknown,
    ctes: Set<string>,
    depth: number,
    extra: Partial<Block> = {},
  ): Block {
    const sources = from.map((item, i) => this.source(item, i, ctes, depth));
    for (const [i, s] of sources.entries())
      if (s.alias.toLowerCase() === "cross" && sources[i + 1]?.joinedBy === "cross")
        s.alias = s.rel?.table ?? s.alias;
    const ons = from.flatMap((item) => (node(item) && item.on != null ? [item.on] : []));
    const noWhere = where == null || tautology(where);
    const block: Block = {
      sources,
      where: noWhere ? null : where,
      ons,
      noWhere,
      limited: false,
      preview: false,
      ...extra,
    };
    this.blocks.push(block);
    this.nested([where, ...ons], ctes, depth);
    return block;
  }

  private nested(expr: unknown, ctes: Set<string>, depth: number): void {
    if (Array.isArray(expr)) {
      for (const item of expr) this.nested(item, ctes, depth);
      return;
    }
    if (!node(expr)) return;
    if (isStatement(expr)) {
      this.statement(expr.ast, ctes, depth + 1);
      return;
    }
    for (const value of Object.values(expr)) this.nested(value, ctes, depth);
  }

  private select(ast: Node, ctes: Set<string>, depth: number): void {
    const branch = ast._next != null || ast.set_op != null;
    const from = Array.isArray(ast.from) ? ast.from : [];
    const { count, offset } = limitParts(ast.limit);
    const preview =
      !branch &&
      from.length === 1 &&
      node(from[0]) &&
      from[0].join == null &&
      ast.where == null &&
      ast.groupby == null &&
      ast.having == null &&
      ast.orderby == null &&
      !distinct(ast.distinct) &&
      !aggregates(ast.columns) &&
      !offset &&
      count !== undefined &&
      Number.isInteger(count) &&
      count >= 0 &&
      count <= PREVIEW_LIMIT;
    this.block(from, ast.where, ctes, depth, { limited: count !== undefined, preview });
    this.nested([ast.columns, ast.having, ast.orderby], ctes, depth);
    if (node(ast._next)) this.statement(ast._next, ctes, depth + 1);
  }

  private write(ast: Node, ctes: Set<string>, depth: number): void {
    const op = ast.type as "update" | "delete";
    const table = Array.isArray(ast.table) ? ast.table : [];
    const from = Array.isArray(ast.from) ? ast.from : [];
    // A MySQL multi-table UPDATE or DELETE can write several targets; only one is modelled.
    if (table.length > 1) this.covered = false;
    let items: unknown[] = [...table, ...from];
    let target = 0;
    if (op === "delete") {
      // The target may be an alias of a source (MySQL "DELETE a FROM a JOIN b").
      items = from.length ? from : table;
      const name = node(table[0]) ? label(table[0].table) : null;
      target = items.findIndex(
        (item) => node(item) && (label(item.as) === name || label(item.table) === name),
      );
    }
    if (!items.length || target < 0) throw new Incomplete();
    const block = this.block(items, ast.where, ctes, depth);
    this.nested([ast.set, ast.returning], ctes, depth);
    this.writes.push({ op, target, block });
  }
}

const PG_NAME = `(?:"([^"]+)"|([a-z_][a-z0-9_$]*))`;
const PG_RELATION = new RegExp(`^${PG_NAME}(?:\\s*\\.\\s*${PG_NAME})?`);

// node-sql-parser does not parse these commands; the adapter has already dropped comments
// and folded case, so only their leading words are read.
function pgCommandLocks(sql: string): Lock[] {
  let prepared: ReturnType<typeof preparePgSql>;
  try {
    prepared = preparePgSql(sql);
  } catch {
    return [];
  }
  const text = prepared.sql.trim();
  const relation = (rest: string): Rel | undefined => {
    const m = PG_RELATION.exec(rest.trim());
    if (!m) return undefined;
    const first = prepared.name(m[1] ?? m[2]);
    const second = m[3] ?? m[4];
    return second
      ? { schema: first, table: prepared.name(second) }
      : { schema: null, table: first };
  };
  const reindex =
    /^reindex\s*(\([^)]*\))?\s*(table|index|schema|database|system)\s+(concurrently\s+)?/.exec(
      text,
    );
  if (reindex) {
    if (reindex[3] || /concurrently/.test(reindex[1] ?? "")) return [];
    // REINDEX INDEX names an index, which has no row estimate of its own.
    return [
      {
        rel: reindex[2] === "table" ? relation(text.slice(reindex[0].length)) : undefined,
        line: (t) => ["REINDEX without CONCURRENTLY blocks writes on ", code(t)],
        hint: REINDEX_HINT,
      },
    ];
  }
  const vacuum = /^vacuum\s*(\([^)]*\)|(?:(?:full|freeze|verbose|analyze|analyse)\b\s*)*)/.exec(
    text,
  );
  if (vacuum && /\bfull\b/.test(vacuum[0])) {
    return [
      {
        rel: relation(text.slice(vacuum[0].length)),
        line: (t) => ["VACUUM FULL locks and rewrites ", code(t)],
        hint: REWRITE_HINT,
      },
    ];
  }
  const cluster = /^cluster\s*(\([^)]*\)|verbose\s+)?/.exec(text);
  if (cluster) {
    return [
      {
        rel: relation(text.slice(cluster[0].length)),
        line: (t) => ["CLUSTER locks and rewrites ", code(t)],
        hint: REWRITE_HINT,
      },
    ];
  }
  const refresh = /^refresh\s+materialized\s+view\s+(concurrently\s+)?/.exec(text);
  if (refresh && !refresh[1]) {
    return [
      {
        rel: relation(text.slice(refresh[0].length)),
        line: (t) => ["REFRESH MATERIALIZED VIEW without CONCURRENTLY blocks reads of ", code(t)],
        hint: REFRESH_HINT,
      },
    ];
  }
  return [];
}

// "outer" is a correlated reference to an enclosing query; "unresolved" means the owner
// cannot be proven, which must never read as "unfiltered".
function bind(
  block: Block,
  ref: { table: string | null; column: string },
  facts: Facts | null,
): number | "outer" | "unresolved" {
  if (ref.table !== null) {
    const index = block.sources.findIndex((s) => s.alias === ref.table);
    return index < 0 ? "outer" : index;
  }
  if (block.sources.length === 1) return 0;
  if (!facts) return "unresolved";
  const owners: number[] = [];
  for (const [i, s] of block.sources.entries()) {
    const columns = s.rel ? facts.get(relKey(s.rel))?.columns : null;
    if (!columns) return "unresolved";
    if (columns.includes(ref.column)) owners.push(i);
  }
  return owners.length === 1 ? owners[0] : "unresolved";
}

interface Usage {
  referenced: boolean[];
  columns: Set<string>[];
  ambiguous: boolean;
  // Groups of sources no comparison links, each listed by member index.
  groups: number[][];
}

function usage(block: Block, facts: Facts | null): Usage {
  const n = block.sources.length;
  const referenced = new Array<boolean>(n).fill(false);
  const columns = Array.from({ length: n }, () => new Set<string>());
  let ambiguous = false;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i];
    return i;
  };
  const link = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const owner = (expr: unknown): number | null => {
    const owners = new Set<number>();
    for (const ref of columnRefs(expr)) {
      const at = bind(block, ref, facts);
      if (typeof at === "number") owners.add(at);
    }
    return owners.size === 1 ? [...owners][0] : null;
  };
  // USING compares the new item with the side it joins, the source just before it.
  for (const [i, s] of block.sources.entries()) if (s.joinedBy === "using") link(i, i - 1);
  for (const part of [...block.ons, block.where].flatMap(conjuncts)) {
    for (const ref of columnRefs(part)) {
      const at = bind(block, ref, facts);
      if (at === "unresolved") {
        ambiguous = true;
        referenced.fill(true);
      } else if (at !== "outer") {
        referenced[at] = true;
        columns[at].add(ref.column);
      }
    }
    if (
      node(part) &&
      part.type === "binary_expr" &&
      COMPARISONS.has(String(part.operator).toUpperCase())
    ) {
      const left = owner(part.left);
      const right = owner(part.right);
      if (left !== null && right !== null && left !== right) link(left, right);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  return { referenced, columns, ambiguous, groups: [...groups.values()] };
}

// Reads the SQL text only. Never throws: what it cannot read leaves covered false.
export function planLoad(sql: string, dialect: string): LoadPlan {
  const plan: LoadPlan = {
    dialect,
    blocks: [],
    writes: [],
    locks: [],
    hints: [],
    relations: [],
    covered: true,
  };
  const explain = stripExplain(sql);
  // A plain EXPLAIN only plans the statement it wraps; EXPLAIN ANALYZE runs it.
  if (explain && !explain.analyze) return plan;
  const text = explain ? explain.inner : sql;
  const walker = new Walker();
  try {
    const input = prepareSql(text, dialect);
    const ast = input.restoreAst(parser.astify(input.sql, { database: dialect }));
    const statements = Array.isArray(ast) ? ast : [ast];
    if (statements.length !== 1) throw new Incomplete();
    walker.statement(statements[0], new Set(), 0);
    plan.covered = walker.covered;
  } catch {
    plan.covered = false;
  }
  if (dialect === "postgresql" && !walker.locks.length) walker.locks.push(...pgCommandLocks(text));
  if (dialect !== "postgresql") walker.locks.length = 0;
  plan.blocks = walker.blocks;
  plan.writes = walker.writes;
  plan.locks = walker.locks;
  const seen = new Map<string, Rel>();
  for (const b of plan.blocks) for (const s of b.sources) if (s.rel) seen.set(relKey(s.rel), s.rel);
  for (const l of plan.locks) if (l.rel) seen.set(relKey(l.rel), l.rel);
  plan.relations = [...seen.values()];
  if (plan.relations.length > MAX_RELATIONS) plan.covered = false;
  // Computed before any catalog fact exists, so a hint never tells the agent about the data.
  plan.hints = hintsFor(plan);
  return plan;
}

// The first group holding a comma-joined source, against the group of the first source: a
// missing join condition is a bug at any size, while an explicit CROSS JOIN is intended.
function unlinkedPair(b: Block, u: Usage): { a: Source; c: Source; comma: boolean } | null {
  if (u.groups.length < 2) return null;
  const firsts = u.groups.map((g) => g[0]);
  const comma = firsts.slice(1).find((i) => b.sources[i].joinedBy === "comma");
  const other = comma ?? firsts[1];
  return { a: b.sources[firsts[0]], c: b.sources[other], comma: comma !== undefined };
}

function hintsFor(plan: LoadPlan): string[] {
  const hints = new Set<string>();
  const writeBlocks = new Set(plan.writes.map((w) => w.block));
  for (const w of plan.writes)
    if (w.block.noWhere) hints.add(`The ${w.op.toUpperCase()} has no WHERE clause.`);
  for (const b of plan.blocks) {
    if (!writeBlocks.has(b) && b.noWhere && !b.preview && b.sources.some((s) => s.rel))
      hints.add("The query reads a table without a WHERE clause.");
    const u = usage(b, null);
    const pair = u.ambiguous ? null : unlinkedPair(b, u);
    if (pair?.comma) hints.add(`No join condition links ${pair.a.alias} and ${pair.c.alias}.`);
  }
  for (const l of plan.locks) hints.add(l.hint);
  return [...hints];
}

// The operator's note first, then the SQL-only hints; undefined when there is nothing.
export function agentMessage(prefix: string | undefined, hints: string[]): string | undefined {
  const text = [prefix?.trim(), ...hints].filter(Boolean).join(" ");
  return text || undefined;
}

export type Pending = "pending" | "timeout" | "unavailable" | "skipped";

// "pending" shows the SQL-only findings while statistics load; "timeout" and "unavailable"
// settle without them.
export function checkLoad(plan: LoadPlan, facts: Facts | Pending): LoadResult {
  const notes: Line[] = [];
  const named: Rel[] = [];
  const known = typeof facts === "string" ? null : facts;
  const sizeAware = plan.dialect === "postgresql";
  const factsOf = (rel?: Rel) => (rel && known ? known.get(relKey(rel)) : undefined);
  const noted = new Set<string>();
  // A size rule fires only on a known large estimate; an unknown one becomes a note.
  const large = (rel: Rel | undefined): boolean => {
    if (!rel || !sizeAware || !known) return false;
    const f = factsOf(rel);
    if (f && f.rows !== null) return f.rows >= LARGE_ROWS;
    if (!noted.has(relKey(rel))) {
      noted.add(relKey(rel));
      notes.push([
        code(rel.table),
        f?.kind === "view"
          ? " is a view with no row estimate"
          : f?.kind === "foreign"
            ? " is a foreign table with no row estimate"
            : " has no row estimate yet",
      ]);
    }
    return false;
  };
  const name = (rel: Rel): string => {
    named.push(rel);
    return rel.table;
  };
  let indexesMissing = false;
  let unbound = false;

  const rowsChanged: Line[] = [];
  const scans: Line[] = [];
  const joins: Line[] = [];
  const locks: Line[] = [];
  const writeOf = new Map(plan.writes.map((w) => [w.block, w]));

  for (const w of plan.writes) {
    const target = w.block.sources[w.target]?.rel;
    if (!target) continue;
    // Every row only when nothing else in the statement can limit the target.
    if (w.block.noWhere && w.block.sources.length === 1) {
      rowsChanged.push(
        w.op === "update"
          ? ["UPDATE without WHERE changes every row of ", code(name(target))]
          : ["DELETE without WHERE removes every row of ", code(name(target))],
      );
      continue;
    }
    if (!large(target)) continue;
    const f = factsOf(target);
    if (f?.primaryKey == null) {
      indexesMissing = true;
      continue;
    }
    const pinned = new Set<string>();
    for (const part of conjuncts(w.block.where)) {
      if (!node(part) || part.type !== "binary_expr") continue;
      const op = String(part.operator).toUpperCase();
      const ref = node(part.left) && part.left.type === "column_ref" ? part.left : null;
      const list = node(part.right) && Array.isArray(part.right.value) ? part.right.value : null;
      const fixed =
        (op === "=" && literal(part.right)) ||
        (op === "IN" && list !== null && list.length > 0 && list.every(literal));
      const column = ref ? label(ref.column) : null;
      if (
        column &&
        fixed &&
        bind(w.block, { table: label(ref?.table), column }, known) === w.target
      )
        pinned.add(column);
    }
    const key = f.primaryKey;
    if (f.inherited || !key.length || !key.every((c) => pinned.has(c)))
      rowsChanged.push(
        w.op === "update"
          ? [
              "UPDATE is not limited to primary key values and may change every row of ",
              code(name(target)),
            ]
          : [
              "DELETE is not limited to primary key values and may remove every row of ",
              code(name(target)),
            ],
      );
  }

  for (const b of plan.blocks) {
    const write = writeOf.get(b);
    const u = usage(b, known);
    if (u.ambiguous && b.sources.some((s) => s.rel)) unbound = true;
    for (const [i, s] of b.sources.entries()) {
      if (!s.rel) continue;
      const f = factsOf(s.rel);
      if (!u.referenced[i]) {
        // The rows-changed line already speaks for an unfiltered write target.
        if (write?.target === i) continue;
        if (b.preview && f && f.rows !== null && !f.kind && f.rls === false) continue;
        if (!large(s.rel)) continue;
        scans.push(
          b.sources.length === 1 && b.noWhere
            ? ["Reads every row of ", code(name(s.rel)), " without a ", code("WHERE"), " clause"]
            : ["Reads every row of ", code(name(s.rel)), " since no condition filters it"],
        );
        continue;
      }
      if (u.ambiguous || !large(s.rel)) continue;
      if (f?.indexed == null) {
        indexesMissing = true;
        continue;
      }
      const indexed = f.indexed;
      const cols = [...u.columns[i]];
      if (!cols.length || cols.some((c) => indexed.has(c))) continue;
      const line: Line = ["Filter on "];
      cols.forEach((c, k) => {
        if (k) line.push(", ");
        line.push(code(c));
      });
      line.push(" uses no index and may scan all of ", code(name(s.rel)));
      if (b.limited) line.push(" despite the ", code("LIMIT"));
      scans.push(line);
    }
    const pair = u.ambiguous ? null : unlinkedPair(b, u);
    if (!pair) continue;
    // An explicit CROSS JOIN is flagged only when every group's size is known to be large together.
    const size = (group: number[]) => {
      const rows = group.map((i) => {
        const rel = b.sources[i].rel;
        return rel ? factsOf(rel)?.rows : null;
      });
      return rows.some((r) => r == null) ? null : Math.max(...(rows as number[]));
    };
    const sizes = u.groups.map(size);
    const product = sizes.some((s) => s === null)
      ? null
      : (sizes as number[]).reduce((p, s) => p * s, 1);
    if (!pair.comma && (product === null || product < LARGE_ROWS)) continue;
    for (const s of [pair.a, pair.c]) if (s.rel) name(s.rel);
    joins.push(
      pair.comma
        ? [
            "Missing join condition pairs every row of ",
            code(pair.a.alias),
            " with every row of ",
            code(pair.c.alias),
          ]
        : [
            "CROSS JOIN pairs every row of ",
            code(pair.a.alias),
            " with every row of ",
            code(pair.c.alias),
          ],
    );
  }

  for (const l of plan.locks) {
    if (!l.rel)
      locks.push(l.line("the tables it covers").map((s) => (typeof s === "string" ? s : s.code)));
    else if (large(l.rel)) locks.push(l.line(name(l.rel)));
  }

  if (unbound || facts === "skipped") notes.push(["Part of this query could not be checked"]);
  if (indexesMissing) notes.push(["Index lists require Beekeeper 5.5 or later"]);
  if (facts === "timeout") notes.push(["Statistics did not return within 5 seconds"]);
  if (facts === "unavailable") notes.push(["Statistics are unavailable on this connection"]);

  const estimates: { table: string; rows: number }[] = [];
  const shown = new Set<string>();
  for (const rel of named) {
    const rows = factsOf(rel)?.rows;
    if (rows == null || shown.has(relKey(rel))) continue;
    shown.add(relKey(rel));
    estimates.push({ table: rel.table, rows });
  }
  const lines = [...rowsChanged, ...scans, ...joins, ...locks];
  const statsSkipped = sizeAware && plan.relations.length > 0 && typeof facts === "string";
  return {
    lines,
    notes: facts === "pending" ? [] : notes,
    estimates,
    heavy: lines.length > 0,
    complete: plan.covered && notes.length === 0 && !statsSkipped,
  };
}

const MAX_TREE_DEPTH = 8;

// Reads pg_class, pg_inherits and the statistics counters only: none of them locks a user
// table (pg_partition_tree would). Run it after the search path check, like catalog.ts.
export function loadStatsSql(rels: Rel[]): string {
  if (!rels.length) throw new Error("No relation to estimate");
  const wanted = rels
    .map(
      (r, i) =>
        `(${i}, ${r.schema === null ? "NULL::pg_catalog.text" : identifierLiteral(r.schema)}, ${identifierLiteral(r.table)})`,
    )
    .join(", ");
  return `WITH RECURSIVE wanted(i, s, t) AS (VALUES ${wanted}),
target AS (
  SELECT w.i, CASE WHEN w.s IS NULL
    THEN pg_catalog.to_regclass(pg_catalog.quote_ident(w.t))::pg_catalog.oid
    ELSE (SELECT c.oid FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = w.s AND c.relname = w.t) END AS oid
  FROM wanted w),
tree(i, oid, depth) AS (
  SELECT t.i, t.oid, 0 FROM target t WHERE t.oid IS NOT NULL
  UNION
  SELECT tree.i, h.inhrelid, tree.depth + 1 FROM pg_catalog.pg_inherits h
  JOIN tree ON h.inhparent = tree.oid WHERE tree.depth < ${MAX_TREE_DEPTH})
SELECT t.i, n.nspname AS schema, c.relkind::pg_catalog.text AS kind, c.relrowsecurity AS rls,
  (SELECT pg_catalog.json_agg(pg_catalog.json_build_array(k.relkind, k.reltuples,
     pg_catalog.pg_stat_get_live_tuples(k.oid)))::pg_catalog.text
   FROM (SELECT DISTINCT tr.oid FROM tree tr WHERE tr.i = t.i LIMIT 4097) d
   JOIN pg_catalog.pg_class k ON k.oid = d.oid) AS parts,
  EXISTS (SELECT 1 FROM tree tr JOIN pg_catalog.pg_inherits h ON h.inhparent = tr.oid
          WHERE tr.i = t.i AND tr.depth = ${MAX_TREE_DEPTH}) AS deeper,
  pg_catalog.current_setting('track_counts') AS track_counts
FROM target t
LEFT JOIN pg_catalog.pg_class c ON c.oid = t.oid
LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
ORDER BY t.i`;
}

export interface StatRow {
  schema: string | null;
  rows: number | null;
  kind?: "view" | "foreign";
  rls: boolean | null;
  inherited: boolean;
}

const NUMERIC = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

// Only real numbers count: null, "" and false must never read as zero rows.
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return typeof value === "string" && NUMERIC.test(value) ? Number(value) : null;
}

function bool(value: unknown): boolean | null {
  if (value === true || value === "t" || value === "true" || value === 1) return true;
  if (value === false || value === "f" || value === "false" || value === 0) return false;
  return null;
}

// Anything unexpected reads as unknown, never as small.
export function parseLoadStats(rels: Rel[], rows: Record<string, unknown>[]): StatRow[] | null {
  if (rows.length !== rels.length) return null;
  const out: StatRow[] = [];
  for (const [i, row] of rows.entries()) {
    if (num(row.i) !== i) return null;
    const kind = typeof row.kind === "string" ? row.kind : null;
    const schema = typeof row.schema === "string" ? row.schema : null;
    const rls = bool(row.rls);
    const unknown = { schema, rows: null, rls, inherited: false };
    if (kind === "v" || kind === "f") {
      out.push({ ...unknown, kind: kind === "v" ? "view" : "foreign" });
      continue;
    }
    let parts: unknown;
    try {
      parts = typeof row.parts === "string" ? JSON.parse(row.parts) : null;
    } catch {
      parts = null;
    }
    if (!kind || !Array.isArray(parts) || !parts.length || parts.length > 4096) {
      out.push(unknown);
      continue;
    }
    let total = 0;
    let missing = bool(row.deeper) !== false;
    const counting = row.track_counts === "on";
    for (const part of parts) {
      const [k, tuples, live] = Array.isArray(part) && part.length === 3 ? part : [];
      if (k === "p") continue;
      // Never analyzed reads -1 since PostgreSQL 14, and autovacuum leaves an empty or tiny
      // table that way for good: on a dev database, 275 of 390 tables. While statistics are
      // collected, the live counter is then the real figure, 0 included.
      const analyzed = num(tuples);
      const counted = num(live);
      const estimate =
        analyzed !== null && analyzed >= 0
          ? analyzed
          : counted !== null && (counted > 0 || counting)
            ? counted
            : null;
      if ((k !== "r" && k !== "m") || estimate === null) missing = true;
      else total += estimate;
    }
    // A known lower bound above the threshold is enough; below it, a gap means unknown.
    const rowsKnown = Number.isFinite(total) && (!missing || total >= LARGE_ROWS);
    out.push({
      schema,
      rows: rowsKnown ? Math.round(total) : null,
      rls,
      inherited: kind === "r" && parts.length > 1,
    });
  }
  return out;
}
