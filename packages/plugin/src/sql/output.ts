import { prepareSql } from "./identifiers";
import {
  accessorKeys,
  aliasName,
  analyzeSql,
  COMPARISON_OPS,
  clientColumns,
  columnLabel,
  formatRef,
  isFunctionRelation,
  isNode,
  JSON_OPERATORS,
  piiColumns,
  relationColumnAliases,
  type SchemaContext,
  type TableRef,
  walk,
} from "./schema";
import { parser } from "./sql-parser";

// What leaves the database for the agent, as opposed to everything the statement mentions:
// the reviewer's flags read this, while Auto mode keeps judging the whole query
// (`analyzeSql`, `sensitiveLiterals`), filters included.

type Node = Record<string, unknown>;

/** A table's columns in their order, from the live connection; absent when reading text alone. */
export type Columns = (ref: TableRef) => string[] | null;

export interface QueryOutput {
  // Every name that describes a returned value: its label, the source columns and inner
  // labels it traces back to, the JSON keys read into it.
  names: string[];
  // False when some returned value could not be traced, so a sensitive one may be missing.
  complete: boolean;
}

// One returned column. A `rest` slot stands for columns nobody could list: a table's own
// ("pass", a column read through it keeps its name) or a function's or recursion's ("opaque").
interface Slot {
  label: string | null;
  names: Set<string>;
  unknown: boolean;
  rest?: "pass" | "opaque";
}
interface Relation {
  alias: string;
  slots: Slot[];
  // The keys a USING join shares with the relations before it: returned once, from either side.
  using: string[];
  natural: boolean;
  // Joined to the item before it, rather than listed after a comma.
  joined: boolean;
}
interface Scope {
  relations: Relation[];
  ctes: Map<string, Slot[]>;
  parent?: Scope;
}
interface Value {
  names: Set<string>;
  unknown: boolean;
}

// Statements that hand back no rows unless they carry RETURNING.
const NO_ROWS = new Set([
  "insert",
  "replace",
  "update",
  "delete",
  "create",
  "alter",
  "drop",
  "truncate",
  "rename",
  "use",
  "set",
  "lock",
  "unlock",
  "grant",
  "revoke",
  "comment",
  "transaction",
]);
// What a predicate returns is a boolean, never the content it tested.
const BOOLEAN_OPS = new Set([
  ...COMPARISON_OPS,
  "AND",
  "OR",
  "XOR",
  "@>",
  "<@",
  "?",
  "?|",
  "?&",
  "&&",
]);
// A parenthesized set branch arrives as a FROM item joined by its operator.
const SET_JOIN = /union|intersect|except|minus/i;
// Wider than any real table (PostgreSQL stops at 1600 columns).
const MAX_COLUMNS = 2000;
// Engines whose double quotes delimit an identifier that node-sql-parser keeps as a string.
const QUOTED_IDENTIFIERS = new Set(["sqlite", "transactsql", "snowflake"]);
const NOTHING: Value = { names: new Set(), unknown: false };

const rest = (kind: "pass" | "opaque"): Slot => ({
  label: null,
  names: new Set(),
  unknown: true,
  rest: kind,
});
const join = (...values: Value[]): Value => ({
  names: new Set(values.flatMap((v) => [...v.names])),
  unknown: values.some((v) => v.unknown),
});
const named = (names: string[]): Value => ({ names: new Set(names), unknown: false });
const copy = (slot: Slot): Slot => ({ ...slot, names: new Set(slot.names) });

class Resolver {
  private readonly columns: Columns | undefined;
  // PostgreSQL names reach here already folded, so a quoted "Value" and value stay apart; the
  // other engines compare names without case.
  private readonly exact: boolean;

  // Where a double-quoted name is an identifier but reaches here as a string node.
  private readonly quotedNames: boolean;

  constructor(columns: Columns | undefined, dialect: string) {
    this.columns = columns;
    this.exact = dialect === "postgresql";
    this.quotedNames = QUOTED_IDENTIFIERS.has(dialect);
  }

  private key(name: string): string {
    return this.exact ? name : name.toLowerCase();
  }

  private same(a: string, b: string): boolean {
    return this.key(a) === this.key(b);
  }

