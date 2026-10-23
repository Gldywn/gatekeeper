import type { EvaluationInput } from "@gatekeeper/shared";
import type { ParseResult, ScanToken } from "libpg-query";
import { deparseSync } from "pgsql-deparser";
import { sensitiveReference } from "../schema";
import {
  type CallArg,
  type CallResult,
  catalogSql,
  Hold,
  hold,
  parseCatalog,
  Resolver,
  T,
  type Ty,
  validIdentifier,
} from "./catalog";
import { readPg } from "./parse";

type Node = Record<string, unknown>;

export interface PgReadPlan {
  readonly tree: ParseResult;
  readonly relations: { schema: string; table: string }[];
  readonly operators: string[];
  readonly functions: string[];
  readonly types: string[];
}
export interface PgSnapshot {
  complete: boolean;
  reasons: string[];
  input?: EvaluationInput;
}

interface Val {
  ty: Ty;
  deps: Set<string>;
  opaque: boolean;
  /** Bare constant, kept to decide whether it is a JSON key. */
  literal?: Node;
}
interface Output {
  name: string;
  val: Val;
}
interface Source {
  alias: string;
  base?: number;
  columns?: Output[];
}
/** A FROM item as PostgreSQL exposes it: its relations, and the columns an unqualified name reaches. */
interface Operand {
  sources: Source[];
  columns(name: string): Val[];
  /** A USING join somewhere inside, whose merged keys reorder a star's columns. */
  merges: boolean;
}
interface Scope {
  /** Every relation by alias, joined ones included, for qualified names. */
  sources: Source[];
  /** The top-level FROM items, for unqualified names. */
  operands: Operand[];
  ctes: Map<string, Output[]>;
  parent?: Scope;
}

const JOINS = new Set(["JOIN_INNER", "JOIN_LEFT", "JOIN_RIGHT", "JOIN_FULL"]);
const CLOCK: Record<string, number> = {
  SVFOP_CURRENT_DATE: T.date,
  SVFOP_CURRENT_TIMESTAMP: T.timestamptz,
  SVFOP_CURRENT_TIMESTAMP_N: T.timestamptz,
  SVFOP_LOCALTIMESTAMP: T.timestamp,
  SVFOP_LOCALTIMESTAMP_N: T.timestamp,
  SVFOP_CURRENT_TIME: T.timetz,
  SVFOP_CURRENT_TIME_N: T.timetz,
  SVFOP_LOCALTIME: T.time,
  SVFOP_LOCALTIME_N: T.time,
};
// RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW, what a window without a frame clause gets.
const DEFAULT_FRAME = 1058;
const SET_OPERATIONS = new Set(["SETOP_UNION", "SETOP_INTERSECT", "SETOP_EXCEPT"]);
// The units EXTRACT accepts (PostgreSQL documentation, "EXTRACT, date_part").
const EXTRACT_FIELDS = new Set([
  "century",
  "day",
  "decade",
  "dow",
  "doy",
  "epoch",
  "hour",
  "isodow",
  "isoyear",
  "julian",
  "microseconds",
  "millennium",
  "milliseconds",
  "minute",
  "month",
  "quarter",
  "second",
  "timezone",
  "timezone_hour",
  "timezone_minute",
  "week",
  "year",
]);
const LIMITS = new Set(["LIMIT_OPTION_DEFAULT", "LIMIT_OPTION_COUNT"]);
// Scanner tokens whose spelling the analysis does not accept: a Unicode-escaped identifier or
// string (U&"..." and U&'...'), and an unquoted identifier holding non-ASCII letters, whose case
// folding depends on the server's encoding.
const IDENT = 258;
const UIDENT = 259;
const USCONST = 262;

function node(value: unknown): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Unknown keys can carry semantics the walker does not model, so they are refused. */
function keys(value: Node, allowed: string[]): void {
  for (const [key, content] of Object.entries(value))
    if (content != null && !allowed.includes(key)) hold("Unresolved SQL dependencies");
}
/** A wrapped node's kind and body: libpg_query wraps each node in its type name. */
function only(value: unknown): [string, Node] {
  if (!node(value)) hold("Unresolved SQL dependencies");
  const entries = Object.entries(value);
  if (entries.length !== 1 || !node(entries[0][1])) hold("Unresolved SQL dependencies");
  return entries[0] as [string, Node];
}
function list(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) hold("Unresolved SQL dependencies");
  return value;
}
function strings(value: unknown): string[] {
  return list(value).map((item) => {
    const sval = node(item) && node(item.String) ? item.String.sval : undefined;
    if (typeof sval !== "string") hold("Unresolved SQL dependencies");
    return sval;
  });
}
function union(...sets: Set<string>[]): Set<string> {
  return new Set(sets.flatMap((s) => [...s]));
}
function constant(value: unknown): Node | undefined {
  return node(value) && node(value.A_Const) ? value.A_Const : undefined;
}
function stringConstant(value: unknown): string | undefined {
  const c = constant(value);
  if (!c || !node(c.sval)) return undefined;
  return typeof c.sval.sval === "string" ? c.sval.sval : "";
}
function integerConstant(value: unknown): number | undefined {
  const c = constant(value);
  if (!c || !node(c.ival)) return undefined;
  // protobuf drops a zero ival, which arrives as an empty object.
  return typeof c.ival.ival === "number" ? c.ival.ival : 0;
}
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

class Walk {
  readonly relations: { schema: string; table: string }[] = [];
  readonly operators = new Set<string>();
  readonly functions = new Set<string>();
  readonly types = new Set<string>();
  /** Base column key to how the proposal uses it. */
  readonly usage = new Map<string, { output: boolean; control: boolean }>();
  /** Constants that carry a value, true when they stay visible as screened JSON keys. */
  readonly literals = new Map<Node, boolean>();
  /** The type a withheld number keeps once it becomes a parameter. */
  readonly numberTypes = new Map<Node, string>();
  /** Constants that are syntax rather than data: LIMIT counts, ordinals, field names, typmods. */
  readonly structural = new Set<Node>();
  occurrences = 0;
  readonly res?: Resolver;

