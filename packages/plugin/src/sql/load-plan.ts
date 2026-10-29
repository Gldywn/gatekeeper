// What a walker learns from a statement for the load check, in no parser's terms: the check
// itself (load.ts) never reads a parse tree.

// A table segment carries its reference as the SQL names it, so the card can tie an estimate to it
// without matching display text; a keyword is marked to read as SQL.
export type Segment = string | { code: string; ref?: string; kw?: true };
export type Line = Segment[];

export interface Rel {
  schema: string | null;
  table: string;
}

export interface Ref {
  table: string | null;
  column: string;
}

// One AND-ed part of an ON or of the WHERE: the columns it names outside nested statements, and
// the columns each of its OR branches names (the part itself when it has no OR).
export interface Condition {
  refs: Ref[];
  branches: Ref[][];
}

export interface Source {
  alias: string;
  // Absent for derived tables, CTE references and table functions: no estimate of their own.
  rel?: Rel;
  joinedBy: "first" | "comma" | "cross" | "on" | "using";
  using?: string[];
  // A function or LATERAL item reads its siblings: the aliases its arguments name, or null
  // when they cannot be told, which joins it to every source before it.
  reads?: string[] | null;
  // TABLESAMPLE SYSTEM reads only a fraction of the pages.
  sampled?: boolean;
  // Blocks read through this source (a derived table or CTE body): their cost depends on how
  // the enclosing query filters or limits this source.
  inner?: Block[];
}

export interface Block {
  sources: Source[];
  // The ONs first, then the WHERE.
  conditions: Condition[];
  noWhere: boolean;
  // WHERE FALSE or WHERE 1 = 0: nothing is read, a common way to fetch column names.
  empty: boolean;
  limited: boolean;
  preview: boolean;
  // A filter or LIMIT on this block's rows bounds what it reads. False when it must consume its
  // whole input first (an aggregate, a window, GROUP BY, DISTINCT, its own LIMIT) or always
  // runs in full (a write).
  passes: boolean;
  // A source whose columns, if each leads an index, let PostgreSQL answer from a few index
  // entries: the ORDER BY of a small LIMIT, or every min/max argument.
  indexOrder?: { table: string | null; columns: string[] };
}

export interface Write {
  op: "update" | "delete";
  target: number;
  block: Block;
}

export interface Lock {
  rel?: Rel;
  line: (t: Segment) => Line;
  hint: string;
}

export interface LoadWalk {
  blocks: Block[];
  writes: Write[];
  locks: Lock[];
  // False when part of the statement could not be read or is not modelled.
  covered: boolean;
}

export const PREVIEW_LIMIT = 1000;
export const MAX_BLOCKS = 64;
export const MAX_DEPTH = 8;

export class Incomplete extends Error {}

export const INDEX_HINT =
  "CREATE INDEX without CONCURRENTLY blocks writes on the table during the build.";
export const REINDEX_HINT = "REINDEX without CONCURRENTLY blocks writes on the table.";
export const ALTER_HINT = "ALTER TABLE may lock and rewrite the table.";
export const REWRITE_HINT = "VACUUM FULL and CLUSTER lock and rewrite the table.";
export const REFRESH_HINT =
  "REFRESH MATERIALIZED VIEW without CONCURRENTLY blocks reads of the view.";
export const LOCK_HINT = "LOCK TABLE holds an explicit lock on the table.";

// A statement that cannot be read at all: nothing found, nothing claimed.
export function unreadWalk(): LoadWalk {
  return { blocks: [], writes: [], locks: [], covered: false };
}