  statement(ast: Node, scope: Scope): Slot[] {
    const type = String(ast.type ?? "").toLowerCase();
    const inner = this.withCtes(ast, scope);
    if (type === "select") {
      return branches(ast).some((b) => isNode(b.into) && b.into.type === "into")
        ? []
        : this.select(ast, inner);
    }
    if (NO_ROWS.has(type)) {
      const returning = isNode(ast.returning) ? ast.returning.columns : null;
      if (!Array.isArray(returning)) return [];
      const relations = ["table", "from", "using"].flatMap((key) =>
        Array.isArray(ast[key]) ? this.from(ast[key] as unknown[], inner) : [],
      );
      const scope: Scope = { relations, ctes: new Map(), parent: inner };
      this.assign(ast, relations[0], scope);
      return this.projection(returning, scope);
    }
    // SHOW, DESCRIBE, CALL and anything unmodeled may return rows we cannot trace.
    return [rest("opaque")];
  }

  // RETURNING hands back a written column's new value: what SET or the inserted row put there,
  // as well as what the column held before.
  private assign(ast: Node, target: Relation | undefined, scope: Scope): void {
    if (!target) return;
    const put = (column: string | null, value: Value) => {
      if (!column) return;
      const slot = target.slots.find((s) => s.label !== null && this.same(s.label, column));
      if (slot) {
        for (const n of value.names) slot.names.add(n);
        slot.unknown ||= value.unknown;
      } else {
        target.slots.unshift({ label: column, ...join(named([column]), value) });
      }
    };
    // What the inserted row puts in each column, read before anything is written.
    const columns = (Array.isArray(ast.columns) ? ast.columns : []).map((c) =>
      columnLabel(isNode(c) && c.type === "column_ref" ? c.column : c),
    );
    const at = (i: number) =>
      columns.length ? (columns[i] ?? null) : (target.slots[i]?.label ?? null);
    const inserted: [string | null, Value][] = [];
    const values = isNode(ast.values) ? ast.values : null;
    let positionsUnknown = false;
    if (values?.type === "values") {
      for (const row of Array.isArray(values.values) ? values.values : []) {
        const cells = isNode(row) && Array.isArray(row.value) ? row.value : [];
        for (const [i, cell] of cells.entries()) inserted.push([at(i), this.value(cell, scope)]);
      }
    } else if (values) {
      const source = this.statement(isNode(values.ast) ? values.ast : values, scope);
      for (const [i, slot] of source.entries()) inserted.push([at(i), slotValue(slot)]);
      // Without a column list over unlisted columns, where each value lands is unknown.
      positionsUnknown = !columns.length && target.slots.some((s) => s.rest);
    }
    // An upsert's EXCLUDED is the row it tried to insert.
    const excluded: Relation = {
      alias: "excluded",
      slots: inserted
        .filter((e): e is [string, Value] => e[0] !== null)
        .map(([label, value]) => ({ label, ...join(named([label]), value) })),
      using: [],
      natural: false,
      joined: false,
    };
    const setScope: Scope = {
      relations: [...scope.relations, excluded],
      ctes: new Map(),
      parent: scope,
    };
    // Every SET list (UPDATE, MySQL's INSERT ... SET, an upsert's update branch) reads the row as
    // it was, so all of them are evaluated before any is applied.
    const sets: [string | null, Value][] = [];
    walk({ ...ast, returning: null }, (n) => {
      if (!Array.isArray(n.set)) return;
      for (const item of n.set) {
        if (isNode(item)) sets.push([columnLabel(item.column), this.value(item.value, setScope)]);
      }
    });
    for (const [column, value] of [...inserted, ...sets]) put(column, value);
    if (positionsUnknown) {
      target.slots = target.slots.map((s) => (s.rest ? { ...s, rest: "opaque" } : s));
    }
  }

  private withCtes(ast: Node, scope: Scope): Scope {
    if (!Array.isArray(ast.with)) return scope;
    const recursive = ast.with.some((w) => isNode(w) && w.recursive);
    const inner: Scope = { relations: [], ctes: new Map(), parent: scope };
    for (const entry of ast.with) {
      if (!isNode(entry)) continue;
      const name = columnLabel(entry.name);
      if (!name || !isNode(entry.stmt)) continue;
      // Recursion can move a value from one column to another on every pass, so nothing
      // returned through a recursive CTE has a known source.
      if (recursive) inner.ctes.set(this.key(name), [rest("opaque")]);
      const stmt = isNode(entry.stmt.ast) ? entry.stmt.ast : entry.stmt;
      const renames = (Array.isArray(entry.columns) ? entry.columns : [])
        .map((c) => columnLabel(isNode(c) && c.type === "column_ref" ? c.column : c))
        .filter((c): c is string => c !== null);
      const slots = rename(this.statement(stmt, inner), renames);
      // Any of its columns may end up holding any value it ever carried.
      const all = join(...slots.map(slotValue));
      inner.ctes.set(
        this.key(name),
        recursive
          ? [
              ...slots.map((s) => ({ ...s, names: new Set(all.names), unknown: true })),
              rest("opaque"),
            ]
          : slots,
      );
    }
    return inner;
  }

