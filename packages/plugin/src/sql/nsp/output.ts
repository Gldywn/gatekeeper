import {
  copy,
  hiddenRelation,
  insertedRows,
  join,
  jsonObjectKeys,
  merge,
  NOTHING,
  named,
  OutputModel,
  type Relation,
  rename,
  rest,
  type Scope,
  type Slot,
  slotValue,
  summary,
  type Value,
  type Written,
  whole,
} from "../output-model";
import type { Columns, QueryOutput } from "../schema";
import { JSON_OPERATORS, jsonKeyNames } from "../schema";
import {
  accessorKeys,
  aliasName,
  COMPARISON_OPS,
  columnLabel,
  isFunctionRelation,
  isJsonFunction,
  isNode,
  relationColumnAliases,
  stringLiteral,
  walk,
} from "./inspect";
import { parser } from "./parser";

type Node = Record<string, unknown>;

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
// The statements that write rows, whose reads count even without RETURNING.
const WRITES = new Set(["insert", "replace", "update", "delete"]);
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
// Engines whose double quotes delimit an identifier that node-sql-parser keeps as a string.
const QUOTED_IDENTIFIERS = new Set(["sqlite", "transactsql", "snowflake"]);

class Resolver extends OutputModel {
  // Engines read with the PostgreSQL grammar name an unaliased output as PostgreSQL does.
  private readonly pgLabels: boolean;

  // Where a double-quoted name is an identifier but reaches here as a string node.
  private readonly quotedNames: boolean;

  private readonly dialect: string;

  // The parser keeps names as written, never folded as the engine folds them: compared without case.
  constructor(columns: Columns | undefined, dialect: string) {
    super(columns, false);
    this.pgLabels = dialect === "postgresql";
    this.quotedNames = QUOTED_IDENTIFIERS.has(dialect);
    this.dialect = dialect;
  }

  // A nested statement is reached while resolving values and again while collecting reads.
  private readonly resolved = new WeakMap<Node, Slot[]>();

  // Snowflake's `u.profile:contact.email` and BigQuery's `user.email`, where no relation is named
  // `user`, read fields of a column rather than a column of a table: that column, and the fields.
  private path(node: Node, scope: Scope): { base: Node; fields: string[] } | null {
    if (typeof node.column !== "string") return null;
    // `notations[i]` separates segment i from segment i + 1.
    const notations = Array.isArray(node.notations) ? node.notations : [];
    const segments = [node.schema, node.table, node.column]
      .map(columnLabel)
      .filter((s): s is string => s !== null);
    const colon = notations.indexOf(":");
    if (colon !== -1 && colon < segments.length - 1) {
      const named = (Array.isArray(node.array_index) ? node.array_index : []).flatMap((e) =>
        isNode(e) && e.notation === "." && isNode(e.index) && typeof e.index.value === "string"
          ? [e.index.value]
          : [],
      );
      return {
        base: { type: "column_ref", table: segments[colon - 1] ?? null, column: segments[colon] },
        fields: [...segments.slice(colon + 1), ...named],
      };
    }
    const qualifier = columnLabel(node.table);
    const struct =
      this.dialect === "bigquery" &&
      qualifier !== null &&
      !node.schema &&
      !this.knows(qualifier, scope) &&
      this.holds(qualifier, scope);
    return struct
      ? {
          base: { type: "column_ref", table: null, column: qualifier },
          fields: [node.column, ...subFields(node)],
        }
      : null;
  }

  statement(ast: Node, scope: Scope): Slot[] {
    const done = this.resolved.get(ast);
    if (done) return done.map(copy);
    const out = this.resolve(ast, scope);
    this.resolved.set(ast, out.map(copy));
    return out;
  }

