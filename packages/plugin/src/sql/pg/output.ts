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
import {
  type Columns,
  JSON_FUNCTION,
  JSON_OPERATORS,
  jsonKeyNames,
  type QueryOutput,
} from "../schema";
import { readPg } from "./parse";

type Node = Record<string, unknown>;
type Link = Pick<Relation, "joined" | "using" | "natural">;

const FIRST: Link = { joined: false, using: [], natural: false };

// Statements that hand back no rows: every CREATE, ALTER, DROP and GRANT, and these. Any other one
// but a write may return rows nobody traced (EXPLAIN, SHOW, CALL, FETCH, EXECUTE, COPY).
const NO_ROWS =
  /^(?:(?:Create|Alter|Drop|Grant)\w*Stmt|ViewStmt|IndexStmt|TruncateStmt|RenameStmt|VariableSetStmt|LockStmt|CommentStmt|TransactionStmt)$/;
const WRITES = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);
// Operators whose result is a boolean, never the content they test. PostgreSQL's scanner turns
// != into <>, and every A_Expr kind but an operator or NULLIF is a predicate already.
const PREDICATES = new Set([
  "=",
  "<>",
  "<",
  ">",
  "<=",
  ">=",
  "~",
  "~*",
  "!~",
  "!~*",
  "~~",
  "~~*",
  "!~~",
  "!~~*",
  "@>",
  "<@",
  "?",
  "?|",
  "?&",
  "&&",
]);
// The predicates that test a document for keys: `? 'ssn'`, `?| array['a', 'b']`, `@> '{"ssn": 1}'`.
const KEY_TESTS = new Set(["?", "?|", "?&", "@>"]);
// Expressions PostgreSQL names like a function call, whatever they hold.
const FIXED_LABELS: Record<string, string> = {
  GroupingFunc: "grouping",
  MergeSupportFunc: "merge_action",
  A_ArrayExpr: "array",
  RowExpr: "row",
  CoalesceExpr: "coalesce",
  XmlSerialize: "xmlserialize",
  JsonParseExpr: "json",
  JsonScalarExpr: "json_scalar",
  JsonSerializeExpr: "json_serialize",
  JsonObjectConstructor: "json_object",
  JsonArrayConstructor: "json_array",
  JsonArrayQueryConstructor: "json_array",
  JsonObjectAgg: "json_objectagg",
  JsonArrayAgg: "json_arrayagg",
};

function node(value: unknown): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// A wrapped node, { Kind: body }, as its kind and body. Kinds start upper case, fields do not.
function only(value: unknown): [string, Node] | null {
  if (!node(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 && /^[A-Z]/.test(keys[0]) && node(value[keys[0]])
    ? [keys[0], value[keys[0]] as Node]
    : null;
}

function strings(value: unknown): string[] {
  return list(value).flatMap((item) => {
    const s = only(item);
    return s?.[0] === "String" && typeof s[1].sval === "string" ? [s[1].sval] : [];
  });
}

function isJsonFunction(call: Node): boolean {
  return strings(call.funcname).some((part) => JSON_FUNCTION.test(part));
}

// The keys the statement spells out for an accessor: one key as written (`->`, `?`, a subscript), a
// number naming an array element, or for a path or a key list (`#>`, `?|`) its elements, from an
// array literal or ARRAY[...]. Null when a column or a parameter supplies one.
function fixedKeys(value: unknown, several = false): string[] | null {
  const n = only(value);
  if (!n) return null;
  const [kind, body] = n;
  if (kind === "TypeCast") return fixedKeys(body.arg, several);
  if (kind === "A_Const") {
    if (!node(body.sval)) return [];
    const text = String(body.sval.sval ?? "");
    return several ? jsonKeyNames(text) : [text];
  }
  if (kind !== "A_ArrayExpr") return null;
  const keys = list(body.elements).map((e) => fixedKeys(e));
  return keys.every((k) => k !== null) ? keys.flat() : null;
}

// Paths and key lists hold several keys; the other accessors and key tests name one.
const SEVERAL = new Set(["#>", "#>>", "?|", "?&"]);

// The string constants in a value, as written.
function constants(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) for (const c of v) visit(c);
    else if (node(v)) {
      const n = only(v);
      if (n?.[0] === "A_Const" && node(n[1].sval)) out.push(String(n[1].sval.sval ?? ""));
      for (const c of Object.values(v)) visit(c);
    }
  };
  visit(value);
  return out;
}

