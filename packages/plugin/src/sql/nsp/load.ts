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
  type Segment,
  type Source,
  type Write,
} from "../load-plan";
import { parser } from "./parser";

type Node = Record<string, unknown>;

function node(value: unknown): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function label(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (node(value)) return label(value.expr ?? value.value);
  return null;
}

type Ctes = Map<string, Block[]>;

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

function disjuncts(expr: unknown): unknown[] {
  if (node(expr) && expr.type === "binary_expr" && String(expr.operator).toUpperCase() === "OR")
    return [...disjuncts(expr.left), ...disjuncts(expr.right)];
  return [expr];
}

function condition(part: unknown): Condition {
  return { refs: columnRefs(part), branches: disjuncts(part).map(columnRefs) };
}

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

function contradiction(expr: unknown): boolean {
  if (!node(expr)) return false;
  if ((expr.type === "bool" || expr.type === "boolean") && expr.value === false) return true;
  return (
    expr.type === "binary_expr" &&
    expr.operator === "=" &&
    literal(expr.left) &&
    literal(expr.right) &&
    node(expr.left) &&
    node(expr.right) &&
    expr.left.type === expr.right.type &&
    JSON.stringify(expr.left) !== JSON.stringify(expr.right)
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

function limitParts(limit: unknown): { count?: number; offset: boolean; skip: number } {
  if (!node(limit) || !Array.isArray(limit.value) || !limit.value.length)
    return { offset: false, skip: 0 };
  const sep = String(limit.seperator ?? "").toLowerCase();
  const values = limit.value.map((v) => (node(v) && v.type === "number" ? Number(v.value) : NaN));
  if (sep === ",") return { count: values[1], offset: true, skip: values[0] };
  const offset = sep === "offset" || values.length > 1;
  return { count: values[0], offset, skip: offset ? values[1] : 0 };
}

class Walker {
  readonly blocks: Block[] = [];
  readonly writes: Write[] = [];
  readonly locks: Lock[] = [];
  covered = true;

  statement(ast: unknown, ctes: Ctes, depth: number): void {
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
        // ALTER SEQUENCE, TYPE, VIEW or FUNCTION parse as "alter" too, without a table.
        if (ast.table)
          this.lock(ast.table, (t) => ["ALTER TABLE may lock and rewrite ", t], ALTER_HINT);
        else this.covered = false;
        return;
      case "lock":
        for (const item of Array.isArray(ast.tables) ? ast.tables : [])
          this.lock(
            node(item) ? item.table : null,
            (t) => ["LOCK TABLE holds an explicit lock on ", t],
            LOCK_HINT,
          );
        return;
      case "explain":
        // Only a plain EXPLAIN parses as one, and it only plans the statement it wraps.
        return;
      default:
        // Not modelled, so not checked: never an all-clear.
        this.covered = false;
        return;
    }
  }

  private ctes(clause: unknown, outer: Ctes, depth: number): Ctes {
    if (!Array.isArray(clause)) return outer;
    const scope = new Map(outer);
    for (const cte of clause) {
      if (!node(cte)) throw new Incomplete();
      const name = label(cte.name);
      // Set before the body so a recursive reference reads as the CTE, not as a table.
      if (name) scope.set(name, []);
      const before = this.blocks.length;
      // PostgreSQL emits the body directly, MySQL keeps it in a statement wrapper.
      this.statement(isStatement(cte.stmt) ? cte.stmt.ast : cte.stmt, scope, depth + 1);
      if (name) scope.set(name, this.blocks.slice(before));
    }
    return scope;
  }

  private create(ast: Node, ctes: Ctes, depth: number): void {
    const keyword = String(ast.keyword ?? "").toLowerCase();
    if (keyword === "index" && !ast.concurrently)
      this.lock(
        ast.table,
        (t) => ["CREATE INDEX without CONCURRENTLY blocks writes on ", t, " during the build"],
        INDEX_HINT,
      );
    if (keyword === "table" && node(ast.query_expr))
      this.statement(ast.query_expr, ctes, depth + 1);
  }

  private lock(table: unknown, line: (t: Segment) => Line, hint: string): void {
    const item = Array.isArray(table) ? table[0] : table;
    const name = node(item) ? label(item.table) : null;
    const schema = node(item) ? label(item.db) : null;
    this.locks.push({ rel: name ? { schema, table: name } : undefined, line, hint });
  }

  private source(item: unknown, index: number, ctes: Ctes, depth: number): Source {
    if (!node(item)) throw new Incomplete();
    const join = String(item.join ?? "").toUpperCase();
    // A parenthesized set-operation branch comes back as a FROM item joined by "union", and
    // a comma after JOIN ... ON is swallowed into the ON as an expression list.
    if (join && !join.endsWith("JOIN")) throw new Incomplete();
    if (node(item.on) && item.on.type === "expr_list") throw new Incomplete();
    // A lateral item can read its siblings; how its rows pair up with them is not modelled.
    const lateral = String(item.prefix ?? "").toUpperCase() === "LATERAL";
    if (lateral) this.covered = false;
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
    // A column list ("v(id, label)") comes back inside the alias string.
    const alias = label(item.as)?.replace(/\s*\([^()]*\)\s*$/, "") ?? null;
    const using = Array.isArray(item.using)
      ? item.using.map(label).filter((c): c is string => c !== null)
      : undefined;
    if (node(item.expr)) {
      const before = this.blocks.length;
      const statement = isStatement(item.expr);
      if (statement) this.statement(item.expr.ast, ctes, depth + 1);
      else this.covered = false;
      return {
        alias: alias ?? `#${index}`,
        joinedBy,
        using,
        reads: lateral
          ? null
          : statement || item.expr.type === "values"
            ? undefined
            : reads(item.expr),
        inner: this.blocks.slice(before),
      };
    }
    const table = label(item.table);
    if (!table) {
      this.covered = false;
      return { alias: alias ?? `#${index}`, joinedBy, using };
    }
    const schema = label(item.db);
    if (schema === null && ctes.has(table))
      return { alias: alias ?? table, joinedBy, using, inner: ctes.get(table) };
    const sample =
      node(item.tablesample) && node(item.tablesample.expr) ? item.tablesample.expr : null;
    const method =
      node(sample?.name) && Array.isArray(sample.name.name) ? sample.name.name[0] : null;
    const sampled = /^system$/i.test(label(method) ?? "");
    return { alias: alias ?? table, rel: { schema, table }, joinedBy, using, sampled };
  }

  private block(
    from: unknown[],
    where: unknown,
    ctes: Ctes,
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

  private nested(expr: unknown, ctes: Ctes, depth: number): void {
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

  private select(ast: Node, ctes: Ctes, depth: number): void {
    const branch = ast._next != null || ast.set_op != null;
    const from = Array.isArray(ast.from) ? ast.from : [];
    const { count, offset, skip } = limitParts(ast.limit);
    const grouped =
      ast.groupby != null ||
      ast.having != null ||
      distinct(ast.distinct) ||
      aggregates(ast.columns);
    // A small LIMIT with no WHERE, order or aggregate lets PostgreSQL stop early, joins included.
    const preview =
      !branch &&
      from.length > 0 &&
      (ast.where == null || tautology(ast.where)) &&
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
    const block = this.block(from, ast.where, ctes, depth, {
      limited: count !== undefined,
      preview,
      filterable: !grouped && !offset && count === undefined,
      streams: !grouped && !offset && ast.orderby == null,
    });
    if (!branch) block.indexOrder = indexOrder(ast, block, count, skip);
    this.nested([ast.columns, ast.having, ast.orderby], ctes, depth);
    if (node(ast._next)) this.statement(ast._next, ctes, depth + 1);
  }

  private write(ast: Node, ctes: Ctes, depth: number): void {
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
    const block = this.block(items, ast.where, ctes, depth, {
      filterable: false,
      streams: false,
    });
    this.nested([ast.set, ast.returning], ctes, depth);
    this.writes.push({ op, target, block });
  }
}

function indexOrder(
  ast: Node,
  b: Block,
  count: number | undefined,
  skip: number,
): Block["indexOrder"] {
  if (!b.noWhere || ast.groupby != null || ast.having != null || distinct(ast.distinct))
    return undefined;
  const orders = Array.isArray(ast.orderby) ? ast.orderby : [];
  const first = node(orders[0]) && node(orders[0].expr) ? orders[0].expr : null;
  if (first?.type === "column_ref") {
    const column = label(first.column);
    const small = count !== undefined && Number.isInteger(count) && count + skip <= PREVIEW_LIMIT;
    return small && column && !aggregates(ast.columns)
      ? { table: label(first.table), columns: [column] }
      : undefined;
  }
  if (orders.length || b.sources.length !== 1 || skip || !Array.isArray(ast.columns))
    return undefined;
  const args = ast.columns.map((c) => {
    const expr = node(c) && node(c.expr) ? c.expr : null;
    const arg = expr && node(expr.args) && node(expr.args.expr) ? expr.args.expr : null;
    // A window min/max is computed for every row.
    return expr?.type === "aggr_func" &&
      expr.over == null &&
      /^(min|max)$/i.test(String(expr.name)) &&
      arg?.type === "column_ref"
      ? label(arg.column)
      : null;
  });
  return args.length && args.every((a): a is string => a !== null)
    ? { table: null, columns: args }
    : undefined;
}

function reads(expr: unknown): string[] | null {
  const tables = columnRefs(expr).map((ref) => ref.table);
  return tables.every((t): t is string => t !== null) ? tables : null;
}

// Locks are PostgreSQL's commands and costs, so no other engine reports one.
export function loadNsp(sql: string, grammar: string): LoadWalk {
  const walker = new Walker();
  try {
    const ast = parser.astify(sql, { database: grammar });
    const statements = Array.isArray(ast) ? ast : [ast];
    if (statements.length !== 1) throw new Incomplete();
    walker.statement(statements[0], new Map(), 0);
  } catch {
    walker.covered = false;
  }
  return { blocks: walker.blocks, writes: walker.writes, locks: [], covered: walker.covered };
}
