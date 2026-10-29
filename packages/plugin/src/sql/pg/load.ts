import {
  ALTER_HINT,
  type Block,
  type Condition,
  INDEX_HINT,
  Incomplete,
  type Line,
  LOCK_HINT,
  type LoadWalk,
  type Lock,
  MAX_BLOCKS,
  MAX_DEPTH,
  PREVIEW_LIMIT,
  REFRESH_HINT,
  REINDEX_HINT,
  REWRITE_HINT,
  type Ref,
  type Segment,
  type Source,
  unreadWalk,
  type Write,
} from "../load-plan";
import { hasOption } from "./classify";
import { readPg } from "./parse";

type Node = Record<string, unknown>;
type Ctes = Map<string, Block[]>;

function node(value: unknown): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// A wrapped node, { Kind: body }, as its kind and body.
function only(value: unknown): [string, Node] | null {
  if (!node(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 && node(value[keys[0]]) ? [keys[0], value[keys[0]] as Node] : null;
}

function strings(value: unknown): string[] {
  return list(value).flatMap((item) =>
    node(item) && node(item.String) && typeof item.String.sval === "string"
      ? [item.String.sval]
      : [],
  );
}

function conjuncts(expr: unknown): unknown[] {
  const bool = node(expr) ? expr.BoolExpr : null;
  if (node(bool) && bool.boolop === "AND_EXPR") return list(bool.args).flatMap(conjuncts);
  return expr == null ? [] : [expr];
}

function disjuncts(expr: unknown): unknown[] {
  const bool = node(expr) ? expr.BoolExpr : null;
  if (node(bool) && bool.boolop === "OR_EXPR") return list(bool.args).flatMap(disjuncts);
  return [expr];
}

// A nested statement is a block of its own: expression walks stop at a sublink's query, so a
// correlated reference never counts as a filter on the enclosing query.
function visitExpr(expr: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(expr)) {
    for (const item of expr) visitExpr(item, visit);
    return;
  }
  if (!node(expr)) return;
  visit(expr);
  for (const [key, value] of Object.entries(expr)) if (key !== "subselect") visitExpr(value, visit);
}

function columnRefs(expr: unknown): Ref[] {
  const refs: Ref[] = [];
  visitExpr(expr, (n) => {
    const fields = node(n.ColumnRef) ? list(n.ColumnRef.fields) : [];
    const names = strings(fields);
    // A star, or anything but plain names, names no column.
    if (!names.length || names.length !== fields.length) return;
    refs.push({ table: names.length > 1 ? names[names.length - 2] : null, column: names.at(-1)! });
  });
  return refs;
}

function condition(part: unknown): Condition {
  return { refs: columnRefs(part), branches: disjuncts(part).map(columnRefs) };
}

function constant(expr: unknown): Node | null {
  return node(expr) && node(expr.A_Const) ? expr.A_Const : null;
}

// A constant other than NULL, bare or cast: it names no column and calls no function.
function constantExpr(expr: unknown): Node | null {
  if (!node(expr)) return null;
  if (node(expr.A_Const)) return expr.A_Const.isnull === true ? null : expr;
  return node(expr.TypeCast) && constantExpr(expr.TypeCast.arg) ? expr : null;
}

function constantSides(expr: unknown): [Node, Node] | null {
  const e = node(expr) ? expr.A_Expr : null;
  if (!node(e) || e.kind !== "AEXPR_OP" || strings(e.name).join(".") !== "=") return null;
  const [a, b] = [constantExpr(e.lexpr), constantExpr(e.rexpr)];
  return a && b ? [a, b] : null;
}

const spelled = (n: Node) =>
  JSON.stringify(n, (key, value) => (key === "location" ? undefined : value));

// An untyped number's exact value in one spelling, so 1.0 and 1.00 read alike. protobuf drops a
// zero integer's value; an exponent stays unknown.
function numeric(n: Node): string | null {
  const c = constant(n);
  const text = node(c?.ival) ? String(c.ival.ival ?? 0) : node(c?.fval) ? String(c.fval.fval) : "";
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!text || !m) return null;
  const whole = m[2].replace(/^0+/, "");
  const fraction = (m[3] ?? "").replace(/0+$/, "");
  if (!whole && !fraction) return "0";
  return `${m[1]}${whole || "0"}${fraction ? `.${fraction}` : ""}`;
}