  private resolve(ast: Node, scope: Scope): Slot[] {
    const type = String(ast.type ?? "").toLowerCase();
    const inner = this.withCtes(ast, scope);
    if (type === "select") {
      return branches(ast).some((b) => isNode(b.into) && b.into.type === "into")
        ? []
        : this.select(ast, inner);
    }
    if (NO_ROWS.has(type)) {
      // Without RETURNING a write hands back nothing, but still reads documents a query may
      // return, as a modifying CTE does: its scopes are walked all the same.
      const returning = isNode(ast.returning) ? ast.returning.columns : [];
      if (!Array.isArray(returning) || (!WRITES.has(type) && returning.length === 0)) return [];
      const relations = ["table", "from", "using"].flatMap((key) =>
        Array.isArray(ast[key]) ? this.from(ast[key] as unknown[], inner) : [],
      );
      const scope: Scope = { relations, ctes: new Map(), parent: inner };
      const target = relations[0];
      const before = target?.slots.map(copy) ?? [];
      const excluded = this.assign(ast, target, scope);
      // PostgreSQL 18 names the row before and after the write.
      if (target) {
        relations.push(
          hiddenRelation("old", before),
          hiddenRelation("new", target.slots.map(copy)),
        );
      }
      const out = this.projection(returning, scope);
      // Every clause but RETURNING reads the row as it was, and an upsert's EXCLUDED.
      const was: Scope = {
        ...scope,
        relations: [
          ...relations.map((r) => (r === target ? { ...r, slots: before } : r)),
          ...(excluded ? [excluded] : []),
        ],
      };
      this.reads({ ...ast, returning: null, values: null }, was);
      this.reads({ values: ast.values }, inner);
      this.reads({ returning: ast.returning }, scope);
      return out;
    }
    // SHOW, DESCRIBE, CALL and anything unmodeled may return rows we cannot trace.
    return [rest("opaque")];
  }

  // What the inserted row puts in each column, read before anything is written, then every SET
  // list (UPDATE, MySQL's INSERT ... SET, an upsert's update branch).
  private assign(ast: Node, target: Relation | undefined, scope: Scope): Relation | undefined {
    if (!target) return undefined;
    // An INSERT's rows never see the table they go into.
    const source = scope.parent ?? scope;
    const columns = (Array.isArray(ast.columns) ? ast.columns : []).map((c) =>
      columnLabel(isNode(c) && c.type === "column_ref" ? c.column : c),
    );
    const destinations = columns.length ? columns : target.slots.map((s) => s.label);
    let inserted: Written[] = [];
    const values = isNode(ast.values) ? ast.values : null;
    if (values?.type === "values") {
      for (const row of Array.isArray(values.values) ? values.values : []) {
        const cells = isNode(row) && Array.isArray(row.value) ? row.value : [];
        for (const [i, cell] of cells.entries()) {
          inserted.push([destinations[i] ?? null, this.value(cell, source)]);
        }
      }
    } else if (values) {
      const rows = this.statement(isNode(values.ast) ? values.ast : values, source);
      inserted = insertedRows(rows, destinations);
    }
    return this.write(target, scope, inserted, (setScope) => {
      const sets: Written[] = [];
      walk({ ...ast, returning: null }, (n) => {
        if (!Array.isArray(n.set)) return;
        for (const item of n.set) {
          if (isNode(item)) sets.push([columnLabel(item.column), this.value(item.value, setScope)]);
        }
      });
      return sets;
    });
  }