// What subscripts and field selections read out of the value they hang on; null when a subscript
// is not spelled out. `fixedOnly` keeps the spelled-out keys of a mixed chain instead.
function stepKeys(steps: unknown[], fixedOnly = false): string[] | null {
  const keys: string[] = [];
  for (const step of steps) {
    const [kind, body] = only(step) ?? ["", {}];
    if (kind === "String" && typeof body.sval === "string") keys.push(body.sval);
    if (kind !== "A_Indices") continue;
    for (const bound of [body.lidx, body.uidx]) {
      if (bound === undefined) continue;
      const k = fixedKeys(bound);
      if (k) keys.push(...k);
      else if (!fixedOnly) return null;
    }
  }
  return keys;
}

class Resolver extends OutputModel {
  // A nested statement is reached while resolving values and again while collecting reads.
  private readonly resolved = new WeakMap<Node, Slot[]>();

  // The grammar folds unquoted names and keeps quoted ones as written: they compare exactly.
  constructor(columns: Columns | undefined) {
    super(columns, true);
  }

  statement(value: unknown, scope: Scope): Slot[] {
    const n = only(value);
    if (!n) return [rest("opaque")];
    const [kind, body] = n;
    const done = this.resolved.get(body);
    if (done) return done.map(copy);
    let out: Slot[];
    if (kind === "SelectStmt") out = this.select(body, scope);
    else if (WRITES.has(kind)) out = this.modify(body, scope);
    else out = NO_ROWS.test(kind) ? [] : [rest("opaque")];
    this.resolved.set(body, out.map(copy));
    return out;
  }

  // A set operation's tree already binds INTERSECT tighter than UNION and EXCEPT: each side is a
  // query of its own. SELECT ... INTO creates a table and returns nothing.
  private select(body: Node, outer: Scope): Slot[] {
    if (creates(body)) return [];
    const scope = this.withCtes(body.withClause, outer);
    if (body.op === undefined || body.op === "SETOP_NONE") return this.branch(body, scope);
    const left = this.select(node(body.larg) ? body.larg : {}, scope);
    const right = this.select(node(body.rarg) ? body.rarg : {}, scope);
    if (body.op !== "SETOP_EXCEPT") merge(left, right);
    this.reads(body, scope);
    return left;
  }

  private branch(body: Node, outer: Scope): Slot[] {
    if (Array.isArray(body.valuesLists)) {
      const slots = this.values(body.valuesLists, outer);
      this.reads(body, outer);
      return slots;
    }
    const relations = this.from(list(body.fromClause), outer);
    const scope: Scope = { relations, ctes: new Map(), parent: outer };
    const slots = this.projection(list(body.targetList), scope);
    this.reads(body, scope);
    return slots;
  }

  // PostgreSQL names a VALUES list's columns column1, column2...; each holds what its rows put
  // there, a correlated column included.
  private values(lists: unknown[], scope: Scope): Slot[] {
    const rows = lists.map((row) => list(only(row)?.[1].items)).filter((row) => row.length > 0);
    return (rows[0] ?? []).map(
      (_, i): Slot => ({
        label: `column${i + 1}`,
        ...whole(...rows.map((row) => this.value(row[i], scope))),
      }),
    );
  }

  private withCtes(clause: unknown, scope: Scope): Scope {
    if (!node(clause)) return scope;
    const recursive = clause.recursive === true;
    const inner: Scope = { relations: [], ctes: new Map(), parent: scope };
    for (const item of list(clause.ctes)) {
      const cte = only(item)?.[1];
      if (typeof cte?.ctename !== "string") continue;
      if (recursive) inner.ctes.set(cte.ctename, [rest("opaque")]);
      const slots = rename(this.statement(cte.ctequery, inner), strings(cte.aliascolnames));
      this.defineCte(inner, cte.ctename, slots, recursive);
    }
    return inner;
  }