function boolean(n: Node): string | null {
  const c = constant(n);
  return c && node(c.boolval) ? String(c.boolval.boolval === true) : null;
}

// WHERE TRUE, or a constant compared with itself (1 = 1, 1.0 = 1.00): restricts nothing.
function tautology(expr: unknown): boolean {
  const c = constant(expr);
  if (c) return node(c.boolval) && c.boolval.boolval === true;
  const sides = constantSides(expr);
  if (!sides) return false;
  const [a, b] = sides;
  return spelled(a) === spelled(b) || (numeric(a) !== null && numeric(a) === numeric(b));
}

// WHERE FALSE, or two different untyped numbers or booleans: reads nothing. A cast, a string
// ('1' = 1, 'true' = true) or two spellings a collation may equate prove nothing.
function contradiction(expr: unknown): boolean {
  const c = constant(expr);
  if (c) return node(c.boolval) && c.boolval.boolval !== true;
  const sides = constantSides(expr);
  if (!sides) return false;
  const [a, b] = sides;
  const differ = (x: string | null, y: string | null) => x !== null && y !== null && x !== y;
  return differ(numeric(a), numeric(b)) || differ(boolean(a), boolean(b));
}

function integer(expr: unknown): number | undefined {
  const c = constant(expr);
  return c && node(c.ival) ? Number(c.ival.ival ?? 0) : undefined;
}

// ponytail: built-in aggregates by name (PostgreSQL 18, tables 9.62 to 9.65), so a custom
// aggregate called like a plain function is missed; resolving the call in the catalog would not.
// It decides only the load check's preview rule, whose alert can hold Auto, never what Auto reads.
const AGGREGATES = new Set([
  "any_value",
  "array_agg",
  "avg",
  "bit_and",
  "bit_or",
  "bit_xor",
  "bool_and",
  "bool_or",
  "count",
  "every",
  "json_agg",
  "jsonb_agg",
  "json_agg_strict",
  "jsonb_agg_strict",
  "json_object_agg",
  "jsonb_object_agg",
  "json_object_agg_strict",
  "jsonb_object_agg_strict",
  "json_object_agg_unique",
  "jsonb_object_agg_unique",
  "json_object_agg_unique_strict",
  "jsonb_object_agg_unique_strict",
  "max",
  "min",
  "range_agg",
  "range_intersect_agg",
  "string_agg",
  "sum",
  "xmlagg",
  "corr",
  "covar_pop",
  "covar_samp",
  "regr_avgx",
  "regr_avgy",
  "regr_count",
  "regr_intercept",
  "regr_r2",
  "regr_slope",
  "regr_sxx",
  "regr_sxy",
  "regr_syy",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "variance",
  "var_pop",
  "var_samp",
  "mode",
  "percentile_cont",
  "percentile_disc",
  "rank",
  "dense_rank",
  "percent_rank",
  "cume_dist",
]);

function builtinName(call: Node): string | null {
  const names = strings(call.funcname);
  if (names.length === 2 && names[0] !== "pg_catalog") return null;
  return names.length === 1 || names.length === 2 ? names.at(-1)! : null;
}

// Syntax only an aggregate or a window function takes.
function aggregateSyntax(call: Node): boolean {
  return (
    call.agg_star === true ||
    call.agg_distinct === true ||
    call.agg_within_group === true ||
    call.agg_filter != null ||
    call.over != null ||
    list(call.agg_order).length > 0
  );
}

function aggregates(targets: unknown): boolean {
  let found = false;
  visitExpr(targets, (n) => {
    if (node(n.JsonArrayAgg) || node(n.JsonObjectAgg) || node(n.GroupingFunc)) found = true;
    const call = node(n.FuncCall) ? n.FuncCall : null;
    if (call && (aggregateSyntax(call) || AGGREGATES.has(builtinName(call) ?? ""))) found = true;
  });
  return found;
}

// A plain min or max of one column, the only call an index can answer from its first entries.
function minMaxColumn(target: unknown): string | null {
  const res = node(target) && node(target.ResTarget) ? target.ResTarget : null;
  const call = node(res?.val) && node(res.val.FuncCall) ? res.val.FuncCall : null;
  if (!call || aggregateSyntax(call) || call.func_variadic === true) return null;
  if (!["min", "max"].includes(builtinName(call) ?? "")) return null;
  const args = list(call.args);
  const refs =
    args.length === 1 && node(args[0]) && node(args[0].ColumnRef) ? columnRefs(args) : [];
  return refs.length === 1 ? refs[0].column : null;
}