  constructor(res?: Resolver) {
    this.res = res;
  }

  name(value: unknown): string {
    if (!validIdentifier(value)) hold("Unresolved source column");
    return value;
  }

  record(deps: Set<string>, role: "output" | "control"): void {
    for (const dep of deps) {
      const use = this.usage.get(dep) ?? { output: false, control: false };
      use[role] = true;
      this.usage.set(dep, use);
    }
  }

  val(ty: Ty, deps: Set<string>[] = [], opaque = false): Val {
    return { ty, deps: union(...deps), opaque };
  }

  select(
    ast: unknown,
    parent: Scope | undefined,
    depth: number,
  ): { outputs: Output[]; filter: Set<string> } {
    if (!node(ast) || depth > 8) hold("Unresolved SQL dependencies");
    if (ast.op !== "SETOP_NONE") return this.setOperation(ast, parent, depth);
    keys(ast, [
      "targetList",
      "fromClause",
      "whereClause",
      "groupClause",
      "havingClause",
      "sortClause",
      "limitCount",
      "limitOffset",
      "limitOption",
      "distinctClause",
      "withClause",
      "op",
    ]);
    const scope: Scope = { sources: [], operands: [], ctes: new Map(), parent };
    const filter = new Set<string>();
    const control = (v: Val) => {
      for (const dep of v.deps) filter.add(dep);
    };
    this.ctes(ast.withClause, scope, depth);
    const quals: unknown[] = [];
    for (const item of list(ast.fromClause))
      scope.operands.push(this.fromItem(item, scope, depth, quals, control));
    const targets = list(ast.targetList);
    if (!targets.length || targets.length > 64) hold("Explicit source columns are required");
    const aliases = new Map<string, Val>();
    const outputs: Output[] = [];
    for (const item of targets) {
      const [kind, target] = only(item);
      if (kind !== "ResTarget") hold("Unresolved SQL dependencies");
      keys(target, ["name", "val", "location"]);
      const expr = target.val;
      const ref = node(expr) && node(expr.ColumnRef) ? expr.ColumnRef : undefined;
      const last = ref ? list(ref.fields).at(-1) : undefined;
      if (ref && node(last) && "A_Star" in last) {
        outputs.push(...this.star(ref, scope));
        continue;
      }
      const val = this.expr(expr, scope, depth);
      let name = this.derivedName(expr);
      if (target.name != null) {
        name = this.name(target.name);
        if (aliases.has(name)) hold("Unsupported output alias");
        if (sensitiveReference(name) && stringConstant(expr) === undefined)
          hold(`Sensitive source or alias: ${name}`);
        aliases.set(name, val);
      }
      outputs.push({ name, val });
    }
    for (const qual of quals) control(this.condition(qual, scope, depth));
    if (ast.whereClause != null) control(this.condition(ast.whereClause, scope, depth));
    if (ast.havingClause != null) control(this.condition(ast.havingClause, scope, depth));
    const byOutput = (expr: unknown, preferAlias: boolean): Val | undefined => {
      const ordinal = integerConstant(expr);
      if (ordinal !== undefined) {
        this.structural.add(expr as Node);
        if (!this.res) return this.val("top");
        if (ordinal < 1 || ordinal > outputs.length) hold("Unresolved SQL dependencies");
        return outputs[ordinal - 1].val;
      }
      const column = node(expr) && node(expr.ColumnRef) ? list(expr.ColumnRef.fields) : [];
      const name = column.length === 1 ? strings(column)[0] : undefined;
      if (name !== undefined && aliases.has(name)) {
        if (preferAlias || !this.res) return aliases.get(name);
        // GROUP BY prefers an input column, ORDER BY and DISTINCT ON an output name.
        if (!this.lookup(scope, null, name, false)) return aliases.get(name);
      }
      return undefined;
    };
    for (const expr of list(ast.groupClause)) {
      const v = byOutput(expr, false) ?? this.expr(expr, scope, depth);
      control(v);
      this.res?.sortable(v.ty);
    }
    for (const order of list(ast.sortClause))
      control(this.order(order, scope, depth, (e) => byOutput(e, true)));
    const distinct = list(ast.distinctClause);
    if (distinct.length === 1 && node(distinct[0]) && !Object.keys(distinct[0]).length) {
      for (const o of outputs) this.res?.sortable(o.val.ty);
    } else
      for (const expr of distinct) {
        // DISTINCT ON keys pick which row of each group survives: they shape the result.
        const v = byOutput(expr, true) ?? this.expr(expr, scope, depth);
        control(v);
        this.res?.sortable(v.ty);
      }
    this.limit(ast);
    return { outputs, filter };
  }

  private ctes(clause: unknown, scope: Scope, depth: number): void {
    if (clause == null) return;
    if (!node(clause)) hold("Unresolved SQL dependencies");
    keys(clause, ["ctes", "location"]);
    for (const item of list(clause.ctes)) {
      const [kind, cte] = only(item);
      if (kind !== "CommonTableExpr") hold("Unresolved SQL dependencies");
      keys(cte, ["ctename", "aliascolnames", "ctematerialized", "ctequery", "location"]);
      const name = this.name(cte.ctename);
      const [queryKind, query] = only(cte.ctequery);
      if (queryKind !== "SelectStmt") hold("Unresolved SQL dependencies");
      const body = this.select(query, scope, depth + 1);
      const outputs = this.rename(body.outputs, cte.aliascolnames);
      this.record(body.filter, "control");
      for (const o of outputs) this.record(o.val.deps, "control");
      scope.ctes.set(name, outputs);
    }
  }

