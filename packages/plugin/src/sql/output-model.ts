import type { Columns, QueryOutput } from "./schema";

// What a statement returns, traced back to what it reads, whichever grammar parsed it: each engine's
// walker reads its own tree into these, and the resolution below never looks at a tree.

// A table column as a document: the keys the statement reads out of it anywhere. A column of a
// table read without its column list also lends its keys to that table's whole row.
export interface Doc {
  keys: Set<string>;
  row?: Doc;
  // A JSON function read it: it may hold keys nobody could name.
  opaque?: true;
}
// One returned column. A `rest` slot stands for columns nobody could list: a table's own
// ("pass", a column read through it keeps its name) or a function's or recursion's ("opaque").
export interface Slot {
  label: string | null;
  names: Set<string>;
  unknown: boolean;
  rest?: "pass" | "opaque";
  // The columns it hands back unchanged, so the keys read from them describe it too.
  docs?: Doc[];
  // The table a "pass" rest stands for.
  table?: string;
}
export interface Relation {
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
export interface Scope {
  relations: Relation[];
  ctes: Map<string, Slot[]>;
  parent?: Scope;
}
export interface Value {
  names: Set<string>;
  unknown: boolean;
  docs?: Doc[];
}
// What a write puts in a column: the column, or null when nobody could tell which, and whether the
// column may keep what it held (a subscript written, one of MERGE's alternative actions).
export type Written = [string | null, Value, partial?: boolean];

// Wider than any real table (PostgreSQL stops at 1600 columns).
const MAX_COLUMNS = 2000;
export const NOTHING: Value = { names: new Set(), unknown: false };

export const rest = (kind: "pass" | "opaque"): Slot => ({
  label: null,
  names: new Set(),
  unknown: true,
  rest: kind,
});
export const join = (...values: Value[]): Value => ({
  names: new Set(values.flatMap((v) => [...v.names])),
  unknown: values.some((v) => v.unknown),
});
// Values that may hand back the columns they carry, unchanged or wrapped: a part of a document
// (`profile->'contact'`) or one with a key removed goes through `join` instead.
export const whole = (...values: Value[]): Value => ({
  ...join(...values),
  docs: [...new Set(values.flatMap((v) => v.docs ?? []))],
});
export const named = (names: string[]): Value => ({ names: new Set(names), unknown: false });
export const copy = (slot: Slot): Slot => ({ ...slot, names: new Set(slot.names) });
// A relation reached only by its name: an upsert's EXCLUDED, RETURNING's `old` and `new`.
export const hiddenRelation = (alias: string, slots: Slot[]): Relation => ({
  alias,
  slots,
  using: [],
  natural: false,
  joined: false,
  hidden: true,
});

export function slotValue(slot: Slot): Value {
  const names = new Set(slot.names);
  if (slot.label !== null) names.add(slot.label);
  return { names, unknown: slot.unknown, docs: slot.docs };
}

// A positional rename (`AS f(a, b)`, `WITH x(a, b)`): each new label keeps what its column held.
// Past an unexpanded star the positions are unknown, so those labels hold anything.
export function rename(slots: Slot[], labels: string[]): Slot[] {
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
export function merge(into: Slot[], next: Slot[]): void {
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

// The rows a statement inserts, column by column. A star nobody could list holds any number of
// columns: from there on, any destination may receive any of them.
export function insertedRows(rows: Slot[], destinations: (string | null)[]): Written[] {
  const inserted: Written[] = [];
  for (const [i, slot] of rows.entries()) {
    if (slot.rest) {
      const any = { ...whole(...rows.slice(i).map(slotValue)), unknown: true };
      for (const d of destinations.slice(i)) inserted.push([d, any]);
      if (destinations.length <= i) inserted.push([null, any]);
      break;
    }
    inserted.push([destinations[i] ?? null, slotValue(slot)]);
  }
  return inserted;
}

// The object keys of a JSON literal, at any depth, never its values or array elements.
export function jsonObjectKeys(text: string): string[] {
  const keys = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.flatMap(keys)
      : v && typeof v === "object"
        ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)])
        : [];
  try {
    return keys(JSON.parse(text));
  } catch {
    // Not a JSON literal: it names no key.
    return [];
  }
}