// LIMIT ALL is no limit; FETCH ... WITH TIES returns every row tied with the last, so its count
// caps nothing.
function limitParts(select: Node): { count?: number; offset: boolean; skip: number } {
  const all = constant(select.limitCount)?.isnull === true;
  const ties = select.limitOption === "LIMIT_OPTION_WITH_TIES";
  const count =
    select.limitCount == null || all
      ? undefined
      : ties
        ? Number.NaN
        : (integer(select.limitCount) ?? Number.NaN);
  const offset = select.limitOffset != null;
  return { count, offset, skip: offset ? (integer(select.limitOffset) ?? Number.NaN) : 0 };
}

// The first ORDER BY key, when it is a plain column.
function orderColumn(select: Node): Block["ordered"] {
  const orders = list(select.sortClause);
  const sort = node(orders[0]) && node(orders[0].SortBy) ? orders[0].SortBy : null;
  const refs = sort && node(sort.node) && node(sort.node.ColumnRef) ? columnRefs(sort.node) : [];
  return refs.length === 1 ? { table: refs[0].table, columns: [refs[0].column] } : undefined;
}

function indexOrder(
  select: Node,
  b: Block,
  count: number | undefined,
  skip: number,
): Block["indexOrder"] {
  if (
    !b.noWhere ||
    list(select.groupClause).length ||
    select.havingClause != null ||
    list(select.distinctClause).length
  )
    return undefined;
  const orders = list(select.sortClause);
  const first = orderColumn(select);
  if (first) {
    const small = count !== undefined && Number.isInteger(count) && count + skip <= PREVIEW_LIMIT;
    return small && !aggregates(select.targetList) ? first : undefined;
  }
  const targets = list(select.targetList);
  if (orders.length || b.sources.length !== 1 || skip || !targets.length) return undefined;
  const args = targets.map(minMaxColumn);
  return args.every((a): a is string => a !== null) ? { table: null, columns: args } : undefined;
}

// ponytail: counts every unqualified use of the name, shadowed ones included, so a CTE can read
// as referenced twice and lose its inlining; scoped counting would lift that.
function references(owner: Node, name: string): number {
  let count = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) visit(item);
    else if (node(value)) {
      const rv = value.RangeVar;
      if (node(rv) && rv.relname === name && rv.schemaname == null) count++;
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(owner);
  return count;
}

function relOf(value: unknown): { schema: string | null; table: string } | undefined {
  const rv = node(value) && node(value.RangeVar) ? value.RangeVar : value;
  if (!node(rv) || typeof rv.relname !== "string") return undefined;
  return { schema: typeof rv.schemaname === "string" ? rv.schemaname : null, table: rv.relname };
}

function aliasOf(item: Node): string | null {
  return node(item.alias) && typeof item.alias.aliasname === "string" ? item.alias.aliasname : null;
}

class Walker {
  readonly blocks: Block[] = [];
  readonly writes: Write[] = [];
  readonly locks: Lock[] = [];
  covered = true;

  private guard(depth: number): void {
    if (depth > MAX_DEPTH || this.blocks.length > MAX_BLOCKS) throw new Incomplete();
  }