  // INTERSECT binds tighter than UNION and EXCEPT, which the parser's flat chain hides: a branch
  // intersected into a subtracted operand is subtracted too.
  private select(ast: Node, scope: Scope): Slot[] {
    const chain = branches(ast);
    const result = this.branch(chain[0], scope);
    let subtracting = false;
    for (let i = 1; i < chain.length; i++) {
      const op = String(chain[i - 1].set_op ?? "").toLowerCase();
      if (!op.startsWith("intersect")) subtracting = op.startsWith("except") || op === "minus";
      const next = this.branch(chain[i], scope);
      if (!subtracting) merge(result, next);
    }
    return result;
  }

  private branch(ast: Node, outer: Scope): Slot[] {
    const items = Array.isArray(ast.from) ? ast.from : [];
    const scope: Scope = { relations: this.from(items, outer), ctes: new Map(), parent: outer };
    const slots = this.projection(Array.isArray(ast.columns) ? ast.columns : [], scope);
    const sets = items.filter((item) => isNode(item) && SET_JOIN.test(String(item.join ?? "")));
    if (sets.length) {
      // The parser hangs a parenthesized set branch off FROM: its values may land in any column.
      const branched = join(
        ...sets.map((item) =>
          isNode(item) && isNode(item.expr) && isNode(item.expr.ast)
            ? join(...this.statement(item.expr.ast, outer).map(slotValue))
            : NOTHING,
        ),
      );
      return [
        ...slots.map((s) => ({ ...s, names: join(slotValue(s), branched).names, unknown: true })),
        rest("opaque"),
      ];
    }
    return slots;
  }

  private from(items: unknown[], outer: Scope): Relation[] {
    const relations: Relation[] = [];
    // node-sql-parser reads `a NATURAL JOIN b` as `a` aliased "natural" joined to b with no
    // condition, so the shared columns it would merge stay unknown.
    let natural = false;
    for (const [i, item] of items.entries()) {
      if (!isNode(item) || SET_JOIN.test(String(item.join ?? ""))) continue;
      const next = items[i + 1];
      const naturalAlias =
        String(item.as ?? "").toLowerCase() === "natural" && isNode(next) && Boolean(next.join);
      // LATERAL sees the relations listed before it; a plain derived table does not.
      const scope: Scope =
        String(item.prefix ?? "").toLowerCase() === "lateral"
          ? { relations: [...relations], ctes: new Map(), parent: outer }
          : outer;
      const renames = relationColumnAliases(item.as);
      const alias = naturalAlias ? String(item.table ?? "") : relationAlias(item);
      const using = (Array.isArray(item.using) ? item.using : [])
        .map(columnLabel)
        .filter((c): c is string => c !== null);
      const expr = isNode(item.expr) ? item.expr : null;
      const joined = Boolean(item.join);
      // A parenthesized join keeps its own relations, joined to what precedes it as one item.
      if (expr?.type === "tables" && Array.isArray(expr.expr)) {
        const inner = this.from(expr.expr, outer);
        if (inner[0]) inner[0] = { ...inner[0], joined, using: [...using, ...inner[0].using] };
        relations.push(...inner);
        natural = false;
        continue;
      }
      let slots: Slot[];
      if (expr && isNode(expr.ast)) {
        slots = rename(this.statement(expr.ast, scope), renames);
      } else if (expr?.type === "values") {
        slots = rename(this.values(expr, scope), renames);
      } else if (expr?.type === "tablefunc" || isFunctionRelation(item)) {
        // A function in FROM may return one column or a whole record whose content its body
        // decides: only its arguments are known sources, and only a column list names fields.
        const args = this.value(expr?.type === "tablefunc" ? expr.args : (expr ?? item), scope);
        const fields = renames.length ? renames : columnDefinitions(expr);
        slots = fields.length
          ? fields.map((label) => ({ label, names: new Set(args.names), unknown: true }))
          : [{ label: alias, names: new Set(args.names), unknown: true }, rest("opaque")];
      } else if (typeof item.table === "string") {
        slots = rename(this.table(item, outer), renames);
      } else {
        // FLATTEN, GENERATOR or any shape this walker does not model: its columns are unknown.
        slots = [rest("opaque")];
      }
      relations.push({ alias, slots, using, natural, joined });
      natural = naturalAlias;
    }
    return relations;
  }