  private withCtes(ast: Node, scope: Scope): Scope {
    if (!Array.isArray(ast.with)) return scope;
    const recursive = ast.with.some((w) => isNode(w) && w.recursive);
    const inner: Scope = { relations: [], ctes: new Map(), parent: scope };
    for (const entry of ast.with) {
      if (!isNode(entry)) continue;
      const name = columnLabel(entry.name);
      if (!name || !isNode(entry.stmt)) continue;
      if (recursive) inner.ctes.set(name, [rest("opaque")]);
      const stmt = isNode(entry.stmt.ast) ? entry.stmt.ast : entry.stmt;
      const renames = (Array.isArray(entry.columns) ? entry.columns : [])
        .map((c) => columnLabel(isNode(c) && c.type === "column_ref" ? c.column : c))
        .filter((c): c is string => c !== null);
      this.defineCte(inner, name, rename(this.statement(stmt, inner), renames), recursive);
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
    // The parser hangs a parenthesized set branch off FROM: its values may land in any column.
    const branched = whole(
      ...sets.map((item) =>
        isNode(item) && isNode(item.expr) && isNode(item.expr.ast)
          ? whole(...this.statement(item.expr.ast, outer).map(slotValue))
          : NOTHING,
      ),
    );
    this.reads(ast, scope);
    if (sets.length === 0) return slots;
    return [
      ...slots.map((s) => ({ ...s, ...whole(slotValue(s), branched), unknown: true })),
      rest("opaque"),
    ];
  }

  // A key read out of a column anywhere in the statement (a filter, a join, the select list)
  // shows what that column holds wherever the statement returns it unchanged.
  private reads(ast: Node, scope: Scope): void {
    const visit = (n: unknown): void => {
      if (Array.isArray(n)) {
        for (const child of n) visit(child);
        return;
      }
      if (!isNode(n)) return;
      if (isNode(n.ast) || n.type === "select") {
        this.statement(isNode(n.ast) ? n.ast : n, scope);
        return;
      }
      // A JSON function reads its documents in ways only its own semantics could name: whatever
      // returns one of them is untraced.
      if ((n.type === "function" || n.type === "tablefunc") && isJsonFunction(n)) {
        for (const doc of this.sources(n.args, scope).docs ?? []) doc.opaque = true;
      }
      const keys = this.keysRead(n, scope);
      if (keys.length) this.learn(this.source(n, scope), keys);
      for (const key of Object.keys(n)) visit(n[key]);
    };
    // The next set branch and the CTEs read within scopes of their own.
    for (const [key, child] of Object.entries(ast)) {
      if (key !== "_next" && key !== "with") visit(child);
    }
  }

  // The keys the grammar shows a node reading out of a document: a JSON operator, a subscript, a
  // field, a key test. A function's arguments name no key: only its semantics could tell a key
  // from a value.
  private keysRead(n: Node, scope: Scope): string[] {
    if (n.type === "function" || n.type === "tablefunc") return [];
    if (n.type === "binary_expr" && KEY_TESTS.has(String(n.operator))) return testedKeys(n);
    const subscript = isNode(n.column) ? offsetKeys(n.column.offset) : [];
    const fields = n.type === "column_ref" ? (this.path(n, scope)?.fields ?? []) : [];
    return [...accessorKeys(n), ...subFields(n), ...subscript, ...fields];
  }

  // The document a key is read from: through JSON operators, key tests and casts down to a
  // column, or whatever value hands one back (`COALESCE(profile, '{}')`).
  private source(node: unknown, scope: Scope): Value {
    if (!isNode(node)) return NOTHING;
    const op = String(node.operator ?? "");
    if (node.type === "cast") return this.source(node.expr, scope);
    if (node.type === "binary_expr" && (JSON_OPERATORS.has(op) || KEY_TESTS.has(op))) {
      return this.source(node.left, scope);
    }
    if (node.type === "column_ref") {
      const inner = isNode(node.column) && isNode(node.column.expr) ? node.column.expr : null;
      if (inner?.type === "column_ref") {
        return this.source({ ...inner, table: inner.table ?? node.table }, scope);
      }
      const path = this.path(node, scope);
      return path ? this.source(path.base, scope) : this.columnAt(node, scope);
    }
    return this.value(node, scope);
  }

  // What a list of arguments hands over of the documents it reads from, parts included.
  private sources(args: unknown, scope: Scope): Value {
    const list = isNode(args) && Array.isArray(args.value) ? args.value : [args];
    return whole(...list.map((a) => this.source(a, scope)));
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
      // A parenthesized join yields one joined table, joined as a whole to what precedes it; its
      // relations stay reachable by name.
      if (expr?.type === "tables" && Array.isArray(expr.expr)) {
        const inner = this.from(expr.expr, outer);
        const slots = this.joined(inner);
        relations.push({ alias: aliasName(item.as) ?? "", slots, using, natural, joined });
        relations.push(...inner.map((r): Relation => ({ ...r, hidden: true })));
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
        // Its arguments see the items before it, LATERAL or not.
        const sees: Scope = { relations: [...relations], ctes: new Map(), parent: outer };
        const call = expr ?? item;
        const args = this.value(expr?.type === "tablefunc" ? expr.args : call, sees);
        // What it unpacks (`jsonb_array_elements(u.profile->'contacts')`) comes out of those
        // documents, so a key read through its columns is read from them.
        const unpacked = this.sources(call.args, sees).docs;
        const fields = renames.length ? renames : columnDefinitions(expr);
        const field = (label: string | null): Slot => ({
          label,
          names: new Set(args.names),
          unknown: true,
          docs: unpacked,
        });
        slots = fields.length ? fields.map(field) : [field(alias), rest("opaque")];
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
    // A three-part name (catalog.schema.table) keys its columns the way analyzeSql does.
    const db = typeof item.db === "string" ? item.db : null;
    const schema = db && typeof item.schema === "string" ? `${db}.${item.schema}` : db;
    return this.relation(schema, item.table as string, scope);
  }

  private values(expr: Node, scope: Scope): Slot[] {
    const rows = (Array.isArray(expr.values) ? expr.values : [])
      .map((row) => (isNode(row) && Array.isArray(row.value) ? row.value : []))
      .filter((row) => row.length > 0);
    return (rows[0] ?? []).map(
      (_, i): Slot => ({ label: null, ...whole(...rows.map((row) => this.value(row[i], scope))) }),
    );
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
        out.push(...this.starAt(expr, scope, excluded));
        continue;
      }
      // BigQuery's `* REPLACE (b.email AS note)`: the star's `note` holds the replacement.
      if (item.type === "replace" && expr) {
        const slots = this.starAt(expr, scope, []);
        for (const e of Array.isArray(item.expr_list) ? item.expr_list : []) {
          const label = isNode(e) ? aliasName(e.as) : null;
          if (!label || !isNode(e)) continue;
          const value = whole(named([label]), this.value(e.expr, scope));
          const slot = slots.find((s) => s.label !== null && this.same(s.label, label));
          if (slot) {
            slot.names = value.names;
            slot.unknown = value.unknown;
            slot.docs = value.docs;
          } else if (slots.some((s) => s.rest)) {
            // The star's columns are unknown: keep what replaces one of them, untraced.
            slots.push({ label, names: value.names, unknown: true, docs: value.docs });
          }
        }
        out.push(...slots);
        continue;
      }
      if (expr?.type === "column_ref" && expr.column === "*") {
        out.push(...this.starAt(expr, scope, excludedBy(expr)));
        continue;
      }
      const value = expr ? this.value(expr, scope) : NOTHING;
      const label = aliasName(item.as) ?? (expr ? this.implicitLabel(expr) : null);
      out.push({ label, names: new Set(value.names), unknown: value.unknown, docs: value.docs });
    }
    return out;
  }