  // The blocks of its own level, which a derived table or CTE exposes: not those of its sublinks.
  statement(wrapped: unknown, ctes: Ctes, depth: number): Block[] {
    this.guard(depth);
    const [kind, s] = only(wrapped) ?? ["", null];
    if (!s) return [];
    const scope = this.ctes(s.withClause, ctes, depth, s);
    switch (kind) {
      case "SelectStmt":
        return this.select(s, scope, depth);
      case "UpdateStmt":
      case "DeleteStmt":
        return [this.write(kind === "UpdateStmt" ? "update" : "delete", s, scope, depth)];
      case "InsertStmt":
        this.statement(s.selectStmt, scope, depth + 1);
        this.nested([s.onConflictClause, s.returningList], scope, depth);
        return [];
      case "CreateTableAsStmt":
        // WITH NO DATA defines the table without running the query.
        if (!(node(s.into) && s.into.skipData === true)) this.statement(s.query, scope, depth + 1);
        return [];
      case "CreateStmt":
      case "ViewStmt":
        return [];
      case "IndexStmt":
        if (s.concurrent !== true)
          this.lock(
            s.relation,
            (t) => ["CREATE INDEX without CONCURRENTLY blocks writes on ", t, " during the build"],
            INDEX_HINT,
          );
        return [];
      case "AlterTableStmt":
        // ALTER INDEX, VIEW or SEQUENCE share the node: only ALTER TABLE is judged.
        if (s.objtype === "OBJECT_TABLE")
          this.lock(s.relation, (t) => ["ALTER TABLE may lock and rewrite ", t], ALTER_HINT);
        else this.covered = false;
        return [];
      case "LockStmt":
        for (const rel of list(s.relations))
          this.lock(rel, (t) => ["LOCK TABLE holds an explicit lock on ", t], LOCK_HINT);
        return [];
      case "ExplainStmt":
        // A plain EXPLAIN only plans the statement it wraps; EXPLAIN ANALYZE runs it.
        if (hasOption(s.options, "analyze")) this.statement(s.query, scope, depth + 1);
        return [];
      default:
        this.maintenance(kind, s);
        return [];
    }
  }

  // Maintenance commands read and lock whole tables in ways the blocks do not model: their
  // locks are reported, the rest stays unchecked.
  private maintenance(kind: string, s: Node): void {
    this.covered = false;
    switch (kind) {
      case "VacuumStmt": {
        if (s.is_vacuumcmd !== true || !hasOption(s.options, "full")) return;
        const rels = list(s.rels).map((r) =>
          node(r) && node(r.VacuumRelation) ? r.VacuumRelation.relation : null,
        );
        for (const rel of rels.length ? rels : [null])
          this.lock(rel, (t) => ["VACUUM FULL locks and rewrites ", t], REWRITE_HINT);
        return;
      }
      case "ClusterStmt":
        this.lock(s.relation, (t) => ["CLUSTER locks and rewrites ", t], REWRITE_HINT);
        return;
      case "ReindexStmt":
        // REINDEX INDEX names an index, whose table and size are unknown here: no claim either way.
        if (hasOption(s.params, "concurrently") || s.kind === "REINDEX_OBJECT_INDEX") return;
        this.lock(
          s.kind === "REINDEX_OBJECT_TABLE" ? s.relation : null,
          (t) => ["REINDEX without CONCURRENTLY blocks writes on ", t],
          REINDEX_HINT,
        );
        return;
      case "RefreshMatViewStmt":
        if (s.concurrent !== true)
          this.lock(
            s.relation,
            (t) => ["REFRESH MATERIALIZED VIEW without CONCURRENTLY blocks reads of ", t],
            REFRESH_HINT,
          );
        return;
    }
  }

  // Without RECURSIVE a CTE body sees only the CTEs before it, and a name it reuses is a table;
  // with it, every body sees them all.
  private ctes(clause: unknown, outer: Ctes, depth: number, owner: Node): Ctes {
    if (!node(clause)) return outer;
    const scope = new Map(outer);
    const items = list(clause.ctes).map((item) => {
      const cte = node(item) && node(item.CommonTableExpr) ? item.CommonTableExpr : null;
      if (!cte || typeof cte.ctename !== "string") throw new Incomplete();
      return { name: cte.ctename, query: cte.ctequery, materialized: cte.ctematerialized };
    });
    const recursive = clause.recursive === true;
    if (recursive) for (const { name } of items) scope.set(name, []);
    for (const { name, query, materialized } of items) {
      const tops = this.statement(query, scope, depth + 1);
      // An outer filter reaches the body only when PostgreSQL inlines the CTE; otherwise the
      // body runs in full, so the reference exposes none of its blocks.
      // ponytail: a volatile function also stops the inlining; telling one needs the catalog.
      const inlined =
        !recursive &&
        (materialized === "CTEMaterializeNever" ||
          (materialized !== "CTEMaterializeAlways" && references(owner, name) <= 1));
      scope.set(name, inlined ? tops : []);
    }
    return scope;
  }

  private lock(relation: unknown, line: (t: Segment) => Line, hint: string): void {
    this.locks.push({ rel: relOf(relation), line, hint });
  }