  private table(item: Node, scope: Scope): Slot[] {
    const name = item.table as string;
    // A three-part name (catalog.schema.table) keys its columns the way analyzeSql does.
    const db = typeof item.db === "string" ? item.db : null;
    const schema = db && typeof item.schema === "string" ? `${db}.${item.schema}` : db;
    const cte = schema === null ? this.cte(scope, name) : undefined;
    if (cte) return cte.map(copy);
    const live = this.columns?.({ schema, name });
    return live
      ? live.map((c): Slot => ({ label: c, names: new Set([c]), unknown: false }))
      : [rest("pass")];
  }

  // Each column of a VALUES list holds what its rows put there, a correlated column included.
  private values(expr: Node, scope: Scope): Slot[] {
    const rows = (Array.isArray(expr.values) ? expr.values : [])
      .map((row) => (isNode(row) && Array.isArray(row.value) ? row.value : []))
      .filter((row) => row.length > 0);
    return (rows[0] ?? []).map((_, i): Slot => {
      const value = join(...rows.map((row) => this.value(row[i], scope)));
      return { label: null, names: value.names, unknown: value.unknown };
    });
  }

  private cte(scope: Scope | undefined, name: string): Slot[] | undefined {
    for (let s = scope; s; s = s.parent) {
      const cte = s.ctes.get(this.key(name));
      if (cte) return cte;
    }
    return undefined;
  }

  private projection(items: unknown[], scope: Scope): Slot[] {
    const out: Slot[] = [];
    for (const item of items) {
      if (!isNode(item)) continue;
      const expr = isNode(item.expr) ? item.expr : null;
      // BigQuery spells `* EXCEPT (...)` as its own node around the star.
      if (item.type === "except" && expr) {
        const excluded = (Array.isArray(item.expr_list) ? item.expr_list : []).map((e) => {
          const ref = isNode(e) && isNode(e.expr) ? e.expr : e;
          return columnLabel(isNode(ref) ? ref.column : null) ?? "";
        });
        out.push(...this.star(expr, scope, excluded));
        continue;
      }
      if (expr?.type === "column_ref" && expr.column === "*") {
        out.push(...this.star(expr, scope, excludedBy(expr)));
        continue;
      }
      const value = expr ? this.value(expr, scope) : NOTHING;
      const label = aliasName(item.as) ?? (expr ? this.implicitLabel(expr) : null);
      out.push({ label, names: new Set(value.names), unknown: value.unknown });
    }
    return out;
  }

  // The name PostgreSQL gives an unaliased output: the column, or the function called. Other
  // engines name an expression by its text, left unnamed here so a lookup stays unknown.
  private implicitLabel(expr: Node): string | null {
    if (expr.type === "column_ref") return columnLabel(expr.column);
    if (expr.type === "double_quote_string" && this.quotedNames) return String(expr.value);
    if (!this.exact) return null;
    if (expr.type === "cast" && isNode(expr.expr)) return this.implicitLabel(expr.expr);
    if (expr.type === "function" || expr.type === "window_func") return nameOf(expr);
    if (expr.type === "aggr_func") return String(expr.name).toLowerCase();
    return null;
  }

  private star(ref: Node, scope: Scope, excluded: string[]): Slot[] {
    const qualifier = columnLabel(ref.table);
    const relations = qualifier
      ? scope.relations.filter((r) => this.same(r.alias, qualifier))
      : scope.relations;
    if (relations.length === 0) return [rest("opaque")];
    const slots = qualifier ? relations.flatMap((r) => r.slots.map(copy)) : this.joined(relations);
    // Stars over stars double at every level (`SELECT * FROM c x, c y`): past any real table's
    // width, the columns are left unknown rather than expanded further.
    if (slots.length > MAX_COLUMNS) return [rest("opaque")];
    return slots.filter((s) => s.label === null || !excluded.some((e) => this.same(e, s.label!)));
  }