export function summary(slots: Slot[]): QueryOutput {
  const names = new Set<string>();
  for (const slot of slots) {
    for (const n of slotValue(slot).names) names.add(n);
    for (const doc of slot.docs ?? []) for (const k of doc.keys) names.add(k);
  }
  const opaque = (s: Slot) => s.docs?.some((d) => d.opaque) ?? false;
  return { names: [...names], complete: !slots.some((s) => s.unknown || opaque(s)) };
}

export class OutputModel {
  protected readonly columns: Columns | undefined;
  // Whether names reach here as the engine compares them, or as written and compared without case.
  private readonly exact: boolean;

  // One per table column, so every reference to that column, from any relation or level, meets
  // the same keys.
  private readonly documents = new Map<string, Doc>();

  constructor(columns: Columns | undefined, exact: boolean) {
    this.columns = columns;
    this.exact = exact;
  }

  protected key(name: string): string {
    return this.exact ? name : name.toLowerCase();
  }

  protected same(a: string, b: string): boolean {
    return this.key(a) === this.key(b);
  }

  protected doc(table: string, column: string | null): Doc {
    const id = column === null ? table : `${table}\u0000${this.key(column)}`;
    let doc = this.documents.get(id);
    if (!doc) {
      doc = { keys: new Set(), row: column === null ? undefined : this.doc(table, null) };
      this.documents.set(id, doc);
    }
    return doc;
  }

  protected knows(alias: string, scope: Scope | undefined): boolean {
    for (let s = scope; s; s = s.parent) {
      if (s.relations.some((r) => this.same(r.alias, alias))) return true;
    }
    return false;
  }