  // The name PostgreSQL gives an unaliased output: the column, or the function called. Other
  // engines name an expression by its text, left unnamed here so a lookup stays unknown.
  private implicitLabel(expr: Node): string | null {
    // BigQuery names `t.user.email` after its last field.
    const fields = subFields(expr);
    if (expr.type === "column_ref" && fields.length) return fields[fields.length - 1];
    if (expr.type === "column_ref") return columnLabel(expr.column);
    if (expr.type === "double_quote_string" && this.quotedNames) return String(expr.value);
    if (!this.pgLabels) return null;
    if (expr.type === "cast" && isNode(expr.expr)) return this.implicitLabel(expr.expr);
    if (expr.type === "function" || expr.type === "window_func") return nameOf(expr);
    if (expr.type === "aggr_func") return String(expr.name).toLowerCase();
    return null;
  }

  private starAt(ref: Node, scope: Scope, excluded: string[]): Slot[] {
    return this.star(columnLabel(ref.table), scope, excluded);
  }

  private wholeRowAt(expr: Node, scope: Scope): Value | null {
    if (expr.type !== "column_ref" || columnLabel(expr.table)) return null;
    const name = columnLabel(expr.column);
    return name ? this.wholeRow(name, scope) : null;
  }

  private columnAt(expr: Node, scope: Scope): Value {
    const name = columnLabel(expr.column);
    if (!name) return NOTHING;
    if (name === "*") return whole(...this.starAt(expr, scope, []).map(slotValue));
    return this.column(columnLabel(expr.table), name, scope);
  }