  // The columns of the FROM list in order. A comma starts a new group, since JOIN binds tighter;
  // within a group a USING join puts its keys first, once each and holding either side's value,
  // then the remaining columns of each side.
  private joined(relations: Relation[]): Slot[] {
    const groups: Slot[][] = [];
    for (const r of relations) {
      const slots = r.slots.map(copy);
      const prior = r.joined ? groups.pop() : undefined;
      let out = prior ?? [];
      if (r.using.length === 0 || !prior) {
        out = [...out, ...slots];
      } else {
        const isKey = (s: Slot) => s.label !== null && r.using.some((u) => this.same(u, s.label!));
        const keys = r.using.map((u): Slot => {
          const sides = [...out, ...slots].filter((s) => s.label !== null && this.same(s.label, u));
          const value = join(named([u]), ...sides.map(slotValue));
          return { label: u, names: value.names, unknown: value.unknown || sides.length < 2 };
        });
        out = [...keys, ...out.filter((s) => !isKey(s)), ...slots.filter((s) => !isKey(s))];
      }
      groups.push(r.natural ? out.map((s) => ({ ...s, unknown: true })) : out);
    }
    return groups.flat();
  }

  // `SELECT p` or `row_to_json(p)` hands back every column of p, unless p is also a column.
  private wholeRow(expr: Node, scope: Scope): Value | null {
    if (expr.type !== "column_ref" || columnLabel(expr.table)) return null;
    const name = columnLabel(expr.column);
    if (!name) return null;
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      if (
        s.relations.some((r) => r.slots.some((x) => x.label !== null && this.same(x.label, name)))
      )
        return null;
      const relation = s.relations.find((r) => this.same(r.alias, name));
      if (relation) return join(...relation.slots.map(slotValue));
    }
    return null;
  }

  private column(expr: Node, scope: Scope): Value {
    const name = columnLabel(expr.column);
    if (!name) return NOTHING;
    if (name === "*") return join(...this.star(expr, scope, []).map(slotValue));
    const qualifier = columnLabel(expr.table);
    const own = named([name]);
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const relations = qualifier
        ? s.relations.filter((r) => this.same(r.alias, qualifier))
        : s.relations;
      const matches = relations.flatMap((r) =>
        r.slots.filter((x) => x.label !== null && this.same(x.label, name)),
      );
      // A USING key matches on both sides and returns whichever has a row; names that differ only
      // by quoted case cannot be told apart outside PostgreSQL, so every match counts.
      if (matches.length) return join(own, ...matches.map(slotValue));
      // A table read without its column list passes the name through; a function or recursion
      // could have put anything under it, and so could an output this walker left unnamed.
      const unnamed = relations.flatMap((r) =>
        r.slots.filter((x) => x.label === null && !x.rest && x.names.size > 0),
      );
      if (unnamed.length || relations.some((r) => r.slots.some((x) => x.rest === "opaque"))) {
        return { ...join(own, ...unnamed.map(slotValue)), unknown: true };
      }
      if (qualifier ? relations.length : relations.some((r) => r.slots.some((x) => x.rest))) {
        return own;
      }
    }
    return own;
  }

  value(node: unknown, scope: Scope): Value {
    if (!isNode(node)) return NOTHING;
    if (Array.isArray(node)) return join(...node.map((n) => this.value(n, scope)));
    switch (String(node.type ?? "")) {
      case "column_ref":
        // A subscript (`profile['email']`) reads a key out of the column it hangs on.
        return join(
          this.wholeRow(node, scope) ?? this.column(node, scope),
          named(accessorKeys(node)),
        );
      case "binary_expr": {
        const op = String(node.operator).toUpperCase();
        if (JSON_OPERATORS.has(op)) {
          return join(this.value(node.left, scope), named(accessorKeys(node)));
        }
        if (BOOLEAN_OPS.has(op)) return NOTHING;
        return join(this.value(node.left, scope), this.value(node.right, scope));
      }
      case "unary_expr":
        return String(node.operator).toUpperCase() === "NOT"
          ? NOTHING
          : this.value(node.expr, scope);
      case "function": {
        // The grammar's NOT and EXISTS arrive as calls; a qualified or quoted "not" is a user's.
        const name = isNode(node.name) ? node.name : {};
        const part = Array.isArray(name.name) && isNode(name.name[0]) ? name.name[0] : null;
        const grammar = !name.schema && part?.type !== "double_quote_string";
        const fn = nameOf(node).toLowerCase();
        if (grammar && (fn === "not" || fn === "exists")) return NOTHING;
        // Every argument may reach the result (a JSON constructor's values, JSON_SET's new one);
        // an extractor adds the keys it reads.
        return join(this.value(node.args, scope), named(accessorKeys(node)));
      }
      case "aggr_func": {
        // A count returns how many, never what it counted; FILTER, OVER and the aggregate's own
        // ORDER BY only choose rows, while WITHIN GROUP's ORDER BY supplies the value returned.
        if (String(node.name).toUpperCase() === "COUNT") return NOTHING;
        const args = isNode(node.args) ? node.args : {};
        const within = Array.isArray(node.within_group_orderby)
          ? node.within_group_orderby.map((o) => (isNode(o) ? o.expr : null))
          : [];
        // BigQuery's ARRAY_AGG hands its argument over directly rather than under `expr`.
        return join(
          this.value("expr" in args ? args.expr : args, scope),
          this.value(args.separator, scope),
          ...within.map((w) => this.value(w, scope)),
        );
      }
      case "window_func":
        return this.value(node.args, scope);
      case "case":
        return join(
          ...(Array.isArray(node.args) ? node.args : []).map((arm) =>
            isNode(arm) ? this.value(arm.result, scope) : NOTHING,
          ),
        );
      case "cast":
        return this.value(node.expr, scope);
      case "expr_list":
        return this.value(node.value, scope);
      case "array":
        return this.value(node.expr_list, scope);
      // MySQL and BigQuery accept a column as an interval's amount.
      case "interval":
        return this.value(node.expr, scope);
      case "extract":
        return this.value(isNode(node.args) ? node.args.source : null, scope);
      case "double_quote_string":
        return this.quotedNames && typeof node.value === "string"
          ? this.column({ type: "column_ref", table: null, column: node.value }, scope)
          : NOTHING;
      case "number":
      case "bool":
      case "null":
      case "star":
      case "param":
      case "var":
      case "default":
      case "origin":
      case "single_quote_string":
      case "natural_string":
      case "hex_string":
      case "bit_string":
      case "full_hex_string":
      case "string":
      case "var_string":
        return NOTHING;
    }
    // A scalar subquery returns what its own projection returns.
    if (isNode(node.ast)) {
      return join(...this.statement(node.ast, scope).map(slotValue));
    }
    return this.unmodeled(node, scope);
  }

  // A shape this walker does not model: its columns count as returned, and a subquery, window
  // or filter inside it, whose row-picking parts it cannot tell from its values, makes it unknown.
  private unmodeled(node: Node, scope: Scope): Value {
    let opaque = false;
    const parts: Value[] = [];
    const visit = (n: unknown): void => {
      if (Array.isArray(n)) {
        for (const child of n) visit(child);
        return;
      }
      if (!isNode(n)) return;
      if (isNode(n.ast) || n.type === "select" || isNode(n.over) || isNode(n.filter)) {
        opaque = true;
        return;
      }
      if (n.type === "column_ref") {
        parts.push(this.value(n, scope));
        return;
      }
      parts.push(named(accessorKeys(n)));
      for (const key of Object.keys(n)) visit(n[key]);
    };
    visit(node);
    const value = join(...parts);
    return opaque ? { ...value, unknown: true } : value;
  }
}