  // Each node of a set operation resolves its two inputs column by column, as PostgreSQL does,
  // so a nested or parenthesized operation keeps its precedence. Its own WITH, ORDER BY and
  // LIMIT apply to its combined result.
  private setOperation(
    ast: Node,
    parent: Scope | undefined,
    depth: number,
  ): { outputs: Output[]; filter: Set<string> } {
    keys(ast, [
      "op",
      "all",
      "larg",
      "rarg",
      "withClause",
      "sortClause",
      "limitCount",
      "limitOffset",
      "limitOption",
    ]);
    if (!SET_OPERATIONS.has(String(ast.op))) hold("Unresolved SQL dependencies");
    if (++this.occurrences > 16) hold("Unresolved SQL dependencies");
    const scope: Scope = { sources: [], operands: [], ctes: new Map(), parent };
    this.ctes(ast.withClause, scope, depth);
    const left = this.select(ast.larg, scope, depth + 1);
    const right = this.select(ast.rarg, scope, depth + 1);
    if (left.outputs.length !== right.outputs.length) hold("Unresolved SQL dependencies");
    const except = ast.op === "SETOP_EXCEPT";
    const filter = union(left.filter, right.filter);
    // Rows removed by EXCEPT still depend on its right operand, as a control dependency.
    if (except) for (const o of right.outputs) for (const d of o.val.deps) filter.add(d);
    const outputs: Output[] = left.outputs.map((first, col) => {
      const second = right.outputs[col].val;
      // Two unknown literals become text before a later typed branch, which can then need a
      // cast from text: resolving pair by pair catches a custom implicit cast from it.
      const ty: Ty = this.res ? this.res.common([first.val.ty, second.ty]) : "top";
      return {
        name: first.name,
        val: this.val(
          ty,
          except ? [first.val.deps] : [first.val.deps, second.deps],
          first.val.opaque || second.opaque,
        ),
      };
    });
    // Every form but UNION ALL compares whole rows, INTERSECT ALL and EXCEPT ALL included.
    if (ast.op !== "SETOP_UNION" || ast.all !== true)
      for (const o of outputs) this.res?.sortable(o.val.ty);
    for (const order of list(ast.sortClause)) {
      const [kind, sort] = only(order);
      if (kind !== "SortBy") hold("Unresolved SQL dependencies");
      keys(sort, ["node", "sortby_dir", "sortby_nulls", "location"]);
      const e = sort.node;
      const ordinal = integerConstant(e);
      const column = node(e) && node(e.ColumnRef) ? list(e.ColumnRef.fields) : [];
      let target: Output | undefined;
      if (ordinal !== undefined) {
        this.structural.add(e as Node);
        target = outputs[ordinal - 1];
      } else if (column.length === 1) {
        const name = strings(column)[0];
        target = outputs.find((o) => o.name === name);
      }
      // A set operation's result can only be ordered by an output ordinal or name.
      if (!target) hold("Unresolved SQL dependencies");
      this.res?.sortable(target.val.ty);
    }
    this.limit(ast);
    return { outputs, filter };
  }

  private rename(outputs: Output[], columns: unknown): Output[] {
    const names = strings(columns);
    if (names.length > outputs.length) hold("Unresolved SQL dependencies");
    return outputs.map((o, i) => {
      if (i >= names.length) return o;
      const name = this.name(names[i]);
      if (sensitiveReference(name)) hold(`Sensitive source or alias: ${name}`);
      return { name, val: o.val };
    });
  }

  private add(scope: Scope, source: Source): Source {
    if (scope.sources.some((s) => s.alias === source.alias)) hold("Unresolved relation or join");
    scope.sources.push(source);
    return source;
  }

  private fromItem(
    item: unknown,
    scope: Scope,
    depth: number,
    quals: unknown[],
    control: (v: Val) => void,
  ): Operand {
    const [kind, body] = only(item);
    if (kind === "JoinExpr") return this.join(body, scope, depth, quals, control);
    if (++this.occurrences > 16) hold("Unresolved relation or join");
    let source: Source;
    if (kind === "RangeVar") source = this.relation(body, scope);
    else if (kind === "RangeSubselect") source = this.derived(body, scope, depth);
    else hold("Unresolved relation or join");
    this.add(scope, source);
    return { sources: [source], columns: (name) => this.columnOf(source, name), merges: false };
  }

  private alias(value: unknown): { name?: string; columns: unknown } {
    if (value == null) return { columns: null };
    if (!node(value)) hold("Unresolved relation or join");
    keys(value, ["aliasname", "colnames"]);
    return { name: this.name(value.aliasname), columns: value.colnames };
  }

  private relation(rv: Node, scope: Scope): Source {
    keys(rv, ["schemaname", "relname", "inh", "relpersistence", "alias", "location"]);
    const table = this.name(rv.relname);
    const alias = this.alias(rv.alias);
    // A relation alias renaming its columns is left to manual review.
    if (alias.columns != null) hold("Unresolved relation or join");
    const name = alias.name ?? table;
    if (rv.schemaname == null) {
      for (let s: Scope | undefined = scope; s; s = s.parent) {
        const cte = s.ctes.get(table);
        if (cte) return { alias: name, columns: cte };
      }
      hold("An explicit simple schema and table are required");
    }
    const schema = this.name(rv.schemaname);
    if (schema.startsWith("pg_") || schema === "information_schema")
      hold("Sensitive or system schema");
    let base = this.relations.findIndex((r) => r.schema === schema && r.table === table);
    if (base < 0) base = this.relations.push({ schema, table }) - 1;
    return { alias: name, base };
  }