  private from(items: unknown[], outer: Scope): Relation[] {
    const relations: Relation[] = [];
    for (const item of items) relations.push(...this.item(item, relations, outer, FIRST, false));
    return relations;
  }

  // One FROM item as the relations it adds. `before` are the items before it, which a LATERAL
  // item and a function's arguments see; `link` says how it joins them. A join nested on the
  // right or given an alias yields one joined table; an alias hides the tables inside it.
  private item(
    value: unknown,
    before: Relation[],
    outer: Scope,
    link: Link,
    nested: boolean,
  ): Relation[] {
    const [kind, body] = only(value) ?? ["", {}];
    const alias = node(body.alias) ? body.alias : null;
    const aliasName = typeof alias?.aliasname === "string" ? alias.aliasname : null;
    const renames = strings(alias?.colnames);
    const sees: Scope = { relations: [...before], ctes: new Map(), parent: outer };
    const one = (name: string, slots: Slot[]): Relation[] => [
      { alias: aliasName ?? name, slots: rename(slots, renames), ...link },
    ];
    switch (kind) {
      case "RangeVar": {
        const name = String(body.relname ?? "");
        const schema = typeof body.schemaname === "string" ? body.schemaname : null;
        return one(name, this.relation(schema, name, outer));
      }
      case "RangeSubselect":
        return one("", this.statement(body.subquery, body.lateral === true ? sees : outer));
      case "RangeTableSample":
        return this.item(body.relation, before, outer, link, nested);
      case "JoinExpr": {
        if (!nested && aliasName === null) return this.join(body, before, outer, link);
        const inner = this.join(body, before, outer, FIRST);
        const reachable = aliasName === null ? inner : [];
        return [
          ...one("", this.joined(inner)),
          ...reachable.map((r): Relation => ({ ...r, hidden: true })),
        ];
      }
      case "RangeFunction":
      case "RangeTableFunc":
      case "JsonTable": {
        // A function in FROM may return one column or a whole record whose content its body
        // decides: only its arguments are known sources, and only a column list names fields.
        const calls = list(body.functions).map((f) => list(only(f)?.[1].items));
        const args = [
          ...calls.map((items) => items[0]),
          body.docexpr,
          node(body.context_item) ? body.context_item.raw_expr : undefined,
        ];
        const passed = whole(...args.map((a) => this.value(a, sees)));
        // What it unpacks (`jsonb_array_elements(u.profile->'contacts')`) comes out of those
        // documents, so a key read through its columns is read from them.
        const unpacked = whole(
          ...args.map((a) =>
            this.sources(only(a)?.[0] === "FuncCall" ? only(a)?.[1].args : a, sees),
          ),
        ).docs;
        const declared = [
          ...list(body.coldeflist),
          ...list(body.columns),
          ...calls.map((c) => c[1]),
        ]
          .flatMap((c) => (only(c)?.[0] === "List" ? list(only(c)?.[1].items) : [c]))
          .map((c) => only(c)?.[1])
          .map((c) => c?.colname ?? c?.name)
          .filter((c): c is string => typeof c === "string");
        const fields = renames.length ? renames : declared;
        const call = only(calls[0]?.[0])?.[1];
        const name = aliasName ?? strings(call?.funcname).at(-1) ?? "";
        const field = (label: string | null): Slot => ({
          label,
          names: new Set(passed.names),
          unknown: true,
          docs: unpacked,
        });
        const slots = fields.length ? fields.map(field) : [field(name), rest("opaque")];
        return [{ alias: name, slots, ...link }];
      }
    }
    return one("", [rest("opaque")]);
  }