// The set-operation chain: each node carries the operator joining it to its `_next`.
function branches(ast: Node): Node[] {
  const out: Node[] = [];
  for (let b: unknown = ast; isNode(b); b = b._next) out.push(b);
  return out;
}

function slotValue(slot: Slot): Value {
  const names = new Set(slot.names);
  if (slot.label !== null) names.add(slot.label);
  return { names, unknown: slot.unknown };
}

function nameOf(node: Node): string {
  let name = "";
  walk(node.name, (n) => {
    if (!name && typeof n.value === "string") name = n.value;
  });
  return name;
}

// A positional rename (`AS f(a, b)`, `WITH x(a, b)`): each new label keeps what its column held.
// Past an unexpanded star the positions are unknown, so those labels hold anything.
function rename(slots: Slot[], labels: string[]): Slot[] {
  if (labels.length === 0) return slots;
  const at = slots.findIndex((s) => s.rest);
  const out = labels.map((label, i): Slot => {
    if (at !== -1 && i >= at) return { label, names: new Set(), unknown: true };
    const from = slots[i];
    return from ? { label, ...slotValue(from) } : { label, names: new Set(), unknown: false };
  });
  // Columns past the list keep their own names, an unexpanded star included.
  return [...out, ...slots.slice(at !== -1 && labels.length > at ? at : labels.length)];
}