  private derived(sub: Node, scope: Scope, depth: number): Source {
    keys(sub, ["subquery", "alias"]);
    const alias = this.alias(sub.alias);
    const [kind, query] = only(sub.subquery);
    if (kind !== "SelectStmt") hold("Unresolved relation or join");
    // A derived table sees outer queries and this level's CTEs, never its siblings.
    const body = this.select(
      query,
      { sources: [], operands: [], ctes: scope.ctes, parent: scope.parent },
      depth + 1,
    );
    this.record(body.filter, "control");
    for (const o of body.outputs) this.record(o.val.deps, "control");
    // An unaliased subquery (PostgreSQL 16 and later) is reachable through its columns only.
    return {
      alias: alias.name ?? `\0${this.occurrences}`,
      columns: this.rename(body.outputs, alias.columns),
    };
  }

  // As PostgreSQL builds a join's columns: USING merges each key, taken once from each input,
  // into one column typed by both and depending on both; the join exposes it in place of the
  // two inputs' own columns of that name, and every other column as its input exposes it.
  private join(
    j: Node,
    scope: Scope,
    depth: number,
    quals: unknown[],
    control: (v: Val) => void,
  ): Operand {
    keys(j, ["jointype", "larg", "rarg", "usingClause", "quals"]);
    if (!JOINS.has(String(j.jointype))) hold("Unresolved relation or join");
    const left = this.fromItem(j.larg, scope, depth, quals, control);
    const right = this.fromItem(j.rarg, scope, depth, quals, control);
    if (j.quals != null) quals.push(j.quals);
    const merged = new Map<string, Val>();
    for (const key of strings(j.usingClause)) {
      const column = this.name(key);
      if (merged.has(column)) hold("Unresolved relation or join");
      const l = this.single(left, column);
      const r = this.single(right, column);
      control(l);
      control(r);
      this.call("=", [l, r], true);
      const ty: Ty = this.res ? this.res.common([l.ty, r.ty]) : "top";
      merged.set(column, this.val(ty, [l.deps, r.deps], l.opaque || r.opaque));
    }
    return {
      sources: [...left.sources, ...right.sources],
      columns: (name) => {
        const key = merged.get(name);
        return key ? [key] : [...left.columns(name), ...right.columns(name)];
      },
      merges: merged.size > 0 || left.merges || right.merges,
    };
  }

  /** The one column of that name an input exposes: PostgreSQL refuses a USING key it lacks or repeats. */
  private single(operand: Operand, column: string): Val {
    if (!this.res) return this.val("top");
    const matches = operand.columns(column);
    if (matches.length !== 1) hold("Unresolved source column");
    return matches[0];
  }

  private derivedName(expr: unknown): string {
    if (!node(expr)) return "?column?";
    if (node(expr.ColumnRef)) return strings(expr.ColumnRef.fields).at(-1) ?? "?column?";
    if (node(expr.TypeCast)) return this.derivedName(expr.TypeCast.arg);
    if (node(expr.FuncCall)) return strings(expr.FuncCall.funcname).at(-1) ?? "?column?";
    return "?column?";
  }

  private limit(ast: Node): void {
    if (!LIMITS.has(String(ast.limitOption))) hold("Unsupported LIMIT");
    for (const part of [ast.limitCount, ast.limitOffset]) {
      if (part == null) continue;
      const n = integerConstant(part);
      if (n === undefined || n < 0 || n > 1000000) hold("Unsupported LIMIT");
      this.structural.add(part as Node);
    }
  }

  private order(
    order: unknown,
    scope: Scope,
    depth: number,
    output?: (e: unknown) => Val | undefined,
  ): Val {
    const [kind, sort] = only(order);
    if (kind !== "SortBy") hold("Unresolved SQL dependencies");
    keys(sort, ["node", "sortby_dir", "sortby_nulls", "location"]);
    if (!["SORTBY_DEFAULT", "SORTBY_ASC", "SORTBY_DESC"].includes(String(sort.sortby_dir)))
      hold("Unresolved SQL dependencies");
    const v = output?.(sort.node) ?? this.expr(sort.node, scope, depth);
    this.res?.sortable(v.ty);
    return v;
  }

  private star(ref: Node, scope: Scope): Output[] {
    keys(ref, ["fields", "location"]);
    const fields = list(ref.fields);
    if (fields.length > 2) hold("Unresolved source column");
    const table = fields.length === 2 ? this.name(strings(fields.slice(0, 1))[0]) : null;
    // Star over a USING join lists its merged keys first; that layout is left to manual review.
    if (table === null && scope.operands.some((o) => o.merges)) hold("Unresolved source column");
    const sources = scope.sources.filter((s) => table === null || s.alias === table);
    if (!sources.length) hold("Unresolved source column");
    if (!this.res) return [];
    return sources.flatMap(
      (s) =>
        s.columns ??
        this.res!.cat.relations[s.base as number].columns.slice()
          .sort((a, b) => a.num - b.num)
          .map((c) => ({ name: c.name, val: this.base(s.base as number, c.name) })),
    );
  }

  private base(index: number, column: string): Val {
    const res = this.res as Resolver;
    const info = res.cat.relations[index].columns.find((c) => c.name === column) as {
      type: number;
    };
    return {
      ty: [info.type],
      deps: new Set([`${index}\u0000${column}`]),
      opaque: res.jsonish(info.type),
    };
  }