  // A chain of joins as its relations in order, the first taking the chain's own link.
  private join(body: Node, before: Relation[], outer: Scope, link: Link): Relation[] {
    const left = this.item(body.larg, before, outer, link, false);
    const using = strings(body.usingClause);
    const right = this.item(
      body.rarg,
      [...before, ...left],
      outer,
      { joined: true, using, natural: false },
      true,
    );
    if (body.isNatural === true && right[0]) {
      // NATURAL joins on the names both sides share, which only fully known columns tell.
      const [mine, theirs] = [this.joined(left), right[0].slots];
      const known = ![...mine, ...theirs].some((s) => s.rest);
      const shared = mine
        .map((s) => s.label)
        .filter((l): l is string => l !== null && theirs.some((s) => s.label === l));
      right[0] = { ...right[0], using: known ? [...new Set(shared)] : [], natural: !known };
    }
    const chain = [...left, ...right];
    // `JOIN ... USING (id) AS j` names the merged keys alone, leaving both tables reachable.
    const merged = node(body.join_using_alias) ? body.join_using_alias.aliasname : null;
    if (typeof merged === "string") {
      chain.push(hiddenRelation(merged, this.joined(chain).slice(0, using.length)));
    }
    return chain;
  }

  private projection(targets: unknown[], scope: Scope): Slot[] {
    const out: Slot[] = [];
    for (const item of targets) {
      const target = only(item)?.[1];
      if (!target) continue;
      const star = starOf(target.val);
      if (star !== undefined) {
        out.push(...this.star(star, scope, []));
        continue;
      }
      const value = this.value(target.val, scope);
      const label = typeof target.name === "string" ? target.name : this.label(target.val, scope);
      out.push({ label, names: new Set(value.names), unknown: value.unknown, docs: value.docs });
    }
    return out;
  }

  // The name PostgreSQL gives an unaliased output, null where it says ?column?: parse_target.c's
  // FigureColnameInternal, where a type name (strength 1) yields to any other name (2).
  private label(value: unknown, scope: Scope): string | null {
    return this.figure(value, scope)?.[0] ?? null;
  }

  private figure(value: unknown, scope: Scope): [string, number] | null {
    const [kind, body] = only(value) ?? ["", {}];
    const strong = (name: string | null | undefined): [string, number] | null =>
      name ? [name, 2] : null;
    switch (kind) {
      case "ColumnRef":
        return strong(strings(body.fields).at(-1));
      case "A_Indirection":
        return strong(strings(body.indirection).at(-1)) ?? this.figure(body.arg, scope);
      case "FuncCall":
        return strong(strings(body.funcname).at(-1));
      case "A_Expr":
        return body.kind === "AEXPR_NULLIF" ? ["nullif", 2] : null;
      case "CollateClause":
        return this.figure(body.arg, scope);
      case "TypeCast": {
        const inner = this.figure(body.arg, scope);
        if (inner && inner[1] > 1) return inner;
        const type = node(body.typeName) ? strings(body.typeName.names).at(-1) : undefined;
        return type ? [type, 1] : inner;
      }
      case "CaseExpr": {
        const result = this.figure(body.defresult, scope);
        return result && result[1] > 1 ? result : ["case", 1];
      }
      case "SubLink":
        if (body.subLinkType === "EXISTS_SUBLINK") return ["exists", 2];
        if (body.subLinkType === "ARRAY_SUBLINK") return ["array", 2];
        return body.subLinkType === "EXPR_SUBLINK"
          ? strong(this.statement(body.subselect, scope)[0]?.label)
          : null;
      case "MinMaxExpr":
        return [body.op === "IS_GREATEST" ? "greatest" : "least", 2];
      case "SQLValueFunction":
        return strong(
          String(body.op ?? "")
            .replace(/^SVFOP_|_N$/g, "")
            .toLowerCase(),
        );
      case "XmlExpr":
        return body.op === "IS_DOCUMENT"
          ? null
          : strong(
              String(body.op ?? "")
                .replace(/^IS_/, "")
                .toLowerCase(),
            );
      case "JsonFuncExpr":
        return strong(
          String(body.op ?? "")
            .replace(/_OP$/, "")
            .toLowerCase(),
        );
    }
    return strong(FIXED_LABELS[kind]);
  }

