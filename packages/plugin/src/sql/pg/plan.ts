import type { EvaluationInput } from "@gatekeeper/shared";
import { sensitiveReference } from "../schema";
import { parser } from "../sql-parser";
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
} from "./catalog";
import { preparePgSql, validIdentifier } from "./syntax";

type Node = Record<string, unknown>;

export interface PgReadPlan {
  readonly ast: Node;
  readonly input: ReturnType<typeof preparePgSql>;
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
  /** Bare literal, kept to decide whether it is a JSON key. */
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
interface Scope {
  sources: Source[];
  ctes: Map<string, Output[]>;
  parent?: Scope;
}

const JOINS = ["INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "CROSS JOIN"];
// PostgreSQL rewrites these keyword operators into ordinary catalog operators.
const KEYWORD_OPERATORS: Record<string, string> = {
  LIKE: "~~",
  "NOT LIKE": "!~~",
  ILIKE: "~~*",
  "NOT ILIKE": "!~~*",
  "!=": "<>",
};
const CLOCK: Record<string, number> = {
  CURRENT_DATE: T.date,
  CURRENT_TIMESTAMP: T.timestamptz,
  LOCALTIMESTAMP: T.timestamp,
  CURRENT_TIME: T.timetz,
  LOCALTIME: T.time,
};
// Grammar constructs rather than catalog functions, so no name lookup applies to them.
const GRAMMAR = new Set(["coalesce", "nullif", "greatest", "least"]);
const SET_OPERATIONS = new Set(["union all", "union", "union distinct", "intersect", "except"]);
const TYPED_LITERALS: Record<string, string> = {
  date: "DATE",
  time: "TIME",
  timestamp: "TIMESTAMP",
  interval: "INTERVAL",
};

function node(value: unknown): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Unknown keys can carry semantics the walker does not model, so they are refused. */
function keys(value: Node, allowed: string[]): void {
  for (const [key, content] of Object.entries(value))
    if (content != null && !allowed.includes(key)) hold("Unresolved SQL dependencies");
}
function union(...sets: Set<string>[]): Set<string> {
  return new Set(sets.flatMap((s) => [...s]));
}
function label(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (node(value)) return label(value.expr ?? value.value);
  return null;
}

class Walk {
  readonly relations: { schema: string; table: string }[] = [];
  readonly operators = new Set<string>();
  readonly functions = new Set<string>();
  readonly types = new Set<string>();
  /** Base column key to how the proposal uses it. */
  readonly usage = new Map<string, { output: boolean; control: boolean }>();
  /** Literal nodes, true when they stay visible as screened JSON keys. */
  readonly literals = new Map<Node, boolean>();
  occurrences = 0;
  readonly input: ReturnType<typeof preparePgSql>;
  readonly res?: Resolver;

  constructor(input: ReturnType<typeof preparePgSql>, res?: Resolver) {
    this.input = input;
    this.res = res;
  }

  name(value: unknown): string {
    const raw = label(value);
    const name = raw === null ? null : this.input.name(raw);
    if (!validIdentifier(name)) hold("Unresolved source column");
    return name;
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
    if (!node(ast) || ast.type !== "select" || depth > 8) hold("Unresolved SQL dependencies");
    if (ast._next != null || ast.set_op != null) return this.setOperation(ast, parent, depth);
    const inert = { ...ast };
    if (node(inert.into) && inert.into.position === null) delete inert.into;
    if (Array.isArray(inert.options) && !inert.options.length) delete inert.options;
    keys(inert, [
      "type",
      "with",
      "columns",
      "from",
      "where",
      "groupby",
      "having",
      "orderby",
      "limit",
      "distinct",
    ]);
    const scope: Scope = { sources: [], ctes: new Map(), parent };
    const filter = new Set<string>();
    const control = (v: Val) => {
      for (const dep of v.deps) filter.add(dep);
    };
    this.ctes(ast.with, scope, depth);
    if (ast.from != null && (!Array.isArray(ast.from) || !ast.from.length))
      hold("Unresolved relation or join");
    const joins: { item: Node; source: Source; left: Source[] }[] = [];
    for (const item of (ast.from as unknown[]) ?? []) {
      if (!node(item)) hold("Unresolved relation or join");
      if (item.join != null && !JOINS.includes(String(item.join)))
        hold("Unresolved relation or join");
      if (++this.occurrences > 16) hold("Unresolved relation or join");
      const source = this.source(item, scope, depth);
      if (scope.sources.some((s) => s.alias === source.alias)) hold("Unresolved relation or join");
      joins.push({ item, source, left: [...scope.sources] });
      scope.sources.push(source);
    }
    const aliases = new Map<string, Val>();
    const outputs: Output[] = [];
    if (!Array.isArray(ast.columns) || !ast.columns.length || ast.columns.length > 64)
      hold("Explicit source columns are required");
    for (const item of ast.columns) {
      if (!node(item)) hold("Unresolved SQL dependencies");
      keys(item, ["expr", "as", "type"]);
      const expr = item.expr;
      if (node(expr) && expr.type === "column_ref" && label(expr.column) === "*") {
        outputs.push(...this.star(expr, scope));
        continue;
      }
      const val = this.expr(expr, scope, depth);
      let name = this.derivedName(expr);
      if (item.as != null) {
        if (typeof item.as !== "string") hold("Unsupported output alias");
        name = this.input.name(item.as);
        if (!validIdentifier(name) || aliases.has(name)) hold("Unsupported output alias");
        if (sensitiveReference(name) && (!node(expr) || expr.type !== "single_quote_string"))
          hold(`Sensitive source or alias: ${name}`);
        aliases.set(name, val);
      }
      outputs.push({ name, val });
    }
    for (const { item, source, left } of joins) {
      if (item.on != null) control(this.condition(item.on, scope, depth));
      if (item.using != null) {
        if (!Array.isArray(item.using)) hold("Unresolved relation or join");
        for (const raw of item.using) {
          const column = this.name(raw);
          // USING merges columns: compare both inputs, never guess an unqualified source.
          const l = this.qualified(left, column, true);
          const r = this.qualified([source], column, false);
          control(l);
          control(r);
          this.call("=", [l, r], true);
        }
      }
    }
    if (ast.where != null) control(this.condition(ast.where, scope, depth));
    if (ast.having != null) control(this.condition(ast.having, scope, depth));
    const byOutput = (expr: unknown, preferAlias: boolean): Val | undefined => {
      if (node(expr) && expr.type === "number") {
        const n = Number(expr.value);
        if (!this.res) return this.val("top");
        if (!Number.isInteger(n) || n < 1 || n > outputs.length)
          hold("Unresolved SQL dependencies");
        return outputs[n - 1].val;
      }
      if (
        node(expr) &&
        expr.type === "column_ref" &&
        expr.table == null &&
        label(expr.column) !== "*"
      ) {
        const name = this.name(expr.column);
        if (!aliases.has(name)) return undefined;
        if (preferAlias || !this.res) return aliases.get(name);
        // GROUP BY prefers an input column, ORDER BY an output name.
        if (!this.lookup(scope, null, name, false)) return aliases.get(name);
      }
      return undefined;
    };
    if (ast.groupby != null) {
      if (!node(ast.groupby) || !Array.isArray(ast.groupby.columns))
        hold("Unresolved SQL dependencies");
      keys(ast.groupby, ["columns"]);
      for (const expr of ast.groupby.columns) {
        const v = byOutput(expr, false) ?? this.expr(expr, scope, depth);
        control(v);
        this.res?.sortable(v.ty);
      }
    }
    if (ast.orderby != null) {
      if (!Array.isArray(ast.orderby)) hold("Unresolved SQL dependencies");
      for (const order of ast.orderby) {
        const v = this.order(order, scope, depth, (e) => byOutput(e, true));
        control(v);
      }
    }
    if (ast.distinct != null) {
      if (!node(ast.distinct)) hold("Unresolved SQL dependencies");
      keys(ast.distinct, ["type"]);
      if (ast.distinct.type != null) {
        if (ast.distinct.type !== "DISTINCT") hold("Unresolved SQL dependencies");
        for (const o of outputs) this.res?.sortable(o.val.ty);
      }
    }
    if (ast.limit != null) this.limit(ast.limit);
    return { outputs, filter };
  }

  private ctes(clause: unknown, scope: Scope, depth: number): void {
    if (clause == null) return;
    if (!Array.isArray(clause)) hold("Unresolved SQL dependencies");
    for (const cte of clause) {
      if (!node(cte)) hold("Unresolved SQL dependencies");
      keys(cte, ["name", "stmt", "columns"]);
      const name = this.name(cte.name);
      const body = this.select(cte.stmt, scope, depth + 1);
      const outputs = this.rename(body.outputs, cte.columns);
      this.record(body.filter, "control");
      for (const o of outputs) this.record(o.val.deps, "control");
      scope.ctes.set(name, outputs);
    }
  }

  // node-sql-parser chains set operations left to right and attaches the statement's
  // trailing ORDER BY and LIMIT to the last branch. PostgreSQL only allows them there for
  // the whole result, since a parenthesized branch is parsed as a FROM item the walker refuses.
  private setOperation(
    ast: Node,
    parent: Scope | undefined,
    depth: number,
  ): { outputs: Output[]; filter: Set<string> } {
    const branches: Node[] = [];
    const ops: string[] = [];
    for (let b: unknown = ast; node(b); b = b._next) {
      branches.push(b);
      if (b._next == null) break;
      ops.push(String(b.set_op).toLowerCase());
    }
    if (branches.length > 16 || ops.length !== branches.length - 1)
      hold("Unresolved SQL dependencies");
    if (!ops.every((op) => SET_OPERATIONS.has(op))) hold("Unresolved SQL dependencies");
    // INTERSECT binds tighter than UNION and EXCEPT, which a flat chain cannot express.
    if (ops.includes("intersect") && ops.some((op) => op !== "intersect"))
      hold("Mixed set operation precedence needs manual review");
    // The first branch's WITH belongs to the whole statement.
    const scope: Scope = { sources: [], ctes: new Map(), parent };
    this.ctes(ast.with, scope, depth);
    const last = branches[branches.length - 1];
    const results = branches.map((b, i) => {
      if (i > 0 && b.with != null) hold("Unresolved SQL dependencies");
      const branch: Node = { ...b, with: null, _next: null, set_op: null };
      if (b === last) Object.assign(branch, { orderby: null, limit: null });
      return this.select(branch, scope, depth + 1);
    });
    const width = results[0].outputs.length;
    if (results.some((r) => r.outputs.length !== width)) hold("Unresolved SQL dependencies");
    const filter = union(...results.map((r) => r.filter));
    // Rows removed by EXCEPT still depend on its right operand, as a control dependency.
    results.forEach((r, i) => {
      if (i > 0 && ops[i - 1] === "except")
        for (const o of r.outputs) for (const d of o.val.deps) filter.add(d);
    });
    const kept = results.filter((_, i) => i === 0 || ops[i - 1] !== "except");
    const outputs: Output[] = results[0].outputs.map((first, col) => {
      const vals = results.map((r) => r.outputs[col].val);
      // PostgreSQL resolves each pair left to right: two unknown literals become text before
      // the next branch, which can then need a cast from text.
      const ty: Ty = this.res
        ? vals
            .slice(1)
            .reduce<Ty>((acc, v) => (this.res as Resolver).common([acc, v.ty]), vals[0].ty)
        : "top";
      return {
        name: first.name,
        val: this.val(
          ty,
          kept.map((r) => r.outputs[col].val.deps),
          vals.some((v) => v.opaque),
        ),
      };
    });
    // Every form but UNION ALL compares whole rows, INTERSECT ALL and EXCEPT ALL included.
    if (ops.some((op) => op !== "union all")) for (const o of outputs) this.res?.sortable(o.val.ty);
    if (last.orderby != null) {
      if (!Array.isArray(last.orderby)) hold("Unresolved SQL dependencies");
      for (const order of last.orderby) {
        if (!node(order)) hold("Unresolved SQL dependencies");
        keys(order, ["expr", "type", "nulls"]);
        if (order.type != null && !["ASC", "DESC"].includes(String(order.type)))
          hold("Unresolved SQL dependencies");
        if (order.nulls != null && !["NULLS FIRST", "NULLS LAST"].includes(String(order.nulls)))
          hold("Unresolved SQL dependencies");
        const e = order.expr;
        let target: Output | undefined;
        if (node(e) && e.type === "number" && Number.isInteger(Number(e.value)))
          target = outputs[Number(e.value) - 1];
        else if (node(e) && e.type === "column_ref" && e.table == null) {
          keys(e, ["type", "table", "column"]);
          const name = this.name(e.column);
          target = outputs.find((o) => o.name === name);
        }
        // A set operation's result can only be ordered by an output ordinal or name.
        if (!target) hold("Unresolved SQL dependencies");
        this.res?.sortable(target.val.ty);
      }
    }
    if (last.limit != null) this.limit(last.limit);
    return { outputs, filter };
  }

  private rename(outputs: Output[], columns: unknown): Output[] {
    if (columns == null) return outputs;
    if (!Array.isArray(columns) || columns.length > outputs.length)
      hold("Unresolved SQL dependencies");
    return outputs.map((o, i) => {
      if (i >= columns.length) return o;
      const name = this.name(node(columns[i]) ? columns[i].column : columns[i]);
      if (sensitiveReference(name)) hold(`Sensitive source or alias: ${name}`);
      return { name, val: o.val };
    });
  }

  private source(item: Node, scope: Scope, depth: number): Source {
    if (node(item.expr)) {
      keys(item, ["expr", "as", "join", "on", "using"]);
      keys(item.expr, ["ast", "tableList", "columnList", "parentheses"]);
      if (typeof item.as !== "string") hold("Unresolved relation or join");
      // A derived table sees outer queries and this level's CTEs, never its siblings.
      const body = this.select(
        item.expr.ast,
        { sources: [], ctes: scope.ctes, parent: scope.parent },
        depth + 1,
      );
      this.record(body.filter, "control");
      for (const o of body.outputs) this.record(o.val.deps, "control");
      return { alias: this.input.name(item.as), columns: body.outputs };
    }
    keys(item, ["db", "table", "as", "join", "on", "using"]);
    const table = this.name(item.table);
    const alias = item.as == null ? table : this.name(item.as);
    if (item.db == null) {
      for (let s: Scope | undefined = scope; s; s = s.parent) {
        const cte = s.ctes.get(table);
        if (cte) return { alias, columns: cte };
      }
      hold("An explicit simple schema and table are required");
    }
    const schema = this.name(item.db);
    if (schema.startsWith("pg_") || schema === "information_schema")
      hold("Sensitive or system schema");
    let base = this.relations.findIndex((r) => r.schema === schema && r.table === table);
    if (base < 0) base = this.relations.push({ schema, table }) - 1;
    return { alias, base };
  }

  private derivedName(expr: unknown): string {
    if (!node(expr)) return "?column?";
    if (expr.type === "column_ref") return this.name(expr.column);
    if (expr.type === "cast") return this.derivedName(expr.expr);
    if (expr.type === "aggr_func" || expr.type === "window_func")
      return String(expr.name).toLowerCase();
    if (expr.type === "function" && node(expr.name) && Array.isArray(expr.name.name))
      return String(label(expr.name.name[0])).toLowerCase();
    return "?column?";
  }

  private limit(limit: unknown): void {
    if (!node(limit) || !Array.isArray(limit.value)) hold("Unsupported LIMIT");
    keys(limit, ["seperator", "value"]);
    if (!["", "offset"].includes(String(limit.seperator).toLowerCase()) || limit.value.length > 2)
      hold("Unsupported LIMIT");
    for (const part of limit.value)
      if (
        !node(part) ||
        part.type !== "number" ||
        !Number.isSafeInteger(part.value) ||
        Number(part.value) < 0 ||
        Number(part.value) > 1000000
      )
        hold("Unsupported LIMIT");
  }

  private order(
    order: unknown,
    scope: Scope,
    depth: number,
    output?: (e: unknown) => Val | undefined,
  ): Val {
    if (!node(order)) hold("Unresolved SQL dependencies");
    keys(order, ["expr", "type", "nulls"]);
    if (order.type != null && !["ASC", "DESC"].includes(String(order.type)))
      hold("Unresolved SQL dependencies");
    if (order.nulls != null && !["NULLS FIRST", "NULLS LAST"].includes(String(order.nulls)))
      hold("Unresolved SQL dependencies");
    const v = output?.(order.expr) ?? this.expr(order.expr, scope, depth);
    this.res?.sortable(v.ty);
    return v;
  }

  private star(expr: Node, scope: Scope): Output[] {
    keys(expr, ["type", "table", "column", "schema"]);
    const table = expr.table == null ? null : this.name(expr.table);
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
      const sources = table === null ? s.sources : s.sources.filter((x) => x.alias === table);
      if (table !== null && !sources.length) continue;
      const matches = sources.flatMap((x) => this.columnOf(x, column));
      if (matches.length > 1) hold("Unresolved source column");
      if (matches.length === 1) return matches[0];
      if (table !== null) break;
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

  private qualified(sources: Source[], column: string, left: boolean): Val {
    if (!this.res) return this.val("top");
    const matches = sources.flatMap((s) => this.columnOf(s, column));
    if (matches.length !== 1 && !(left && matches.length > 1)) hold("Unresolved source column");
    return {
      ty: [...new Set(matches.flatMap((m) => (Array.isArray(m.ty) ? m.ty : [])))],
      deps: union(...matches.map((m) => m.deps)),
      opaque: matches.some((m) => m.opaque),
    };
  }

  private column(expr: Node, scope: Scope): Val {
    keys(expr, ["type", "table", "column", "parentheses"]);
    const column = this.name(expr.column);
    const table = expr.table == null ? null : this.name(expr.table);
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
    const callArgs: CallArg[] = args.map((a) => ({
      ty: a.ty,
      opaque: a.opaque,
      ...(a.literal && a.literal.type === "single_quote_string"
        ? { key: String(a.literal.value) }
        : {}),
    }));
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
    const value = String(literal.value);
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
    if (withheld && !this.literals.has(value)) this.literals.set(value, false);
    return { ty, deps: new Set(), opaque: false, literal: value };
  }

  private subquery(value: Node, scope: Scope, depth: number): Val {
    keys(value, ["ast", "tableList", "columnList", "parentheses"]);
    const sub = this.select(value.ast, scope, depth + 1);
    if (sub.outputs.length !== 1) hold("Unresolved SQL dependencies");
    const out = sub.outputs[0].val;
    return { ty: out.ty, deps: union(sub.filter, out.deps), opaque: out.opaque };
  }

  private exists(value: Node, scope: Scope, depth: number): Val {
    keys(value, ["ast", "tableList", "columnList", "parentheses"]);
    const sub = this.select(value.ast, scope, depth + 1);
    return this.val([T.bool], [sub.filter, ...sub.outputs.map((o) => o.val.deps)]);
  }

  private window(over: unknown, scope: Scope, depth: number): Set<string> {
    if (!node(over)) hold("Unresolved SQL dependencies");
    keys(over, ["type", "as_window_specification"]);
    const spec = over.as_window_specification;
    if (!node(spec) || !node(spec.window_specification)) hold("Named windows need manual review");
    keys(spec, ["window_specification", "parentheses"]);
    const w = spec.window_specification;
    keys(w, ["partitionby", "orderby"]);
    const deps: Set<string>[] = [];
    for (const part of (w.partitionby as unknown[]) ?? []) {
      if (!node(part)) hold("Unresolved SQL dependencies");
      keys(part, ["type", "expr"]);
      const v = this.expr(part.expr, scope, depth);
      this.res?.sortable(v.ty);
      deps.push(v.deps);
    }
    for (const order of (w.orderby as unknown[]) ?? [])
      deps.push(this.order(order, scope, depth).deps);
    return union(...deps);
  }

  private args(list: unknown, scope: Scope, depth: number): Val[] {
    if (list == null) return [];
    if (!node(list) || list.type !== "expr_list" || !Array.isArray(list.value))
      hold("Unresolved SQL dependencies");
    keys(list, ["type", "value"]);
    return list.value.map((v) => this.expr(v, scope, depth));
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
    if (!node(value)) hold("Unresolved SQL dependencies");
    if (value.type === undefined && node(value.ast)) return this.subquery(value, scope, depth);
    switch (value.type) {
      case "column_ref":
        if (label(value.column) === "*") hold("Unresolved source column");
        return this.column(value, scope);
      case "number": {
        keys(value, ["type", "value", "parentheses"]);
        const text = String(value.value);
        if (text.replace(/\D/g, "").length >= 12) hold("Sensitive input stays on this machine");
        if (!/^\d+(\.\d*)?([eE][+-]?\d+)?$|^\.\d+([eE][+-]?\d+)?$/.test(text))
          hold("Unresolved SQL dependencies");
        const n = Number(text);
        const ty = !/^\d+$/.test(text) ? T.numeric : n <= 2147483647 ? T.int4 : T.int8;
        return this.literal(value, [ty]);
      }
      case "bool":
      case "boolean":
        keys(value, ["type", "value", "parentheses"]);
        return this.literal(value, [T.bool], false);
      case "null":
        keys(value, ["type", "value", "parentheses"]);
        return this.literal(value, "unknown", false);
      case "single_quote_string":
        keys(value, ["type", "value", "parentheses"]);
        if (typeof value.value !== "string") hold("Unresolved SQL dependencies");
        return this.literal(value, "unknown");
      case "date":
      case "time":
      case "timestamp":
        keys(value, ["type", "value"]);
        if (typeof value.value !== "string") hold("Unresolved SQL dependencies");
        return this.literal(value, [T[value.type as "date" | "time" | "timestamp"]]);
      case "interval": {
        keys(value, ["type", "expr", "unit"]);
        if (value.unit !== "" || !node(value.expr) || value.expr.type !== "single_quote_string")
          hold("Unresolved SQL dependencies");
        return this.literal(value, [T.interval]);
      }
      case "binary_expr":
        return this.binary(value, scope, depth);
      case "unary_expr": {
        keys(value, ["type", "operator", "expr", "parentheses"]);
        const op = String(value.operator).toUpperCase();
        if (op === "EXISTS" || op === "NOT EXISTS") {
          if (!node(value.expr)) hold("Unresolved SQL dependencies");
          return this.exists(value.expr, scope, depth);
        }
        if (op === "NOT")
          return this.val([T.bool], [this.condition(value.expr, scope, depth).deps]);
        const operand = this.expr(value.expr, scope, depth);
        if (op !== "-" && op !== "+") hold("Unresolved SQL dependencies");
        return this.call(op, [operand], true);
      }
      case "case":
        return this.caseExpr(value, scope, depth);
      case "cast":
        return this.cast(value, scope, depth);
      case "extract": {
        keys(value, ["type", "args"]);
        if (!node(value.args)) hold("Unresolved SQL dependencies");
        keys(value.args, ["field", "source"]);
        if (!/^[a-z]+$/i.test(String(value.args.field))) hold("Unresolved SQL dependencies");
        const field = this.val("unknown");
        return this.call("extract", [field, this.expr(value.args.source, scope, depth)], false);
      }
      case "function":
        return this.func(value, scope, depth);
      case "aggr_func":
        return this.aggregate(value, scope, depth);
      case "window_func": {
        keys(value, ["type", "name", "args", "over"]);
        const args = this.args(value.args, scope, depth);
        const over = this.window(value.over, scope, depth);
        const v = this.call(String(value.name).toLowerCase(), args, false);
        return { ...v, deps: union(v.deps, over) };
      }
      default:
        hold("Unresolved SQL dependencies");
    }
  }

  private binary(value: Node, scope: Scope, depth: number): Val {
    keys(value, ["type", "operator", "left", "right", "parentheses"]);
    const op = String(value.operator).toUpperCase();
    if (op === "AND" || op === "OR") {
      const left = this.condition(value.left, scope, depth);
      const right = this.condition(value.right, scope, depth);
      return this.val([T.bool], [left.deps, right.deps]);
    }
    const left = this.expr(value.left, scope, depth);
    if (op === "IS" || op === "IS NOT") {
      if (!node(value.right) || !["null", "bool", "boolean"].includes(String(value.right.type)))
        hold("Unresolved SQL dependencies");
      keys(value.right, ["type", "value"]);
      return this.val([T.bool], [left.deps]);
    }
    if (op === "IN" || op === "NOT IN") {
      const right = value.right;
      if (
        !node(right) ||
        right.type !== "expr_list" ||
        !Array.isArray(right.value) ||
        !right.value.length
      )
        hold("Unresolved SQL dependencies");
      keys(right, ["type", "value", "parentheses"]);
      const name = op === "IN" ? "=" : "<>";
      if (right.value.length === 1 && node(right.value[0]) && node(right.value[0].ast)) {
        const sub = this.subquery(right.value[0], scope, depth);
        return this.val([T.bool], [left.deps, this.call(name, [left, sub], true).deps]);
      }
      const items = right.value.map((v) => this.expr(v, scope, depth));
      // PostgreSQL compares against the common type of the list, one of the listed types.
      const typed = items.filter((i) => i.ty !== "unknown");
      const other = typed.length ? this.common([left, ...typed]) : this.val("unknown");
      const result = this.call(name, [left, { ...other, deps: new Set() }], true);
      return this.val([T.bool], [result.deps, ...items.map((i) => i.deps)]);
    }
    if (op === "BETWEEN" || op === "NOT BETWEEN") {
      const right = value.right;
      if (
        !node(right) ||
        right.type !== "expr_list" ||
        !Array.isArray(right.value) ||
        right.value.length !== 2
      )
        hold("Unresolved SQL dependencies");
      keys(right, ["type", "value"]);
      const [low, high] = right.value.map((v) => this.expr(v, scope, depth));
      const [lo, hi] = op === "BETWEEN" ? [">=", "<="] : ["<", ">"];
      return this.val(
        [T.bool],
        [this.call(lo, [left, low], true).deps, this.call(hi, [left, high], true).deps],
      );
    }
    const name = KEYWORD_OPERATORS[op] ?? op;
    if (!/^[~!@#%^&|`?+\-*/<>=]+$/.test(name)) hold("Unresolved SQL dependencies");
    return this.call(name, [left, this.expr(value.right, scope, depth)], true);
  }

  private caseExpr(value: Node, scope: Scope, depth: number): Val {
    keys(value, ["type", "expr", "args", "parentheses"]);
    if (!Array.isArray(value.args) || !value.args.length) hold("Unresolved SQL dependencies");
    const subject = value.expr == null ? undefined : this.expr(value.expr, scope, depth);
    const deps: Set<string>[] = subject ? [subject.deps] : [];
    const results: Val[] = [];
    for (const arm of value.args) {
      if (!node(arm)) hold("Unresolved SQL dependencies");
      if (arm.type === "when") {
        keys(arm, ["type", "cond", "result"]);
        const cond = subject
          ? this.expr(arm.cond, scope, depth)
          : this.condition(arm.cond, scope, depth);
        deps.push(subject ? this.call("=", [subject, cond], true).deps : cond.deps);
      } else if (arm.type === "else") keys(arm, ["type", "result"]);
      else hold("Unresolved SQL dependencies");
      results.push(this.expr(arm.result, scope, depth));
    }
    const common = this.common(results);
    return { ...common, deps: union(common.deps, ...deps) };
  }

  private cast(value: Node, scope: Scope, depth: number): Val {
    keys(value, ["type", "keyword", "symbol", "expr", "target", "parentheses"]);
    if (!Array.isArray(value.target) || value.target.length !== 1 || !node(value.target[0]))
      hold("Unresolved SQL dependencies");
    const target = value.target[0];
    // A quoted type name is misread by the parser (int4 becomes INT(4)), so it is refused.
    keys(target, ["dataType", "length", "scale", "parentheses", "suffix"]);
    if (Array.isArray(target.suffix) && target.suffix.length) hold("Unresolved cast");
    const type = String(target.dataType).toLowerCase();
    if (!/^[a-z][a-z0-9_ ]*(\[\])?$/.test(type) || type.length > 63) hold("Unresolved cast");
    for (const n of [target.length, target.scale])
      if (n != null && !Number.isSafeInteger(n)) hold("Unresolved cast");
    const operand = this.expr(value.expr, scope, depth);
    this.types.add(type);
    if (!this.res) return this.val("top", [operand.deps]);
    const r = this.res.cast({ ty: operand.ty, opaque: operand.opaque }, type);
    return this.val(r.ty, [operand.deps], r.opaque);
  }

  private func(value: Node, scope: Scope, depth: number): Val {
    keys(value, ["type", "name", "args", "over", "parentheses"]);
    if (!node(value.name) || !Array.isArray(value.name.name) || value.name.name.length !== 1)
      hold("Unresolved SQL dependencies");
    keys(value.name, ["name", "schema"]);
    const part = value.name.name[0];
    if (!node(part)) hold("Unresolved SQL dependencies");
    keys(part, ["type", "value"]);
    if (part.type === "origin") {
      const clock = CLOCK[String(part.value).toUpperCase()];
      if (clock === undefined || value.args != null || value.over != null)
        hold("System information needs manual review");
      return this.val([clock]);
    }
    const raw = String(part.value);
    if (part.type === "default" && raw.toUpperCase() === "EXISTS" && value.name.schema == null) {
      const args = value.args;
      if (
        !node(args) ||
        !Array.isArray(args.value) ||
        args.value.length !== 1 ||
        !node(args.value[0])
      )
        hold("Unresolved SQL dependencies");
      keys(args, ["type", "value"]);
      return this.exists(args.value[0], scope, depth);
    }
    const name = this.input.name(raw);
    let catalogOnly = false;
    if (value.name.schema != null) {
      if (this.name(value.name.schema) !== "pg_catalog")
        hold(`Custom function needs manual review: ${name}`);
      catalogOnly = true;
    }
    const args = this.args(value.args, scope, depth);
    // A quoted name such as "coalesce" calls a catalog function, never the grammar construct.
    if (!catalogOnly && raw === name && GRAMMAR.has(name)) {
      if (value.over != null || !args.length) hold("Unresolved SQL dependencies");
      if (name === "nullif") {
        if (args.length !== 2) hold("Unresolved SQL dependencies");
        // NULLIF returns its first argument as promoted by the implied = operator.
        const eq = this.call("=", args, true);
        const promoted = eq.params
          .map((p) => p[0])
          .filter((oid) => this.res?.type(oid)?.kind !== "p");
        const ty: Ty =
          args[0].ty === "top"
            ? "top"
            : [...new Set([...(args[0].ty === "unknown" ? [] : args[0].ty), ...promoted])];
        return {
          ty: this.res && Array.isArray(ty) && !ty.length ? [T.text] : ty,
          deps: eq.deps,
          opaque: args[0].opaque,
        };
      }
      const common = this.common(args);
      if (name !== "coalesce") this.res?.sortable(common.ty);
      return common;
    }
    const over = value.over == null ? new Set<string>() : this.window(value.over, scope, depth);
    const v = this.call(name, args, false, catalogOnly);
    return { ...v, deps: union(v.deps, over) };
  }

  private aggregate(value: Node, scope: Scope, depth: number): Val {
    keys(value, ["type", "name", "args", "over", "filter"]);
    if (!node(value.args)) hold("Unresolved SQL dependencies");
    keys(value.args, ["expr", "distinct", "orderby", "separator", "parentheses"]);
    const name = String(value.name).toLowerCase();
    const extra: Set<string>[] = [];
    let args: Val[];
    const expr = value.args.expr;
    if (node(expr) && expr.type === "star") {
      if (name !== "count" || value.args.distinct != null) hold("Unresolved SQL dependencies");
      keys(expr, ["type", "value"]);
      args = [];
    } else if (node(expr) && expr.type === "expr_list") args = this.args(expr, scope, depth);
    else args = [this.expr(expr, scope, depth)];
    if (value.args.separator != null) {
      const sep = value.args.separator;
      if (!node(sep)) hold("Unresolved SQL dependencies");
      keys(sep, ["symbol", "delimiter"]);
      args.push(this.expr(sep.delimiter, scope, depth));
    }
    if (value.args.distinct != null) {
      if (value.args.distinct !== "DISTINCT") hold("Unresolved SQL dependencies");
      for (const a of args) this.res?.sortable(a.ty);
    }
    if (value.args.orderby != null) {
      if (!Array.isArray(value.args.orderby)) hold("Unresolved SQL dependencies");
      for (const order of value.args.orderby) extra.push(this.order(order, scope, depth).deps);
    }
    if (value.filter != null) {
      const f = value.filter;
      if (!node(f) || f.keyword !== "filter" || f.where == null)
        hold("Unresolved SQL dependencies");
      keys(f, ["keyword", "parentheses", "where"]);
      extra.push(this.condition(f.where, scope, depth).deps);
    }
    if (value.over != null) extra.push(this.window(value.over, scope, depth));
    const v = this.call(name, args, false);
    return { ...v, deps: union(v.deps, ...extra) };
  }
}

function parse(input: ReturnType<typeof preparePgSql>): Node {
  const raw: unknown = parser.astify(input.sql, { database: "postgresql" });
  const ast = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
  if (!node(ast) || ast.type !== "select") hold("Only SELECT is automatically supported");
  return ast;
}

function failure(error: unknown): string {
  return error instanceof Hold ? error.message : "Unsupported SQL representation";
}

/** Structure and names only: no catalog, so nothing is resolved yet. */
export function planPg(sql: string): PgReadPlan | string {
  try {
    const input = preparePgSql(sql);
    const ast = parse(input);
    const walk = new Walk(input);
    walk.select(ast, undefined, 0);
    if (!walk.relations.length) hold("An explicit simple schema and table are required");
    return {
      ast,
      input,
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

export function resolvePg(plan: PgReadPlan, rows: Record<string, unknown>[]): PgSnapshot {
  try {
    const res = new Resolver(parseCatalog(rows, plan.relations.length));
    for (const r of res.cat.relations)
      if (r.relkind !== "r" || r.rls || r.inherited)
        hold("Views, foreign tables, RLS and inherited relations need manual review");
    const ast = structuredClone(plan.ast);
    const walk = new Walk(plan.input, res);
    const { outputs, filter } = walk.select(ast, undefined, 0);
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
      const typed =
        TYPED_LITERALS[String(literal.type)] ??
        (literal.type === "number"
          ? /^\d+$/.test(String(literal.value))
            ? Number(literal.value) <= 2147483647
              ? "INTEGER"
              : "BIGINT"
            : "NUMERIC"
          : undefined);
      const key = JSON.stringify([
        literal.type,
        typed === "INTERVAL" ? (literal.expr as Node).value : literal.value,
      ]);
      if (!parameters.has(key)) parameters.set(key, parameters.size + 1);
      const param = { type: "var", prefix: "$", name: parameters.get(key) };
      for (const k of Object.keys(literal)) delete literal[k];
      // Typed literals keep their type so redaction does not change what the SQL means.
      Object.assign(
        literal,
        typed
          ? {
              type: "cast",
              keyword: "cast",
              symbol: "as",
              expr: param,
              target: [{ dataType: typed }],
            }
          : param,
      );
    }
    return {
      complete: true,
      reasons: [],
      input: {
        dialect: "postgresql",
        sql: plan.input.restoreSql(parser.sqlify(ast as never, { database: "postgresql" })),
        dependencies,
        ...(parameters.size ? { withheldLiterals: true as const } : {}),
      },
    };
  } catch (error) {
    return { complete: false, reasons: [failure(error)] };
  }
}