  /** Nearest scope first: an inner alias shadows an outer relation of the same name. */
  private lookup(
    scope: Scope,
    table: string | null,
    column: string,
    required = true,
  ): Val | undefined {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      if (table !== null) {
        const sources = s.sources.filter((x) => x.alias === table);
        if (!sources.length) continue;
        const matches = sources.flatMap((x) => this.columnOf(x, column));
        if (matches.length > 1) hold("Unresolved source column");
        if (matches.length === 1) return matches[0];
        break;
      }
      const matches = s.operands.flatMap((o) => o.columns(column));
      if (matches.length > 1) hold("Unresolved source column");
      if (matches.length === 1) return matches[0];
    }
    if (required) hold("Unresolved source column");
    return undefined;
  }

  private columnOf(source: Source, column: string): Val[] {
    if (source.columns) return source.columns.filter((o) => o.name === column).map((o) => o.val);
    const res = this.res as Resolver;
    const count = res.cat.relations[source.base as number].columns.filter(
      (c) => c.name === column,
    ).length;
    if (count > 1) hold("Unresolved source column");
    return count ? [this.base(source.base as number, column)] : [];
  }

  private column(ref: Node, scope: Scope): Val {
    keys(ref, ["fields", "location"]);
    const fields = strings(ref.fields);
    if (fields.length > 2) hold("Unresolved source column");
    const column = this.name(fields.at(-1));
    const table = fields.length === 2 ? this.name(fields[0]) : null;
    if (!this.res) return this.val("top");
    return this.lookup(scope, table, column) as Val;
  }

  call(
    name: string,
    args: Val[],
    operator: boolean,
    qualified = false,
  ): Val & { params: number[][] } {
    (operator ? this.operators : this.functions).add(name);
    const deps = args.map((a) => a.deps);
    if (!this.res) return { ...this.val("top", deps), params: [] };
    const callArgs: CallArg[] = args.map((a) => {
      const key = a.literal ? stringConstant(a.literal) : undefined;
      return { ty: a.ty, opaque: a.opaque, ...(key !== undefined ? { key } : {}) };
    });
    const result: CallResult = operator
      ? this.res.operator(name, callArgs)
      : this.res.func(name, callArgs, qualified);
    for (const i of result.keys)
      this.jsonKey(args[i].literal as Node, name === "#>" || name === "#>>");
    return { ...this.val(result.ty, deps, result.opaque), params: result.params };
  }

  private condition(value: unknown, scope: Scope, depth: number): Val {
    const v = this.expr(value, scope, depth);
    this.res?.coerce(v.ty, T.bool);
    return v;
  }

  /** JSON keys stay visible to the evaluator, so they pass the same name screening. */
  private jsonKey(literal: Node, path: boolean): void {
    const value = stringConstant(literal) ?? "";
    const parts = path
      ? /^\{[^{}]+\}$/.test(value)
        ? value.slice(1, -1).split(",")
        : []
      : [value];
    if (!parts.length || parts.some((key) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)))
      hold("Unresolved JSON path");
    if (parts.some(sensitiveReference)) hold("Sensitive input stays on this machine");
    this.literals.set(literal, true);
  }

  private literal(value: Node, ty: Ty, withheld = true): Val {
    if (!withheld) this.structural.add(value);
    else if (!this.literals.has(value)) this.literals.set(value, false);
    return { ty, deps: new Set(), opaque: false, literal: value };
  }

  private constant(wrapper: Node): Val {
    const c = wrapper.A_Const as Node;
    keys(c, ["ival", "fval", "boolval", "sval", "isnull", "location"]);
    if (c.isnull === true) return this.literal(wrapper, "unknown", false);
    if (c.boolval != null) return this.literal(wrapper, [T.bool], false);
    if (c.sval != null) return this.literal(wrapper, "unknown");
    const text =
      c.ival != null ? String(integerConstant(wrapper)) : node(c.fval) ? String(c.fval.fval) : "";
    if (!/^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) hold("Unresolved SQL dependencies");
    if (text.replace(/\D/g, "").length >= 12) hold("Sensitive input stays on this machine");
    // PostgreSQL types an integer constant int4, a larger one int8 if it fits, else numeric.
    const integer = /^-?\d+$/.test(text);
    const n = integer ? BigInt(text) : 0n;
    const type = !integer
      ? "numeric"
      : n >= -2147483648n && n <= 2147483647n
        ? "int4"
        : n >= -9223372036854775808n && n <= 9223372036854775807n
          ? "int8"
          : "numeric";
    this.numberTypes.set(wrapper, type);
    return this.literal(wrapper, [T[type]]);
  }

  private subquery(
    sublink: Node,
    scope: Scope,
    depth: number,
  ): { outputs: Output[]; filter: Set<string> } {
    const [kind, query] = only(sublink.subselect);
    if (kind !== "SelectStmt") hold("Unresolved SQL dependencies");
    return this.select(query, scope, depth + 1);
  }

  private window(over: unknown, scope: Scope, depth: number): Set<string> {
    if (!node(over)) hold("Unresolved SQL dependencies");
    if (over.name != null || over.refname != null) hold("Named windows need manual review");
    keys(over, ["partitionClause", "orderClause", "frameOptions", "location"]);
    if (over.frameOptions !== DEFAULT_FRAME) hold("Unresolved SQL dependencies");
    const deps: Set<string>[] = [];
    for (const part of list(over.partitionClause)) {
      const v = this.expr(part, scope, depth);
      this.res?.sortable(v.ty);
      deps.push(v.deps);
    }
    for (const order of list(over.orderClause)) deps.push(this.order(order, scope, depth).deps);
    return union(...deps);
  }

  private common(vals: Val[]): Val {
    const ty: Ty = this.res ? this.res.common(vals.map((v) => v.ty)) : "top";
    return this.val(
      ty,
      vals.map((v) => v.deps),
      vals.some((v) => v.opaque),
    );
  }

  expr(value: unknown, scope: Scope, depth: number): Val {
    const [kind, body] = only(value);
    switch (kind) {
      case "ColumnRef": {
        const last = list(body.fields).at(-1);
        if (node(last) && "A_Star" in last) hold("Unresolved source column");
        return this.column(body, scope);
      }
      case "A_Const":
        return this.constant(value as Node);
      case "A_Expr":
        return this.operation(body, scope, depth);
      case "BoolExpr": {
        keys(body, ["boolop", "args", "location"]);
        const args = list(body.args).map((a) => this.condition(a, scope, depth).deps);
        const known =
          body.boolop === "NOT_EXPR"
            ? args.length === 1
            : ["AND_EXPR", "OR_EXPR"].includes(String(body.boolop));
        if (!known) hold("Unresolved SQL dependencies");
        return this.val([T.bool], args);
      }
      case "NullTest":
        keys(body, ["arg", "nulltesttype", "location"]);
        return this.val([T.bool], [this.expr(body.arg, scope, depth).deps]);
      case "BooleanTest":
        keys(body, ["arg", "booltesttype", "location"]);
        return this.val([T.bool], [this.condition(body.arg, scope, depth).deps]);
      case "SubLink":
        return this.sublink(body, scope, depth);
      case "CaseExpr":
        return this.caseExpr(body, scope, depth);
      case "CoalesceExpr": {
        keys(body, ["args", "location"]);
        const args = list(body.args).map((a) => this.expr(a, scope, depth));
        if (!args.length) hold("Unresolved SQL dependencies");
        return this.common(args);
      }
      case "MinMaxExpr": {
        keys(body, ["op", "args", "location"]);
        const args = list(body.args).map((a) => this.expr(a, scope, depth));
        if (!args.length) hold("Unresolved SQL dependencies");
        const v = this.common(args);
        this.res?.sortable(v.ty);
        return v;
      }
      case "TypeCast":
        return this.cast(body, scope, depth);
      case "FuncCall":
        return this.func(body, scope, depth);
      case "SQLValueFunction": {
        keys(body, ["op", "typmod", "location"]);
        const clock = CLOCK[String(body.op)];
        if (clock === undefined) hold("System information needs manual review");
        return this.val([clock]);
      }
      default:
        hold("Unresolved SQL dependencies");
    }
  }

  private operation(e: Node, scope: Scope, depth: number): Val {
    keys(e, ["kind", "name", "lexpr", "rexpr", "location", "rexpr_list_start", "rexpr_list_end"]);
    const names = strings(e.name);
    if (names.length !== 1) hold("Unresolved SQL dependencies");
    const op = names[0];
    const both = () => [this.expr(e.lexpr, scope, depth), this.expr(e.rexpr, scope, depth)];
    switch (e.kind) {
      case "AEXPR_OP": {
        if (!/^[~!@#%^&|`?+\-*/<>=]+$/.test(op)) hold("Unresolved SQL dependencies");
        if (e.lexpr == null) {
          if (op !== "-" && op !== "+") hold("Unresolved SQL dependencies");
          return this.call(op, [this.expr(e.rexpr, scope, depth)], true);
        }
        return this.call(op, both(), true);
      }
      case "AEXPR_LIKE":
      case "AEXPR_ILIKE":
      case "AEXPR_SIMILAR":
        return this.call(op, both(), true);
      case "AEXPR_DISTINCT":
      case "AEXPR_NOT_DISTINCT": {
        // A bare NULL operand makes it a null test; otherwise PostgreSQL compares through =.
        const [left, right] = both();
        if (constant(e.lexpr)?.isnull === true || constant(e.rexpr)?.isnull === true)
          return this.val([T.bool], [left.deps, right.deps]);
        const eq = this.call("=", [left, right], true);
        this.res?.coerce(eq.ty, T.bool);
        return this.val([T.bool], [eq.deps]);
      }
      case "AEXPR_NULLIF": {
        const [first, second] = both();
        return this.nullif(first, second);
      }
      case "AEXPR_IN": {
        const items = node(e.rexpr) && node(e.rexpr.List) ? list(e.rexpr.List.items) : [];
        if (!items.length) hold("Unresolved SQL dependencies");
        const left = this.expr(e.lexpr, scope, depth);
        const vals = items.map((v) => this.expr(v, scope, depth));
        // PostgreSQL compares against the common type of the list, one of the listed types.
        const typed = vals.filter((i) => i.ty !== "unknown");
        const other = typed.length ? this.common([left, ...typed]) : this.val("unknown");
        const result = this.call(op, [left, { ...other, deps: new Set() }], true);
        return this.val([T.bool], [result.deps, ...vals.map((i) => i.deps)]);
      }
      case "AEXPR_BETWEEN":
      case "AEXPR_NOT_BETWEEN": {
        const bounds = node(e.rexpr) && node(e.rexpr.List) ? list(e.rexpr.List.items) : [];
        if (bounds.length !== 2) hold("Unresolved SQL dependencies");
        const left = this.expr(e.lexpr, scope, depth);
        const [low, high] = bounds.map((v) => this.expr(v, scope, depth));
        const [lo, hi] = e.kind === "AEXPR_BETWEEN" ? [">=", "<="] : ["<", ">"];
        return this.val(
          [T.bool],
          [this.call(lo, [left, low], true).deps, this.call(hi, [left, high], true).deps],
        );
      }
      default:
        hold("Unresolved SQL dependencies");
    }
  }

  private sublink(link: Node, scope: Scope, depth: number): Val {
    keys(link, ["subLinkType", "testexpr", "operName", "subselect", "location"]);
    const sub = this.subquery(link, scope, depth);
    if (link.subLinkType === "EXISTS_SUBLINK")
      return this.val([T.bool], [sub.filter, ...sub.outputs.map((o) => o.val.deps)]);
    if (sub.outputs.length !== 1) hold("Unresolved SQL dependencies");
    const out = sub.outputs[0].val;
    const val: Val = { ty: out.ty, deps: union(sub.filter, out.deps), opaque: out.opaque };
    if (link.subLinkType === "EXPR_SUBLINK") return val;
    // x IN (SELECT ...) arrives as ANY with no operator, which means =; = ANY (SELECT ...) names it.
    const operator = strings(link.operName);
    if (link.subLinkType !== "ANY_SUBLINK" || (operator.length && operator.join() !== "="))
      hold("Unresolved SQL dependencies");
    const left = this.expr(link.testexpr, scope, depth);
    return this.val([T.bool], [left.deps, this.call("=", [left, val], true).deps]);
  }

  private nullif(first: Val, second: Val): Val {
    // NULLIF returns its first argument as promoted by the implied = operator.
    const eq = this.call("=", [first, second], true);
    const promoted = eq.params.map((p) => p[0]).filter((oid) => this.res?.type(oid)?.kind !== "p");
    const ty: Ty =
      first.ty === "top"
        ? "top"
        : [...new Set([...(first.ty === "unknown" ? [] : first.ty), ...promoted])];
    return {
      ty: this.res && Array.isArray(ty) && !ty.length ? [T.text] : ty,
      deps: eq.deps,
      opaque: first.opaque,
    };
  }

  private caseExpr(c: Node, scope: Scope, depth: number): Val {
    keys(c, ["arg", "args", "defresult", "location"]);
    const arms = list(c.args);
    if (!arms.length) hold("Unresolved SQL dependencies");
    const subject = c.arg == null ? undefined : this.expr(c.arg, scope, depth);
    const deps: Set<string>[] = subject ? [subject.deps] : [];
    const results: Val[] = [];
    for (const item of arms) {
      const [kind, arm] = only(item);
      if (kind !== "CaseWhen") hold("Unresolved SQL dependencies");
      keys(arm, ["expr", "result", "location"]);
      const cond = subject
        ? this.expr(arm.expr, scope, depth)
        : this.condition(arm.expr, scope, depth);
      deps.push(subject ? this.call("=", [subject, cond], true).deps : cond.deps);
      results.push(this.expr(arm.result, scope, depth));
    }
    if (c.defresult != null) results.push(this.expr(c.defresult, scope, depth));
    const common = this.common(results);
    return { ...common, deps: union(common.deps, ...deps) };
  }

  /** The type name as the catalog query resolves it with to_regtype. */
  private typeText(typeName: unknown): string {
    if (!node(typeName)) hold("Unresolved cast");
    keys(typeName, ["names", "typmods", "typemod", "arrayBounds", "location"]);
    const names = strings(typeName.names);
    if (!names.length || names.length > 2 || (names.length === 2 && names[0] !== "pg_catalog"))
      hold("Unresolved cast");
    for (const mod of list(typeName.typmods)) {
      if (integerConstant(mod) === undefined) hold("Unresolved cast");
      this.structural.add(mod as Node);
    }
    const text = names.map(quoteIdent).join(".") + "[]".repeat(list(typeName.arrayBounds).length);
    // The catalog query carries it as an escaped identifier literal, bounded like one.
    if (!validIdentifier(text)) hold("Unresolved cast");
    return text;
  }

  private cast(c: Node, scope: Scope, depth: number): Val {
    keys(c, ["arg", "typeName", "location"]);
    const type = this.typeText(c.typeName);
    const operand = this.expr(c.arg, scope, depth);
    this.types.add(type);
    if (!this.res) return this.val("top", [operand.deps]);
    const r = this.res.cast({ ty: operand.ty, opaque: operand.opaque }, type);
    return this.val(r.ty, [operand.deps], r.opaque);
  }

  private func(f: Node, scope: Scope, depth: number): Val {
    keys(f, [
      "funcname",
      "args",
      "agg_order",
      "agg_filter",
      "over",
      "agg_star",
      "agg_distinct",
      "funcformat",
      "location",
    ]);
    const names = strings(f.funcname);
    if (!names.length || names.length > 2) hold("Unresolved SQL dependencies");
    const name = this.name(names.at(-1));
    let catalogOnly = false;
    if (names.length === 2) {
      if (names[0] !== "pg_catalog") hold(`Custom function needs manual review: ${name}`);
      catalogOnly = true;
    }
    const raw = list(f.args);
    let args: Val[];
    // EXTRACT(year FROM d) arrives as pg_catalog.extract('year', d). The grammar takes any word
    // or string there and only the server checks the unit, so only a unit PostgreSQL defines is
    // syntax; any other text could carry a value and would fail on the server anyway.
    if (catalogOnly && name === "extract" && f.funcformat === "COERCE_SQL_SYNTAX") {
      const field = stringConstant(raw[0]);
      if (raw.length !== 2 || field === undefined || !EXTRACT_FIELDS.has(field.toLowerCase()))
        hold("Unresolved SQL dependencies");
      this.structural.add(raw[0] as Node);
      args = [this.val("unknown"), this.expr(raw[1], scope, depth)];
    } else args = raw.map((a) => this.expr(a, scope, depth));
    if (f.agg_star === true && (name !== "count" || args.length || f.agg_distinct === true))
      hold("Unresolved SQL dependencies");
    if (f.agg_distinct === true) for (const a of args) this.res?.sortable(a.ty);
    const extra: Set<string>[] = [];
    for (const order of list(f.agg_order)) extra.push(this.order(order, scope, depth).deps);
    if (f.agg_filter != null) extra.push(this.condition(f.agg_filter, scope, depth).deps);
    if (f.over != null) extra.push(this.window(f.over, scope, depth));
    const v = this.call(name, args, false, catalogOnly);
    return { ...v, deps: union(v.deps, ...extra) };
  }
}

function failure(error: unknown): string {
  return error instanceof Hold ? error.message : "Unsupported SQL representation";
}

function unsupportedSpelling(token: ScanToken): boolean {
  if (token.tokenType === UIDENT || token.tokenType === USCONST) return true;
  return token.tokenType === IDENT && !token.text.startsWith('"') && /[^ -~]/.test(token.text);
}

function selectOf(tree: ParseResult): Node {
  const stmts = tree.stmts ?? [];
  const stmt = stmts.length === 1 ? (stmts[0].stmt as Node | undefined) : undefined;
  if (!node(stmt) || !node(stmt.SelectStmt)) hold("Only SELECT is automatically supported");
  return stmt.SelectStmt;
}

/** Structure and names only: no catalog, so nothing is resolved yet. */
export function planPg(sql: string): PgReadPlan | string {
  try {
    const read = readPg(sql);
    if (!read || read === "ambiguous") hold("A parsed single read is required");
    if (read.tokens.some(unsupportedSpelling)) hold("Unsupported SQL representation");
    const walk = new Walk();
    walk.select(selectOf(read.tree), undefined, 0);
    if (!walk.relations.length) hold("An explicit simple schema and table are required");
    return {
      tree: read.tree,
      relations: walk.relations,
      operators: [...walk.operators],
      functions: [...walk.functions],
      types: [...walk.types],
    };
  } catch (error) {
    return failure(error);
  }
}

export function pgMetadataSql(plan: PgReadPlan): string {
  return catalogSql(plan);
}

// A withheld constant's replacement, built by PostgreSQL's own parser so its shape is exactly
// what reparsing the rendered text yields.
function parameter(number: number, type?: string): Node {
  const read = readPg(`SELECT $${number}${type ? `::pg_catalog.${type}` : ""}`);
  if (!read || read === "ambiguous") hold("Unsupported SQL representation");
  const target = (selectOf(read.tree).targetList as Node[])[0].ResTarget as Node;
  return target.val as Node;
}

// Source positions and lengths, which formatting changes without changing the statement.
const POSITIONS = new Set([
  "location",
  "stmt_location",
  "stmt_len",
  "list_start",
  "list_end",
  "rexpr_list_start",
  "rexpr_list_end",
]);

function sameTree(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameTree(x, b[i]))
    );
  if (!node(a) || !node(b)) return a === b;
  const ka = Object.keys(a).filter((k) => !POSITIONS.has(k));
  const kb = Object.keys(b).filter((k) => !POSITIONS.has(k));
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameTree(a[k], b[k]));
}