  // Some relation in reach has a column of that name, or columns nobody could list.
  protected holds(name: string, scope: Scope | undefined): boolean {
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

  // Keys read out of a document whose column may be one of several describe every candidate:
  // the flags may then over-report, never miss one.
  protected learn(base: Value, keys: string[]): void {
    for (const doc of base.docs ?? []) {
      for (const k of keys) {
        doc.keys.add(k);
        doc.row?.keys.add(k);
      }
    }
  }

  // CTEs are kept under their names as written: where names compare without case, "X" and "x" may
  // be two CTEs or one, so a reference to either holds anything both hold.
  protected cte(scope: Scope | undefined, name: string): Slot[] | undefined {
    for (let s = scope; s; s = s.parent) {
      const found = [...s.ctes].filter(([n]) => this.same(n, name)).map(([, slots]) => slots);
      if (found.length === 1) return found[0];
      if (found.length > 1) {
        const all = found[0].map(copy);
        for (const other of found.slice(1)) merge(all, other.map(copy));
        return all.map((slot) => ({ ...slot, unknown: true }));
      }
    }
    return undefined;
  }

  // A named relation: a CTE in reach when unqualified, else a table, with its live columns when the
  // connection gave them.
  protected relation(schema: string | null, name: string, scope: Scope): Slot[] {
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

  // A CTE's columns as the statement after it sees them. Recursion can move a value from one
  // column to another on every pass, so nothing returned through a recursive CTE has a known source.
  protected defineCte(scope: Scope, name: string, slots: Slot[], recursive: boolean): void {
    // Any of its columns may end up holding any value it ever carried.
    const all = join(...slots.map(slotValue));
    scope.ctes.set(
      name,
      recursive
        ? [
            ...slots.map((s) => ({ ...s, names: new Set(all.names), unknown: true })),
            rest("opaque"),
          ]
        : slots,
    );
  }

  protected star(qualifier: string | null, scope: Scope, excluded: string[]): Slot[] {
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
  protected joined(relations: Relation[]): Slot[] {
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
  protected wholeRow(name: string, scope: Scope): Value | null {
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

  protected column(qualifier: string | null, name: string, scope: Scope): Value {
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
        const outer = qualifier ? NOTHING : this.outer(name, s.parent);
        return { ...whole(passed, outer, ...unknowns.map(slotValue)), unknown: true };
      }
      if (qualifier && relations.some((r) => r.slots.some((x) => x.rest))) return passed;
      // Every column of that relation is known and none has the name: this walker misread it
      // (an implicit label, an engine's own column), so the value is untraced.
      if (qualifier && relations.length) return { ...passed, unknown: true };
      if (!qualifier && relations.some((r) => r.slots.some((x) => x.rest))) {
        return whole(passed, this.outer(name, s.parent));
      }
    }
    // Nothing in reach has the name: a misspelling, an engine's own row alias or variable, or a
    // column this walker misread. It tells nothing.
    return { ...own, unknown: true };
  }

  // A DELETE lists its target twice; one table column is one document.
  private passDocs(relations: Relation[], name: string): Doc[] {
    const docs = relations.flatMap((r) =>
      r.slots.flatMap((x) => (x.table === undefined ? [] : [this.doc(x.table, name)])),
    );
    return [...new Set(docs)];
  }

  // An unqualified name read where some table's columns are unknown may belong to an outer query:
  // what an outer column of that name holds, as a possibility only (untraced), and the documents
  // of outer tables whose columns are unknown too.
  private outer(name: string, scope: Scope | undefined): Value {
    const matches = this.outerMatches(name, scope);
    const tables: Value[] = [];
    for (let o = scope; o; o = o.parent) {
      tables.push({
        ...NOTHING,
        docs: this.passDocs(
          o.relations.filter((r) => !r.hidden),
          name,
        ),
      });
    }
    const all = whole(...matches.map(slotValue), ...tables);
    return matches.length ? { ...all, unknown: true } : all;
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

  // RETURNING hands back a written column's new value: what SET or the inserted row put there, as
  // well as what the column held before. `sets` reads every SET list in the scope it is given,
  // which reaches an upsert's EXCLUDED, the row it tried to insert; that relation is returned.
  protected write(
    target: Relation,
    scope: Scope,
    inserted: Written[],
    sets: (scope: Scope) => Written[],
  ): Relation {
    const written = new Set<Slot>();
    // A written column hands back what was written, and its old document only on an upsert's
    // conflicting row whose SET leaves it alone.
    const keepsOld = (column: string) =>
      inserted.length > 0 &&
      assigned.length > 0 &&
      !assigned.some(([c]) => c !== null && this.same(c, column));
    const put = (column: string | null, value: Value, partial = false) => {
      if (!column) return;
      const slot = target.slots.find((s) => s.label !== null && this.same(s.label, column));
      if (slot) {
        for (const n of value.names) slot.names.add(n);
        slot.unknown ||= value.unknown;
        const kept = partial || written.has(slot) || keepsOld(column);
        slot.docs = whole(kept ? slotValue(slot) : NOTHING, value).docs;
        written.add(slot);
      } else {
        // A column of a table read without its column list held that table column's document.
        const table = target.slots.find((s) => s.rest === "pass")?.table;
        const kept = partial || keepsOld(column);
        const old = table !== undefined && kept ? [this.doc(table, column)] : [];
        const added = {
          label: column,
          ...whole(named([column]), { ...NOTHING, docs: old }, value),
        };
        target.slots.unshift(added);
        written.add(added);
      }
    };
    // A value whose column nobody could list may land in any unlisted column.
    const dropped = inserted.filter(([column]) => column === null).map(([, value]) => value);
    const positionsUnknown =
      target.slots.some((s) => s.rest) && dropped.some((v) => v.names.size > 0 || v.unknown);
    const excluded = hiddenRelation(
      "excluded",
      inserted
        .filter((e): e is [string, Value, boolean?] => e[0] !== null)
        .map(([label, value]) => ({ label, ...whole(named([label]), value) })),
    );
    // Every SET list reads the row as it was, so all of them are evaluated before any is applied.
    const assigned = sets({
      relations: [...scope.relations, excluded],
      ctes: new Map(),
      parent: scope,
    });
    for (const [column, value, partial] of [...inserted, ...assigned]) put(column, value, partial);
    if (positionsUnknown) {
      const carried = whole(...dropped);
      target.slots = target.slots.map((s) =>
        s.rest ? { ...s, ...whole(slotValue(s), carried), rest: "opaque" } : s,
      );
    }
    return excluded;
  }
}