  value(value: unknown, scope: Scope): Value {
    if (Array.isArray(value)) return whole(...value.map((v) => this.value(v, scope)));
    const n = only(value);
    if (!n) return NOTHING;
    const [kind, body] = n;
    switch (kind) {
      case "ColumnRef":
        return this.reference(list(body.fields), scope);
      case "TypeCast":
      case "CollateClause":
        return this.value(body.arg, scope);
      case "A_Expr":
        return this.expression(body, scope);
      case "FuncCall":
        return this.call(body, scope);
      case "A_Indirection":
        return this.indirection(body, scope);
      case "SubLink":
        // EXISTS, IN, ANY and ALL test rows; a scalar or ARRAY subquery returns what it projects.
        return body.subLinkType === "EXPR_SUBLINK" ||
          body.subLinkType === "ARRAY_SUBLINK" ||
          body.subLinkType === "MULTIEXPR_SUBLINK"
          ? whole(...this.statement(body.subselect, scope).map(slotValue))
          : NOTHING;
      case "CaseExpr":
        return whole(
          ...list(body.args).map((arm) => this.value(only(arm)?.[1].result, scope)),
          this.value(body.defresult, scope),
        );
      case "CoalesceExpr":
      case "MinMaxExpr":
      case "RowExpr":
        return whole(this.value(body.args, scope));
      case "A_ArrayExpr":
        return whole(this.value(body.elements, scope));
      case "MultiAssignRef": {
        // `SET (a, b) = (x, y)` or `= (SELECT x, y ...)` hands a the source's own column.
        const [source, from] = only(body.source) ?? ["", {}];
        const column = Number(body.colno) - 1;
        if (source === "RowExpr") return this.value(list(from.args)[column], scope);
        if (source !== "SubLink") return this.value(body.source, scope);
        const slots = this.statement(from.subselect, scope);
        const slot = slots.some((s) => s.rest) ? undefined : slots[column];
        return slot ? slotValue(slot) : { ...whole(...slots.map(slotValue)), unknown: true };
      }
      case "JsonFuncExpr":
        // JSON_EXISTS tests a path; JSON_VALUE and JSON_QUERY return what it reaches, untraced.
        return body.op === "JSON_EXISTS_OP" ? NOTHING : this.unmodeled(value, scope);
      case "A_Const":
      case "ParamRef":
      case "SQLValueFunction":
      case "SetToDefault":
      case "GroupingFunc":
      case "MergeSupportFunc":
      case "BoolExpr":
      case "NullTest":
      case "BooleanTest":
      case "JsonIsPredicate":
        return NOTHING;
    }
    return this.unmodeled(value, scope);
  }

  // `p` alone may be a whole row; a qualified name ends with its relation and column, since a
  // composite column's field is written `(p).email`, an indirection.
  private reference(fields: unknown[], scope: Scope): Value {
    const names = strings(fields);
    if (only(fields.at(-1))?.[0] === "A_Star") {
      return whole(...this.star(names.at(-1) ?? null, scope, []).map(slotValue));
    }
    const name = names.at(-1) ?? "";
    if (names.length === 1) return this.wholeRow(name, scope) ?? this.column(null, name, scope);
    return this.column(names.at(-2) ?? null, name, scope);
  }

  private expression(body: Node, scope: Scope): Value {
    if (body.kind === "AEXPR_NULLIF") return whole(this.value(body.lexpr, scope));
    if (body.kind !== "AEXPR_OP") return NOTHING;
    const op = strings(body.name).at(-1) ?? "";
    if (JSON_OPERATORS.has(op)) {
      const left = this.value(body.lexpr, scope);
      // A key a column or a parameter supplies (`profile->>k.name`) may be any key.
      const keys = fixedKeys(body.rexpr, SEVERAL.has(op));
      return keys ? join(left, named(keys)) : { ...whole(left), unknown: true };
    }
    if (PREDICATES.has(op)) return NOTHING;
    const sides = [this.value(body.lexpr, scope), this.value(body.rexpr, scope)];
    // `profile - 'email'` and `#-` remove a key: the document is no longer the one returned.
    return op === "-" || op === "#-" ? join(...sides) : whole(...sides);
  }