function constants(tree: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(tree)) for (const child of tree) constants(child, found);
  else if (node(tree)) {
    if (node(tree.A_Const)) found.push(tree);
    for (const value of Object.values(tree)) constants(value, found);
  }
  return found;
}

// Jev's text is rendered from the redacted tree, then parsed again by PostgreSQL's grammar: any
// difference from that tree beyond positions keeps the query local, never sends raw SQL.
function render(tree: ParseResult): string {
  let text = "";
  try {
    text = deparseSync(tree, { pretty: false });
  } catch {
    hold("Unsupported SQL representation");
  }
  const back = readPg(text);
  if (!back || back === "ambiguous" || !sameTree(back.tree.stmts, tree.stmts))
    hold("Unsupported SQL representation");
  if (text.length > 12000) hold("Query exceeds the automatic evaluation budget");
  return text;
}

export function resolvePg(plan: PgReadPlan, rows: Record<string, unknown>[]): PgSnapshot {
  try {
    const res = new Resolver(parseCatalog(rows, plan.relations.length));
    for (const r of res.cat.relations)
      if (r.relkind !== "r" || r.rls || r.inherited)
        hold("Views, foreign tables, RLS and inherited relations need manual review");
    const tree = structuredClone(plan.tree);
    const walk = new Walk(res);
    const { outputs, filter } = walk.select(selectOf(tree), undefined, 0);
    for (const o of outputs) {
      if (o.val.opaque) hold("Whole JSON or opaque output needs manual review");
      if (o.val.ty === "top") hold("Unresolved output type");
      if (Array.isArray(o.val.ty) && !o.val.ty.every((oid) => res.value(oid)))
        hold("Unresolved or unsupported source");
      walk.record(o.val.deps, "output");
    }
    walk.record(filter, "control");
    const dependencies: EvaluationInput["dependencies"] = [];
    for (const [key, use] of walk.usage) {
      const [index, column] = key.split("\u0000");
      const relation = plan.relations[Number(index)];
      const info = res.cat.relations[Number(index)].columns.find((c) => c.name === column);
      if (info?.generated !== "" || !info.collationCore || !res.value(info.type))
        hold("Unresolved or unsupported source");
      if (sensitiveReference(column)) hold(`Sensitive source or alias: ${column}`);
      dependencies.push({
        schema: relation.schema,
        table: relation.table,
        column,
        type: res.typeName(info.type),
        usage: use.output && use.control ? "both" : use.output ? "output" : "control",
      });
    }
    if (dependencies.length > 64) hold("Unresolved SQL dependencies");
    const parameters = new Map<string, number>();
    for (const [literal, visible] of walk.literals) {
      if (visible) continue;
      const type = walk.numberTypes.get(literal);
      const c = literal.A_Const as Node;
      const value =
        type === undefined
          ? stringConstant(literal)
          : c.ival != null
            ? String(integerConstant(literal))
            : String((c.fval as Node).fval);
      const key = JSON.stringify([type ?? "text", value]);
      if (!parameters.has(key)) parameters.set(key, parameters.size + 1);
      // Numbers keep their type, so redaction does not change what the SQL means.
      const replacement = parameter(parameters.get(key) as number, type);
      for (const k of Object.keys(literal)) delete literal[k];
      Object.assign(literal, replacement);
    }
    // Every constant left in the text is one the walk accepted as syntax or as a screened key.
    for (const left of constants(tree))
      if (!walk.structural.has(left) && walk.literals.get(left) !== true)
        hold("Unsupported SQL representation");
    return {
      complete: true,
      reasons: [],
      input: {
        dialect: "postgresql",
        sql: render(tree),
        dependencies,
        ...(parameters.size ? { withheldLiterals: true as const } : {}),
      },
    };
  } catch (error) {
    return { complete: false, reasons: [failure(error)] };
  }
}