  private from(items: unknown[], ctes: Ctes, depth: number): { sources: Source[]; ons: unknown[] } {
    const sources: Source[] = [];
    const ons: unknown[] = [];
    const add = (item: unknown, joinedBy: Source["joinedBy"], using?: string[]) => {
      const [kind, body] = only(item) ?? ["", null];
      if (!body) throw new Incomplete();
      if (kind !== "JoinExpr") {
        sources.push(this.source(kind, body, sources.length, joinedBy, using, ctes, depth));
        return;
      }
      // An aliased join hides the names inside it, as a derived table does, so it is read as one:
      // a block of its own the enclosing query filters or not through the alias.
      if (node(body.alias)) {
        this.guard(depth + 1);
        const unaliased = { JoinExpr: { ...body, alias: undefined } };
        const inner = this.block([unaliased], null, ctes, depth + 1);
        const alias = aliasOf(body) ?? `#${sources.length}`;
        sources.push({ alias, joinedBy, using, inner: [inner] });
        return;
      }
      // A join on the right nests one group inside another, which the flat list only approaches.
      if (only(body.rarg)?.[0] === "JoinExpr") this.covered = false;
      add(body.larg, joinedBy, using);
      if (body.quals != null) ons.push(body.quals);
      if (body.isNatural === true) add(body.rarg, "using", []);
      else if (body.usingClause != null) add(body.rarg, "using", strings(body.usingClause));
      else add(body.rarg, body.quals == null ? "cross" : "on");
    };
    for (const [i, item] of items.entries()) add(item, i === 0 ? "first" : "comma");
    return { sources, ons };
  }

  private source(
    kind: string,
    item: Node,
    index: number,
    joinedBy: Source["joinedBy"],
    using: string[] | undefined,
    ctes: Ctes,
    depth: number,
  ): Source {
    const alias = aliasOf(item);
    switch (kind) {
      case "RangeVar":
      case "RangeTableSample": {
        const rv = kind === "RangeVar" ? item : node(item.relation) ? item.relation.RangeVar : null;
        const rel = relOf(rv);
        if (!node(rv) || !rel) throw new Incomplete();
        // Renamed columns would bind filters to names the catalog does not know.
        if (node(rv.alias) && rv.alias.colnames != null) this.covered = false;
        const name = aliasOf(rv) ?? rel.table;
        if (rel.schema === null && ctes.has(rel.table))
          return { alias: name, joinedBy, using, inner: ctes.get(rel.table) };
        const sampled = kind === "RangeTableSample" && strings(item.method).at(-1) === "system";
        return { alias: name, rel, joinedBy, using, sampled };
      }
      case "RangeSubselect": {
        const lateral = item.lateral === true;
        if (lateral) this.covered = false;
        return {
          alias: alias ?? `#${index}`,
          joinedBy,
          using,
          reads: lateral ? null : undefined,
          inner: this.statement(item.subquery, ctes, depth + 1),
        };
      }
      case "RangeFunction": {
        // A table function's rows depend on its arguments, which nothing here sizes.
        this.covered = false;
        this.nested(item.functions, ctes, depth);
        const tables = columnRefs(item.functions).map((ref) => ref.table);
        const reads =
          item.lateral !== true && tables.every((t): t is string => t !== null) ? tables : null;
        return { alias: alias ?? `#${index}`, joinedBy, using, reads };
      }
      default:
        this.covered = false;
        return { alias: alias ?? `#${index}`, joinedBy, using, reads: null };
    }
  }

  private block(
    items: unknown[],
    where: unknown,
    ctes: Ctes,
    depth: number,
    extra: Partial<Block> = {},
  ): Block {
    const { sources, ons } = this.from(items, ctes, depth);
    const noWhere = where == null || tautology(where);
    const block: Block = {
      sources,
      conditions: [...ons, noWhere ? null : where].flatMap(conjuncts).map(condition),
      noWhere,
      empty: conjuncts(where).some(contradiction),
      limited: false,
      preview: false,
      filterable: true,
      streams: true,
      ...extra,
    };
    this.blocks.push(block);
    this.nested([where, ...ons], ctes, depth);
    return block;
  }