  private call(body: Node, scope: Scope): Value {
    const name = strings(body.funcname);
    // A count returns how many, never what it counted.
    if (name.at(-1) === "count" && (name.length === 1 || name[0] === "pg_catalog")) return NOTHING;
    // FILTER, OVER and the aggregate's own ORDER BY only choose rows, while WITHIN GROUP's ORDER
    // BY supplies the value returned.
    const within = body.agg_within_group === true ? list(body.agg_order) : [];
    const args = whole(
      this.value(body.args, scope),
      ...within.map((sort) => this.value(only(sort)?.[1].node, scope)),
    );
    // Every argument may reach the result, documents included. A JSON function's literals may be
    // paths, keys or values, which only its semantics tell apart: its result is untraced.
    return isJsonFunction(body) ? { ...args, unknown: true } : args;
  }

  // A subscript (`profile['email']`) or a field (`(p).email`) reads a key out of the value it hangs
  // on, which is then no longer returned whole. `(p).*` returns fields nobody listed.
  private indirection(body: Node, scope: Scope): Value {
    const base = this.value(body.arg, scope);
    const steps = list(body.indirection);
    if (steps.some((s) => only(s)?.[0] === "A_Star")) return { ...whole(base), unknown: true };
    const keys = stepKeys(steps);
    return keys ? join(base, named(keys)) : { ...whole(base), unknown: true };
  }

  // The document a key is read from: through JSON operators, key tests, subscripts and casts down
  // to a column, or whatever value hands one back (`COALESCE(profile, '{}')`).
  private source(value: unknown, scope: Scope): Value {
    const [kind, body] = only(value) ?? ["", {}];
    if (kind === "TypeCast" || kind === "CollateClause" || kind === "A_Indirection") {
      return this.source(body.arg, scope);
    }
    const op = kind === "A_Expr" && body.kind === "AEXPR_OP" ? strings(body.name).at(-1) : null;
    if (op && (JSON_OPERATORS.has(op) || KEY_TESTS.has(op))) return this.source(body.lexpr, scope);
    const names = kind === "ColumnRef" ? strings(body.fields) : [];
    if (names.length > 0 && only(list(body.fields).at(-1))?.[0] === "String") {
      return this.column(names.at(-2) ?? null, names.at(-1) ?? "", scope);
    }
    return this.value(value, scope);
  }

  // What a list of arguments hands over of the documents it reads from, parts included.
  private sources(args: unknown, scope: Scope): Value {
    return whole(...(Array.isArray(args) ? args : [args]).map((a) => this.source(a, scope)));
  }

  // The keys the grammar shows a node reading out of a document: a JSON operator, a subscript, a
  // field, a key test. A function's arguments name no key: only its semantics could tell a key
  // from a value.
  private keysRead(kind: string, body: Node): string[] {
    if (kind === "A_Indirection") return stepKeys(list(body.indirection), true) ?? [];
    if (kind !== "A_Expr" || body.kind !== "AEXPR_OP") return [];
    const op = strings(body.name).at(-1) ?? "";
    if (JSON_OPERATORS.has(op)) return fixedKeys(body.rexpr, SEVERAL.has(op)) ?? [];
    if (op === "@>") return constants(body.rexpr).flatMap(jsonObjectKeys);
    return KEY_TESTS.has(op) ? (fixedKeys(body.rexpr, SEVERAL.has(op)) ?? []) : [];
  }