// UNION and INTERSECT: the first branch names the columns, every branch supplies values.
function merge(into: Slot[], next: Slot[]): void {
  const aligned = into.length === next.length && ![...into, ...next].some((s) => s.rest);
  if (!aligned) {
    const all = join(...next.map(slotValue));
    for (const slot of into) {
      for (const n of all.names) slot.names.add(n);
      slot.unknown = true;
    }
    return;
  }
  next.forEach((slot, i) => {
    for (const n of slot.names) into[i].names.add(n);
    into[i].unknown ||= slot.unknown;
  });
}

// "f(a, b)" names the relation f; a bare alias or the table's own name otherwise. A typed table
// function (`jsonb_to_recordset(...) AS x(email text)`) keeps its alias inside the call node.
function relationAlias(item: Node): string {
  const alias = aliasName(item.as);
  if (alias) return alias.replace(/\(.*$/, "").trim();
  if (typeof item.table === "string") return item.table;
  const expr = isNode(item.expr) ? item.expr : null;
  if (expr?.type === "tablefunc" && isNode(expr.as)) return nameOf(expr.as);
  return expr ? nameOf(expr) : "";
}

// The fields a typed table function declares: `AS x(email text, n int)`.
function columnDefinitions(expr: Node | null): string[] {
  const as = expr && isNode(expr.as) ? expr.as : null;
  const list = as && isNode(as.args) && Array.isArray(as.args.value) ? as.args.value : [];
  return list
    .map((d) => (isNode(d) && isNode(d.column) ? columnLabel(d.column.column) : null))
    .filter((c): c is string => c !== null);
}

// Snowflake hangs `* EXCLUDE (...)` off the star itself.
function excludedBy(ref: Node): string[] {
  const suffix = isNode(ref.suffix) ? ref.suffix : null;
  if (!suffix || nameOf(suffix).toLowerCase() !== "exclude") return [];
  const list = isNode(suffix.args) && Array.isArray(suffix.args.value) ? suffix.args.value : [];
  return list.map((c) => columnLabel(isNode(c) ? c.column : null) ?? "");
}

export function analyzeOutput(sql: string, dialect: string, columns?: Columns): QueryOutput | null {
  let ast: unknown;
  try {
    const input = prepareSql(sql, dialect);
    ast = input.restoreAst(parser.astify(input.sql, { database: dialect }));
  } catch {
    return null;
  }
  const resolver = new Resolver(columns, dialect);
  const root: Scope = { relations: [], ctes: new Map() };
  let slots: Slot[];
  try {
    slots = (Array.isArray(ast) ? ast : [ast])
      .filter(isNode)
      .flatMap((statement) => resolver.statement(statement, root));
  } catch {
    // The agent's SQL is untrusted: a shape that breaks the walker leaves the output untraced
    // instead of breaking the card, the decision or the trail.
    return { names: [], complete: false };
  }
  const names = new Set<string>();
  for (const slot of slots) for (const n of slotValue(slot).names) names.add(n);
  return { names: [...names], complete: !slots.some((s) => s.unknown) };
}

// The reviewer's annotation: the statement's tables, and the person and client data among the
// names of what it returns. Output that does not parse counts as untraced.
export function outputSchema(tables: string[], output: QueryOutput | null): SchemaContext {
  const names = output?.names ?? [];
  return {
    tables,
    pii: piiColumns(names),
    client: clientColumns(names),
    complete: output?.complete ?? false,
  };
}

// What the statement text alone shows: no table columns, so a SELECT * stays untraced here.
// The Audit Trail reads this instead of querying the database it audits.
export function textSchema(sql: string, dialect: string): SchemaContext | null {
  const parsed = analyzeSql(sql, dialect);
  return parsed ? outputSchema(parsed.tables.map(formatRef), analyzeOutput(sql, dialect)) : null;
}