  // Walks the statements an expression holds: a sublink's query is a block of its own.
  private nested(expr: unknown, ctes: Ctes, depth: number): void {
    if (Array.isArray(expr)) {
      for (const item of expr) this.nested(item, ctes, depth);
      return;
    }
    if (!node(expr)) return;
    if (node(expr.SubLink)) {
      this.nested(expr.SubLink.testexpr, ctes, depth);
      this.statement(expr.SubLink.subselect, ctes, depth + 1);
      return;
    }
    for (const value of Object.values(expr)) this.nested(value, ctes, depth);
  }

  // Each side of a set operation is read under its own ORDER BY and LIMIT, never the
  // operation's, which apply to the combined rows.
  private select(s: Node, ctes: Ctes, depth: number): Block[] {
    this.guard(depth);
    if (s.op !== "SETOP_NONE") {
      const sides = [s.larg, s.rarg].flatMap((side) =>
        node(side)
          ? this.select(side, this.ctes(side.withClause, ctes, depth, side), depth + 1)
          : [],
      );
      this.nested([s.sortClause, s.limitCount, s.limitOffset], ctes, depth);
      // The operation's own LIMIT stops a filter on its rows, and removing duplicates, sorting or
      // skipping rows needs every side in full before an enclosing LIMIT can stop.
      const { count, offset } = limitParts(s);
      const dedups = s.op !== "SETOP_UNION" || s.all !== true;
      const sorted = list(s.sortClause).length > 0;
      // Otherwise its own small LIMIT stops each side as a preview would.
      const stops =
        !dedups &&
        !sorted &&
        !offset &&
        count !== undefined &&
        Number.isInteger(count) &&
        count >= 0 &&
        count <= PREVIEW_LIMIT;
      for (const side of sides) {
        if (count !== undefined || offset) side.filterable = false;
        if (dedups || offset || sorted) side.streams = false;
        side.ordered = undefined;
        if (count !== undefined) side.limited = true;
        if (stops && side.streams && side.noWhere && side.sources.length) side.preview = true;
      }
      return sides;
    }
    // A VALUES list reads no table, only the statements its rows may hold.
    if (list(s.valuesLists).length) {
      this.nested(s.valuesLists, ctes, depth);
      return [];
    }
    const from = list(s.fromClause);
    const { count, offset, skip } = limitParts(s);
    const grouped =
      list(s.groupClause).length > 0 ||
      s.havingClause != null ||
      list(s.distinctClause).length > 0 ||
      aggregates(s.targetList);
    const sorted = list(s.sortClause).length > 0;
    // A small LIMIT with no WHERE, order or aggregate lets PostgreSQL stop early, joins included.
    const preview =
      from.length > 0 &&
      (s.whereClause == null || tautology(s.whereClause)) &&
      !grouped &&
      !sorted &&
      !offset &&
      count !== undefined &&
      Number.isInteger(count) &&
      count >= 0 &&
      count <= PREVIEW_LIMIT;
    const block = this.block(from, s.whereClause, ctes, depth, {
      limited: count !== undefined,
      preview,
      filterable: !grouped && !offset && count === undefined,
      streams: !grouped && !offset && !sorted,
    });
    block.indexOrder = indexOrder(s, block, count, skip);
    if (!grouped && !offset && sorted && block.noWhere) block.ordered = orderColumn(s);
    this.nested(
      [s.targetList, s.groupClause, s.havingClause, s.sortClause, s.limitCount, s.limitOffset],
      ctes,
      depth,
    );
    return [block];
  }

  private write(op: Write["op"], s: Node, ctes: Ctes, depth: number): Block {
    const others = list(op === "update" ? s.fromClause : s.usingClause);
    const block = this.block([{ RangeVar: s.relation }, ...others], s.whereClause, ctes, depth, {
      filterable: false,
      streams: false,
    });
    this.nested([s.targetList, s.returningList], ctes, depth);
    this.writes.push({ op, target: 0, block });
    return block;
  }
}

// Reads the statement with PostgreSQL's own grammar; what it cannot read stays uncovered.
export function loadPg(sql: string): LoadWalk {
  const read = readPg(sql);
  if (!read || read === "ambiguous") return unreadWalk();
  const statements = read.tree.stmts ?? [];
  if (statements.length !== 1) return unreadWalk();
  const walker = new Walker();
  try {
    walker.statement(statements[0].stmt, new Map(), 0);
  } catch {
    walker.covered = false;
  }
  return {
    blocks: walker.blocks,
    writes: walker.writes,
    locks: walker.locks,
    covered: walker.covered,
  };
}