  // A key read out of a column anywhere in the statement (a filter, a join, the select list)
  // shows what that column holds wherever the statement returns it unchanged. Nested queries,
  // the sides of a set operation and the CTEs read within scopes of their own.
  private reads(body: Node, scope: Scope): void {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
        return;
      }
      if (!node(value)) return;
      const n = only(value);
      if (n?.[0] === "SelectStmt") {
        this.statement(value, scope);
        return;
      }
      if (n) {
        const [kind, inner] = n;
        // A JSON function reads its documents in ways only its own semantics could name: whatever
        // returns one of them is untraced.
        if (kind === "FuncCall" && isJsonFunction(inner))
          this.opaque(this.sources(inner.args, scope));
        else if (kind.startsWith("Json") && kind !== "JsonIsPredicate") {
          this.opaque(this.columnsIn(inner, scope));
        }
        const keys = this.keysRead(kind, inner);
        if (keys.length) this.learn(this.source(value, scope), keys);
      }
      for (const child of Object.values(value)) visit(child);
    };
    for (const [key, child] of Object.entries(body)) {
      if (key !== "withClause" && key !== "larg" && key !== "rarg") visit(child);
    }
  }

  private opaque(value: Value): void {
    for (const doc of value.docs ?? []) doc.opaque = true;
  }

  // The columns a node reads, outside the queries nested in it.
  private columnsIn(value: unknown, scope: Scope): Value {
    const found: Value[] = [];
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) for (const c of v) visit(c);
      else if (node(v)) {
        const n = only(v);
        if (n?.[0] === "SelectStmt") return;
        if (n?.[0] === "ColumnRef") found.push(this.source(v, scope));
        else for (const c of Object.values(v)) visit(c);
      }
    };
    visit(value);
    return whole(...found);
  }

  // A shape this walker does not model: its columns count as returned, and a subquery, window,
  // filter or JSON construct inside it, whose row-picking parts or keys it cannot tell from its
  // values, makes it unknown.
  private unmodeled(value: unknown, scope: Scope): Value {
    let opaque = false;
    const parts: Value[] = [];
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const child of v) visit(child);
        return;
      }
      if (!node(v)) return;
      const n = only(v);
      if (n) {
        const [kind, body] = n;
        if (kind === "SelectStmt" || kind === "WindowDef") {
          // A flag found is still a fact: what the subquery returns is kept, untraced.
          if (kind === "SelectStmt") parts.push(...this.statement(v, scope).map(slotValue));
          opaque = true;
          return;
        }
        if (kind === "ColumnRef") {
          parts.push(this.value(v, scope));
          return;
        }
        if (kind.startsWith("Json")) opaque = true;
        if (kind === "FuncCall" && (isJsonFunction(body) || node(body.over) || body.agg_filter)) {
          opaque = true;
        }
        parts.push(named(this.keysRead(kind, body)));
      }
      for (const child of Object.values(v)) visit(child);
    };
    visit(value);
    const out = join(...parts);
    return opaque ? { ...out, unknown: true } : out;
  }

  private modify(body: Node, scope: Scope): Slot[] {
    // Without RETURNING it hands back nothing, but still reads documents a query may return,
    // as a modifying CTE does: its scopes are walked all the same.
    const clause = node(body.returningClause) ? body.returningClause : null;
    const returning = list(clause?.exprs);
    const inner = this.withCtes(body.withClause, scope);
    const target = this.item({ RangeVar: body.relation }, [], inner, FIRST, false)[0];
    const relations = [
      target,
      ...this.from(list(body.fromClause), inner),
      ...this.from(list(body.usingClause), inner),
      ...this.from(body.sourceRelation ? [body.sourceRelation] : [], inner),
    ];
    const written: Scope = { relations, ctes: new Map(), parent: inner };
    const before = target.slots.map(copy);
    const excluded = this.assign(body, target, written);
    // PostgreSQL 18 names the row before and after the write, `old` and `new` unless renamed.
    const names = { RETURNING_OPTION_OLD: "old", RETURNING_OPTION_NEW: "new" };
    for (const option of list(clause?.options)) {
      const o = only(option)?.[1];
      if ((o?.option === "RETURNING_OPTION_OLD" || o?.option === "RETURNING_OPTION_NEW") && o.value)
        names[o.option] = String(o.value);
    }
    relations.push(
      hiddenRelation(names.RETURNING_OPTION_OLD, before),
      hiddenRelation(names.RETURNING_OPTION_NEW, target.slots.map(copy)),
    );
    const out = this.projection(returning, written);
    // Every clause but RETURNING reads the row as it was, and an upsert's EXCLUDED.
    const was: Scope = {
      ...written,
      relations: [...relations.map((r) => (r === target ? { ...r, slots: before } : r)), excluded],
    };
    this.reads({ ...body, returningClause: null, selectStmt: null }, was);
    this.reads({ returningClause: clause }, written);
    return out;
  }

  // What the inserted rows put in each column, read before anything is written, then every SET
  // list (UPDATE, an upsert's update branch, MERGE's).
  private assign(body: Node, target: Relation, scope: Scope): Relation {
    // An INSERT's rows never see the table they go into.
    const source = scope.parent ?? scope;
    const into = (targets: unknown) => {
      const columns = list(targets).map((t) => {
        const name = only(t)?.[1].name;
        return typeof name === "string" ? name : null;
      });
      return columns.length ? columns : target.slots.map((s) => s.label);
    };
    let inserted: Written[] = [];
    const destinations = into(body.cols);
    const rows = only(body.selectStmt)?.[1];
    if (rows && Array.isArray(rows.valuesLists) && (rows.op ?? "SETOP_NONE") === "SETOP_NONE") {
      // A VALUES list hands each column what its rows put there, cell by cell.
      const cells = this.withCtes(rows.withClause, source);
      for (const row of rows.valuesLists) {
        for (const [i, cell] of list(only(row)?.[1].items).entries()) {
          inserted.push([destinations[i] ?? null, this.value(cell, cells)]);
        }
      }
      this.reads(rows, cells);
    } else if (body.selectStmt) {
      inserted = insertedRows(this.statement(body.selectStmt, source), destinations);
    }
    // MERGE's actions are alternatives, and a row it deletes returns what it held: any column may
    // still hold its old value.
    const clauses = list(body.mergeWhenClauses)
      .map((c) => only(c)?.[1])
      .filter((c): c is Node => c !== undefined);
    for (const c of clauses.filter((c) => c.commandType === "CMD_INSERT")) {
      const destinations = into(c.targetList);
      for (const [i, v] of list(c.values).entries()) {
        inserted.push([destinations[i] ?? null, this.value(v, scope), true]);
      }
    }
    const lists = [
      body.targetList,
      node(body.onConflictClause) ? body.onConflictClause.targetList : null,
      ...clauses.filter((c) => c.commandType === "CMD_UPDATE").map((c) => c.targetList),
    ];
    const merging = clauses.length > 0;
    return this.write(target, scope, inserted, (setScope) =>
      lists.flatMap((l) =>
        list(l).map((t): Written => {
          const set = only(t)?.[1];
          // `SET profile['note'] = ...` writes part of the column: the rest of it stays.
          const partial = merging || list(set?.indirection).length > 0;
          const column = typeof set?.name === "string" ? set.name : null;
          return [column, this.value(set?.val, setScope), partial];
        }),
      ),
    );
  }
}

function creates(body: Node): boolean {
  return Boolean(body.intoClause) || (node(body.larg) && creates(body.larg));
}

// `*` or `t.*` as the relation it expands, null for a bare star; undefined when not a star.
function starOf(value: unknown): string | null | undefined {
  const ref = only(value);
  if (ref?.[0] !== "ColumnRef") return undefined;
  const fields = list(ref[1].fields);
  if (only(fields.at(-1))?.[0] !== "A_Star") return undefined;
  return strings(fields).at(-1) ?? null;
}

export function outputPg(sql: string, columns?: Columns): QueryOutput | null {
  const read = readPg(sql);
  if (!read || read === "ambiguous") return null;
  const resolver = new Resolver(columns);
  const root: Scope = { relations: [], ctes: new Map() };
  try {
    return summary((read.tree.stmts ?? []).flatMap((s) => resolver.statement(s.stmt, root)));
  } catch {
    // The agent's SQL is untrusted: a shape that breaks the walker leaves the output untraced
    // instead of breaking the card, the decision or the trail.
    return { names: [], complete: false };
  }
}