  value(node: unknown, scope: Scope): Value {
    if (!isNode(node)) return NOTHING;
    if (Array.isArray(node)) return whole(...node.map((n) => this.value(n, scope)));
    switch (String(node.type ?? "")) {
      case "column_ref": {
        // BigQuery nests a subscripted column (`p.profile['email']`) inside the reference.
        const inner = isNode(node.column) && isNode(node.column.expr) ? node.column.expr : null;
        if (inner?.type === "column_ref" && isNode(node.column)) {
          return join(
            this.value({ ...inner, table: inner.table ?? node.table }, scope),
            named(offsetKeys(node.column.offset)),
          );
        }
        const path = this.path(node, scope);
        if (path) return join(this.value(path.base, scope), named(path.fields));
        // A subscript (`profile['email']`) or a struct path (`t.user.email`) reads a key out of
        // the column it hangs on, which is then no longer returned whole.
        const base = this.wholeRowAt(node, scope) ?? this.columnAt(node, scope);
        const indexed = Array.isArray(node.array_index) && node.array_index.length > 0;
        if (!indexed && subFields(node).length === 0) return base;
        return join(base, named([...accessorKeys(node), ...subFields(node)]));
      }
      case "binary_expr": {
        const op = String(node.operator).toUpperCase();
        if (JSON_OPERATORS.has(op)) {
          const left = this.value(node.left, scope);
          // A key a column or a parameter supplies (`profile->>k.name`) may be any key.
          const right =
            isNode(node.right) && isNode(node.right.expr_list)
              ? node.right.expr_list.value
              : node.right;
          return (Array.isArray(right) ? right : [right]).every(fixedKey)
            ? join(left, named(accessorKeys(node)))
            : { ...whole(left), unknown: true };
        }
        if (BOOLEAN_OPS.has(op)) return NOTHING;
        const sides = [this.value(node.left, scope), this.value(node.right, scope)];
        // `profile - 'email'` and `#-` remove a key: the document is no longer the one returned.
        return op === "-" || op === "#-" ? join(...sides) : whole(...sides);
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
        // Every argument may reach the result, documents included. A JSON function's literals may
        // be paths, keys or values, which only its semantics tell apart: its result is untraced.
        const args = whole(this.value(node.args, scope));
        return isJsonFunction(node) ? { ...args, unknown: true } : args;
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
        return whole(
          this.value("expr" in args ? args.expr : args, scope),
          this.value(args.separator, scope),
          ...within.map((w) => this.value(w, scope)),
        );
      }
      case "window_func":
        return this.value(node.args, scope);
      case "case":
        return whole(
          ...(Array.isArray(node.args) ? node.args : []).map((arm) =>
            isNode(arm) ? this.value(arm.result, scope) : NOTHING,
          ),
        );
      case "cast":
        return this.value(node.expr, scope);
      case "expr_list":
        return this.value(node.value, scope);
      // BigQuery keeps a bracket literal's elements (`[email, phone]`) under `array_path`.
      case "array":
        if (!isNode(node.expr_list) && !Array.isArray(node.array_path)) {
          return this.unmodeled(node, scope);
        }
        return whole(
          this.value(node.expr_list, scope),
          ...(Array.isArray(node.array_path) ? node.array_path : []).map((e) =>
            isNode(e) ? this.value(e.expr, scope) : NOTHING,
          ),
        );
      // MySQL and BigQuery accept a column as an interval's amount.
      case "interval":
        return this.value(node.expr, scope);
      case "extract":
        return this.value(isNode(node.args) ? node.args.source : null, scope);
      case "double_quote_string":
        return this.quotedNames && typeof node.value === "string"
          ? this.column(null, node.value, scope)
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
      return whole(...this.statement(node.ast, scope).map(slotValue));
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
      if (n.type === "function" && isJsonFunction(n)) opaque = true;
      else parts.push(named(accessorKeys(n)));
      for (const key of Object.keys(n)) visit(n[key]);
    };
    visit(node);
    const value = join(...parts);
    return opaque ? { ...value, unknown: true } : value;
  }
}

