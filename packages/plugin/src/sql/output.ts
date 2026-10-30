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
  jsonKeyNames,
  piiColumns,
  relationColumnAliases,
  type SchemaContext,
  stringLiteral,
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

// A table column as a document: the keys the statement reads out of it anywhere. A column of a
// table read without its column list also lends its keys to that table's whole row.
interface Doc {
  keys: Set<string>;
  row?: Doc;
  // Some key was read through a value that may hold another column instead.
  uncertain?: boolean;
  // A name several tables may own: one of these documents, nobody can tell which.
  of?: Doc[];
}
// One returned column. A `rest` slot stands for columns nobody could list: a table's own
// ("pass", a column read through it keeps its name) or a function's or recursion's ("opaque").
interface Slot {
  label: string | null;
  names: Set<string>;
  unknown: boolean;
  rest?: "pass" | "opaque";
  // The columns it hands back unchanged, so the keys read from them describe it too.
  docs?: Doc[];
  // The table a "pass" rest stands for.
  table?: string;
}
interface Relation {
  alias: string;
  slots: Slot[];
  // The keys a USING join shares with the relations before it: returned once, from either side.
  using: string[];
  natural: boolean;
  // Joined to the item before it, rather than listed after a comma.
  joined: boolean;
  // Reachable by name (`b.*`, `new.memo`) but not a column group of its own in an unqualified
  // star: the relations inside a parenthesized join, RETURNING's `old` and `new`.
  hidden?: true;
}
interface Scope {
  relations: Relation[];
  ctes: Map<string, Slot[]>;
  parent?: Scope;
}
interface Value {
  names: Set<string>;
  unknown: boolean;
  docs?: Doc[];
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
// Values that may hand back the columns they carry, unchanged or wrapped: a part of a document
// (`profile->'contact'`) or one with a key removed goes through `join` instead.
const whole = (...values: Value[]): Value => ({
  ...join(...values),
  docs: [...new Set(values.flatMap((v) => v.docs ?? []))],
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

  private readonly dialect: string;

  constructor(columns: Columns | undefined, dialect: string) {
    this.columns = columns;
    this.exact = dialect === "postgresql";
    this.quotedNames = QUOTED_IDENTIFIERS.has(dialect);
    this.dialect = dialect;
  }

  // One per table column, so every reference to that column, from any relation or level, meets
  // the same keys.
  private readonly documents = new Map<string, Doc>();

  // A nested statement is reached while resolving values and again while collecting reads.
  private readonly resolved = new WeakMap<Node, Slot[]>();

  private key(name: string): string {
    return this.exact ? name : name.toLowerCase();
  }

  private same(a: string, b: string): boolean {
    return this.key(a) === this.key(b);
  }

  private doc(table: string, column: string | null): Doc {
    const id = column === null ? table : `${table}\u0000${this.key(column)}`;
    let doc = this.documents.get(id);
    if (!doc) {
      doc = { keys: new Set(), row: column === null ? undefined : this.doc(table, null) };
      this.documents.set(id, doc);
    }
    return doc;
  }

  private knows(alias: string, scope: Scope | undefined): boolean {
    for (let s = scope; s; s = s.parent) {
      if (s.relations.some((r) => this.same(r.alias, alias))) return true;
    }
    return false;
  }

  // Snowflake's `profile:email`, and BigQuery's `user.email` where no relation is named `user`,
  // read a field of a column rather than a column of a table: the column read.
  private path(node: Node, scope: Scope): Node | null {
    const qualifier = columnLabel(node.table);
    if (!qualifier || typeof node.column !== "string") return null;
    const colon = Array.isArray(node.notations) && node.notations.includes(":");
    const struct =
      this.dialect === "bigquery" && !this.knows(qualifier, scope) && this.holds(qualifier, scope);
    return colon || struct ? { type: "column_ref", table: null, column: qualifier } : null;
  }

  // Some relation in reach has a column of that name, or columns nobody could list.
  private holds(name: string, scope: Scope | undefined): boolean {
    for (let s = scope; s; s = s.parent) {
      for (const r of s.relations) {
        if (r.hidden) continue;
        if (
          r.slots.some((x) => x.rest === "pass" || (x.label !== null && this.same(x.label, name)))
        )
          return true;
      }
    }
    return false;
  }

  // Keys read out of a document whose column may be one of several, or may not be the one it
  // looks like, describe each candidate and leave the output untraced.
  private learn(base: Value, keys: string[]): void {
    const docs = (base.docs ?? []).flatMap((d) => d.of ?? [d]);
    for (const doc of docs) {
      if (docs.length > 1 || base.unknown) doc.uncertain = true;
      for (const k of keys) {
        doc.keys.add(k);
        doc.row?.keys.add(k);
      }
    }
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
      const returning = isNode(ast.returning) ? ast.returning.columns : null;
      if (!Array.isArray(returning)) return [];
      const relations = ["table", "from", "using"].flatMap((key) =>
        Array.isArray(ast[key]) ? this.from(ast[key] as unknown[], inner) : [],
      );
      const scope: Scope = { relations, ctes: new Map(), parent: inner };
      const target = relations[0];
      const before = target?.slots.map(copy) ?? [];
      const excluded = this.assign(ast, target, scope);
      // PostgreSQL 18 names the row before and after the write.
      if (target) {
        const row = (alias: string, slots: Slot[]): Relation => ({
          alias,
          slots,
          using: [],
          natural: false,
          joined: false,
          hidden: true,
        });
        relations.push(row("old", before), row("new", target.slots.map(copy)));
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

  // RETURNING hands back a written column's new value: what SET or the inserted row put there,
  // as well as what the column held before.
  private assign(ast: Node, target: Relation | undefined, scope: Scope): Relation | undefined {
    if (!target) return undefined;
    // An INSERT's rows never see the table they go into.
    const source = scope.parent ?? scope;
    const written = new Set<Slot>();
    // A written column hands back what was written, and its old document only on an upsert's
    // conflicting row whose SET leaves it alone.
    const keepsOld = (column: string) =>
      inserted.length > 0 &&
      sets.length > 0 &&
      !sets.some(([c]) => c !== null && this.same(c, column));
    const put = (column: string | null, value: Value) => {
      if (!column) return;
      const slot = target.slots.find((s) => s.label !== null && this.same(s.label, column));
      if (slot) {
        for (const n of value.names) slot.names.add(n);
        slot.unknown ||= value.unknown;
        const kept = written.has(slot) || keepsOld(column);
        slot.docs = whole(kept ? slotValue(slot) : NOTHING, value).docs;
        written.add(slot);
      } else {
        // A column of a table read without its column list held that table column's document.
        const table = target.slots.find((s) => s.rest === "pass")?.table;
        const old = table !== undefined && keepsOld(column) ? [this.doc(table, column)] : [];
        const added = {
          label: column,
          ...whole(named([column]), { ...NOTHING, docs: old }, value),
        };
        target.slots.unshift(added);
        written.add(added);
      }
    };
    // What the inserted row puts in each column, read before anything is written.
    const columns = (Array.isArray(ast.columns) ? ast.columns : []).map((c) =>
      columnLabel(isNode(c) && c.type === "column_ref" ? c.column : c),
    );
    const destinations = columns.length ? columns : target.slots.map((s) => s.label);
    const inserted: [string | null, Value][] = [];
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
      for (const [i, slot] of rows.entries()) {
        // A star nobody could list holds any number of columns: from there on, any destination
        // may receive any of them.
        if (slot.rest) {
          const any = { ...whole(...rows.slice(i).map(slotValue)), unknown: true };
          for (const d of destinations.slice(i)) inserted.push([d, any]);
          if (destinations.length <= i) inserted.push([null, any]);
          break;
        }
        inserted.push([destinations[i] ?? null, slotValue(slot)]);
      }
    }
    // A value whose column nobody could list may land in any unlisted column.
    const dropped = inserted.filter(([column]) => column === null).map(([, value]) => value);
    const positionsUnknown =
      target.slots.some((s) => s.rest) && dropped.some((v) => v.names.size > 0 || v.unknown);
    // An upsert's EXCLUDED is the row it tried to insert, reached only by its name.
    const excluded: Relation = {
      alias: "excluded",
      slots: inserted
        .filter((e): e is [string, Value] => e[0] !== null)
        .map(([label, value]) => ({ label, ...whole(named([label]), value) })),
      using: [],
      natural: false,
      joined: false,
      hidden: true,
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
      const carried = whole(...dropped);
      target.slots = target.slots.map((s) =>
        s.rest ? { ...s, ...whole(slotValue(s), carried), rest: "opaque" } : s,
      );
    }
    return excluded;
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
      const keys = this.keysRead(n, scope);
      if (keys.length) this.learn(this.source(n, scope), keys);
      for (const key of Object.keys(n)) visit(n[key]);
    };
    // The next set branch and the CTEs read within scopes of their own.
    for (const [key, child] of Object.entries(ast)) {
      if (key !== "_next" && key !== "with") visit(child);
    }
  }

  // The keys a node reads out of a document: a JSON path, a subscript, a field, a key test.
  private keysRead(n: Node, scope: Scope): string[] {
    if (n.type === "function") return readsPath(n) ? readKeys(n) : [];
    if (n.type === "binary_expr" && KEY_TESTS.has(String(n.operator))) return testedKeys(n);
    const subscript = isNode(n.column) ? offsetKeys(n.column.offset) : [];
    const field = n.type === "column_ref" && this.path(n, scope) ? [String(n.column)] : [];
    return [...accessorKeys(n), ...subFields(n), ...subscript, ...field];
  }

  // The document a key is read from: through JSON paths, key tests, JSON reading functions and
  // casts down to a column, or whatever value hands one back whole (`COALESCE(profile, '{}')`).
  private source(node: unknown, scope: Scope): Value {
    if (!isNode(node)) return NOTHING;
    const op = String(node.operator ?? "");
    if (node.type === "cast") return this.source(node.expr, scope);
    if (node.type === "binary_expr" && (JSON_OPERATORS.has(op) || KEY_TESTS.has(op))) {
      return this.source(node.left, scope);
    }
    if (node.type === "function" && readsPath(node)) {
      const args = isNode(node.args) && Array.isArray(node.args.value) ? node.args.value : [];
      return this.source(args[0], scope);
    }
    if (node.type === "column_ref") {
      const inner = isNode(node.column) && isNode(node.column.expr) ? node.column.expr : null;
      if (inner?.type === "column_ref") {
        return this.source({ ...inner, table: inner.table ?? node.table }, scope);
      }
      const path = this.path(node, scope);
      return path ? this.source(path, scope) : this.column(node, scope);
    }
    return this.value(node, scope);
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
        const args = this.value(expr?.type === "tablefunc" ? expr.args : (expr ?? item), sees);
        const fields = renames.length ? renames : columnDefinitions(expr);
        // `jsonb_to_record(profile) AS r(email text)` reads the fields it declares out of the
        // document; `jsonb_populate_record(base, profile)` takes the document second.
        const record = /^jsonb?_(to|populate)_record(set)?$/i.exec(callName(expr ?? item));
        if (record && expr) {
          const list = isNode(expr.args) && Array.isArray(expr.args.value) ? expr.args.value : [];
          const doc = list[record[1].toLowerCase() === "populate" ? 1 : 0];
          this.learn(this.value(doc, sees), columnDefinitions(expr));
        }
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
    const table = this.key(`${schema ?? ""}\u0000${name}`);
    return live
      ? live.map(
          (c): Slot => ({
            label: c,
            names: new Set([c]),
            unknown: false,
            docs: [this.doc(table, c)],
          }),
        )
      : [{ ...rest("pass"), table, docs: [this.doc(table, null)] }];
  }

  // Each column of a VALUES list holds what its rows put there, a correlated column included.
  private values(expr: Node, scope: Scope): Slot[] {
    const rows = (Array.isArray(expr.values) ? expr.values : [])
      .map((row) => (isNode(row) && Array.isArray(row.value) ? row.value : []))
      .filter((row) => row.length > 0);
    return (rows[0] ?? []).map(
      (_, i): Slot => ({ label: null, ...whole(...rows.map((row) => this.value(row[i], scope))) }),
    );
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
      // BigQuery's `* REPLACE (b.email AS note)`: the star's `note` holds the replacement.
      if (item.type === "replace" && expr) {
        const slots = this.star(expr, scope, []);
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
        out.push(...this.star(expr, scope, excludedBy(expr)));
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
      if (r.hidden) continue;
      const slots = r.slots.map(copy);
      const prior = r.joined ? groups.pop() : undefined;
      let out = prior ?? [];
      if (r.using.length === 0 || !prior) {
        out = [...out, ...slots];
      } else {
        const isKey = (s: Slot) => s.label !== null && r.using.some((u) => this.same(u, s.label!));
        const keys = r.using.map((u): Slot => {
          const sides = [...out, ...slots].filter((s) => s.label !== null && this.same(s.label, u));
          const value = whole(named([u]), ...sides.map(slotValue));
          return { label: u, ...value, unknown: value.unknown || sides.length < 2 };
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
      if (relation) return whole(...relation.slots.map(slotValue));
    }
    return null;
  }

  private column(expr: Node, scope: Scope): Value {
    const name = columnLabel(expr.column);
    if (!name) return NOTHING;
    if (name === "*") return whole(...this.star(expr, scope, []).map(slotValue));
    const qualifier = columnLabel(expr.table);
    const own = named([name]);
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      // RETURNING's `old` and `new`, and the relations inside a parenthesized join, answer only to
      // their own name; the joined group answers an unqualified one.
      const relations = qualifier
        ? s.relations.filter((r) => this.same(r.alias, qualifier))
        : s.relations.filter((r) => !r.hidden);
      const matches = relations.flatMap((r) =>
        r.slots.filter((x) => x.label !== null && this.same(x.label, name)),
      );
      // A USING key matches on both sides and returns whichever has a row; names that differ only
      // by quoted case cannot be told apart outside PostgreSQL, so every match counts.
      if (matches.length) return whole(own, ...matches.map(slotValue));
      // A table read without its column list passes the name through; a function or recursion
      // could have put anything under it, and so could an output this walker left unnamed.
      const unknowns = relations.flatMap((r) =>
        r.slots.filter(
          (x) => (x.label === null && !x.rest && x.names.size > 0) || x.rest === "opaque",
        ),
      );
      // Through a table read without its column list, the name is that table's column.
      const passed: Value = { ...own, docs: this.passDocs(relations, name) };
      if (unknowns.length) {
        return { ...whole(passed, ...unknowns.map(slotValue)), unknown: true };
      }
      if (qualifier && relations.length) return passed;
      // An unqualified name may still belong to an outer query when this table's columns are
      // unknown: keep what an outer column of that name holds, as a possibility only. An outer
      // table whose columns are unknown may own it too, which only its documents record.
      if (!qualifier && relations.some((r) => r.slots.some((x) => x.rest))) {
        const outer = this.outerMatches(name, s.parent);
        const candidates: Value[] = [];
        for (let o = s.parent; o; o = o.parent) {
          const visible = o.relations.filter((r) => !r.hidden);
          candidates.push({ ...NOTHING, docs: this.passDocs(visible, name) });
        }
        const all = whole(passed, ...outer.map(slotValue), ...candidates);
        const docs = all.docs ?? [];
        const owned = {
          ...all,
          docs: docs.length > 1 ? [{ keys: new Set<string>(), of: docs }] : docs,
        };
        return outer.length ? { ...owned, unknown: true } : owned;
      }
    }
    // A qualifier that names no relation (a misspelling, an engine's own row alias) tells nothing.
    return qualifier ? { ...own, unknown: true } : own;
  }

  // A DELETE lists its target twice; one table column is one document.
  private passDocs(relations: Relation[], name: string): Doc[] {
    const docs = relations.flatMap((r) =>
      r.slots.flatMap((x) => (x.table === undefined ? [] : [this.doc(x.table, name)])),
    );
    return [...new Set(docs)];
  }

  private outerMatches(name: string, scope: Scope | undefined): Slot[] {
    for (let s = scope; s; s = s.parent) {
      const matches = s.relations
        .filter((r) => !r.hidden)
        .flatMap((r) => r.slots.filter((x) => x.label !== null && this.same(x.label, name)));
      if (matches.length) return matches;
    }
    return [];
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
        if (path) {
          return join(this.value(path, scope), named([String(node.column), ...subFields(node)]));
        }
        // A subscript (`profile['email']`) or a struct path (`t.user.email`) reads a key out of
        // the column it hangs on, which is then no longer returned whole.
        const base = this.wholeRow(node, scope) ?? this.column(node, scope);
        const indexed = Array.isArray(node.array_index) && node.array_index.length > 0;
        if (!indexed && subFields(node).length === 0) return base;
        return join(base, named([...accessorKeys(node), ...subFields(node)]));
      }
      case "binary_expr": {
        const op = String(node.operator).toUpperCase();
        if (JSON_OPERATORS.has(op)) {
          return join(this.value(node.left, scope), named(accessorKeys(node)));
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
        // Every argument may reach the result (a JSON constructor's values, JSON_SET's new one);
        // an extractor adds the keys it reads. A function that reads or edits a path returns a
        // part or an edit of the document; any other may wrap it whole (`jsonb_agg(profile)`).
        const args = this.value(node.args, scope);
        const value = join(args, named(accessorKeys(node)));
        return changesDocument(node) ? value : { ...value, docs: args.docs };
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
      parts.push(named(accessorKeys(n)));
      for (const key of Object.keys(n)) visit(n[key]);
    };
    visit(node);
    const value = join(...parts);
    return opaque ? { ...value, unknown: true } : value;
  }
}

// A call's own name, without its schema; BigQuery keeps an unqualified one under `schema`.
function callName(node: Node): string {
  const name = isNode(node.name) ? node.name : {};
  const parts = Array.isArray(name.name) ? name.name : [];
  const own = parts.length ? parts[parts.length - 1] : name.schema;
  return isNode(own) && typeof own.value === "string" ? own.value : "";
}

// JSON functions that read a path out of their first argument or test it for a key
// (JSON_EXTRACT, jsonb_path_query, jsonb_exists_any): only a read shows what a document holds.
const JSON_READERS =
  /^jsonb?_(extract(_\w+)?|value(_array)?|query(_array)?|exists(_any|_all)?|path_\w+|contains_path)$/i;
// JSON functions that edit their document at a path, or test what it contains.
const JSON_EDITORS =
  /^jsonb?_(set(_lax)?|insert|replace|remove|array_append|array_insert|contains)$/i;
const readsPath = (node: Node) => JSON_READERS.test(callName(node));
// What a reader or an editor returns is a part, an edit or a test of the document, not it.
const changesDocument = (node: Node) =>
  JSON_READERS.test(callName(node)) || JSON_EDITORS.test(callName(node));

// The keys a reader names: every path or key after the document, arrays of keys included.
function readKeys(node: Node): string[] {
  const args = isNode(node.args) && Array.isArray(node.args.value) ? node.args.value : [];
  // JSON_CONTAINS_PATH(doc, 'one', path, ...): the second argument is a mode, not a key.
  const operands = /contains_path$/i.test(callName(node)) ? args.slice(2) : args.slice(1);
  const keys: string[] = [];
  walk(operands, (n) => {
    const text = stringLiteral(n);
    if (text !== null) keys.push(...jsonKeyNames(text));
  });
  return keys;
}

// Operators that test a document for keys: `? 'ssn'`, `?| array['a', 'b']`, `@> '{"ssn": 1}'`.
const KEY_TESTS = new Set(["?", "?|", "?&", "@>"]);
function testedKeys(node: Node): string[] {
  const keys: string[] = [];
  const objectKeys = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.flatMap(objectKeys)
      : v && typeof v === "object"
        ? Object.entries(v).flatMap(([k, x]) => [k, ...objectKeys(x)])
        : [];
  walk(node.right, (n) => {
    const text = stringLiteral(n);
    if (text === null) return;
    if (node.operator !== "@>") {
      keys.push(...jsonKeyNames(text));
      return;
    }
    try {
      keys.push(...objectKeys(JSON.parse(text)));
    } catch {
      // Not a JSON literal: it names no key.
    }
  });
  return keys;
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
  return { names, unknown: slot.unknown, docs: slot.docs };
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
    const all = whole(...next.map(slotValue));
    for (const slot of into) {
      for (const n of all.names) slot.names.add(n);
      slot.unknown = true;
      slot.docs = whole(slotValue(slot), all).docs;
    }
    return;
  }
  next.forEach((slot, i) => {
    for (const n of slot.names) into[i].names.add(n);
    into[i].unknown ||= slot.unknown;
    into[i].docs = whole(slotValue(into[i]), slotValue(slot)).docs;
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
  for (const slot of slots) {
    for (const n of slotValue(slot).names) names.add(n);
    for (const doc of slot.docs ?? []) {
      for (const d of doc.of ?? [doc]) for (const k of d.keys) names.add(k);
    }
  }
  // Keys whose document cannot be pinned may or may not reach the agent.
  const uncertain = (s: Slot) =>
    s.docs?.some((d) => d.uncertain || (d.of?.some((m) => m.keys.size > 0) ?? false)) ?? false;
  return { names: [...names], complete: !slots.some((s) => s.unknown || uncertain(s)) };
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