// A key the statement spells out, as opposed to one a column or a parameter supplies.
function fixedKey(n: unknown): boolean {
  if (!isNode(n)) return true;
  if (stringLiteral(n) !== null || n.type === "number" || n.type === "null") return true;
  if (n.type === "cast") return fixedKey(n.expr);
  const list = isNode(n.expr_list) ? n.expr_list.value : null;
  return n.type === "array" && Array.isArray(list) && list.every(fixedKey);
}

function literalKeys(node: unknown): string[] {
  const keys: string[] = [];
  walk(node, (n) => {
    const text = stringLiteral(n);
    if (text !== null) keys.push(...jsonObjectKeys(text));
  });
  return keys;
}

// Operators that test a document for keys: `? 'ssn'`, `?| array['a', 'b']`, `@> '{"ssn": 1}'`.
const KEY_TESTS = new Set(["?", "?|", "?&", "@>"]);
function testedKeys(node: Node): string[] {
  if (node.operator === "@>") return literalKeys(node.right);
  const keys: string[] = [];
  walk(node.right, (n) => {
    const text = stringLiteral(n);
    if (text !== null) keys.push(...jsonKeyNames(text));
  });
  return keys;
}

// The set-operation chain: each node carries the operator joining it to its `_next`.
function branches(ast: Node): Node[] {
  const out: Node[] = [];
  for (let b: unknown = ast; isNode(b); b = b._next) out.push(b);
  return out;
}

function nameOf(node: Node): string {
  let name = "";
  walk(node.name, (n) => {
    if (!name && typeof n.value === "string") name = n.value;
  });
  return name;
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

// The fields BigQuery reads past a column (`t.user.email`), kept by the parser as `subFields`.
function subFields(node: Node): string[] {
  return Array.isArray(node.subFields)
    ? node.subFields.filter((f): f is string => typeof f === "string")
    : [];
}

// The string keys of a BigQuery subscript (`profile['email']`).
function offsetKeys(offset: unknown): string[] {
  return (Array.isArray(offset) ? offset : [])
    .map((o) => (isNode(o) && isNode(o.value) ? o.value.value : null))
    .filter((v): v is string => typeof v === "string");
}

// Snowflake hangs `* EXCLUDE (...)` off the star itself.
function excludedBy(ref: Node): string[] {
  const suffix = isNode(ref.suffix) ? ref.suffix : null;
  if (!suffix || nameOf(suffix).toLowerCase() !== "exclude") return [];
  const list = isNode(suffix.args) && Array.isArray(suffix.args.value) ? suffix.args.value : [];
  return list.map((c) => columnLabel(isNode(c) ? c.column : null) ?? "");
}

export function outputNsp(sql: string, grammar: string, columns?: Columns): QueryOutput | null {
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: grammar });
  } catch {
    return null;
  }
  const resolver = new Resolver(columns, grammar);
  const root: Scope = { relations: [], ctes: new Map() };
  try {
    return summary(
      (Array.isArray(ast) ? ast : [ast])
        .filter(isNode)
        .flatMap((statement) => resolver.statement(statement, root)),
    );
  } catch {
    // The agent's SQL is untrusted: a shape that breaks the walker leaves the output untraced
    // instead of breaking the card, the decision or the trail.
    return { names: [], complete: false };
  }
}
