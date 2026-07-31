// Display-only SQL pretty printer. It reflows whitespace only: every non-whitespace
// token is kept verbatim and in order, so the reviewer always reads the same query.
// A canonical token check backstops that, falling back to the original on any drift.

type TokType = "str" | "word" | "op" | "punct" | "comment" | "ws";
export interface Tok {
  t: TokType;
  v: string;
}

// Longest first, so ">=" wins over ">" and "->>" over "->".
const MULTI_OPS = ["->>", ">=", "<=", "<>", "!=", "||", "::", "->"];

const WORD = /[A-Za-z0-9_$.]/;

export function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      toks.push({ t: "ws", v: sql.slice(i, j) });
      i = j;
    } else if (c === "'" || c === '"' || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (q !== "`" && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === q) {
          if (sql[j + 1] === q) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      toks.push({ t: "str", v: sql.slice(i, j) });
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      toks.push({ t: "comment", v: sql.slice(i, j) });
      i = j;
    } else if (c === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      toks.push({ t: "comment", v: sql.slice(i, j) });
      i = j;
    } else if (WORD.test(c)) {
      let j = i + 1;
      while (j < n && WORD.test(sql[j])) j++;
      toks.push({ t: "word", v: sql.slice(i, j) });
      i = j;
    } else {
      const op = MULTI_OPS.find((o) => sql.startsWith(o, i));
      if (op) {
        toks.push({ t: "op", v: op });
        i += op.length;
      } else {
        toks.push({ t: "punct", v: c });
        i++;
      }
    }
  }
  return toks;
}

// The token stream ignoring whitespace: the invariant the formatter must preserve.
function canonical(sql: string): string {
  return tokenize(sql)
    .filter((t) => t.t !== "ws")
    .map((t) => t.v)
    .join("");
}

// Drives only the space-before-"(" choice (a keyword wants a space, a function call
// does not); it never affects which tokens are emitted.
const KEYWORDS = new Set([
  "select",
  "distinct",
  "all",
  "from",
  "where",
  "group",
  "by",
  "order",
  "having",
  "limit",
  "offset",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "outer",
  "cross",
  "on",
  "using",
  "union",
  "except",
  "intersect",
  "and",
  "or",
  "not",
  "in",
  "exists",
  "between",
  "like",
  "ilike",
  "is",
  "null",
  "as",
  "case",
  "when",
  "then",
  "else",
  "end",
  "asc",
  "desc",
  "over",
  "partition",
  "with",
  "values",
  "returning",
  "interval",
  "filter",
  "within",
]);

function nextSig(toks: Tok[], k: number): number {
  let j = k + 1;
  while (j < toks.length && toks[j].t === "ws") j++;
  return j;
}

function wordAt(toks: Tok[], k: number): string {
  return k < toks.length && toks[k].t === "word" ? toks[k].v.toLowerCase() : "";
}

// A clause keyword (possibly multi-word) starting at word index i; returns the last
// token index it spans, or -1 when i does not begin a clause.
function clauseEnd(toks: Tok[], i: number): number {
  const w = toks[i].v.toLowerCase();
  const j = nextSig(toks, i);
  const w2 = wordAt(toks, j);
  const k = nextSig(toks, j);
  const w3 = wordAt(toks, k);
  if ((w === "group" || w === "order") && w2 === "by") return j;
  if (w === "union" && w2 === "all") return j;
  if (w === "left" || w === "right" || w === "full") {
    if (w2 === "outer" && w3 === "join") return k;
    if (w2 === "join") return j;
  }
  if ((w === "inner" || w === "cross") && w2 === "join") return j;
  if (
    ["from", "where", "having", "limit", "offset", "join", "union", "except", "intersect"].includes(
      w,
    )
  ) {
    return i;
  }
  return -1;
}

function reflow(sql: string): string {
  const toks = tokenize(sql);
  const lines: string[] = [];
  let cur = "";
  let depth = 0;
  let selectList = false;
  let prevVal = "";
  let prevType: TokType | "" = "";

  const flush = () => {
    if (cur.trim().length) lines.push(cur.replace(/\s+$/, ""));
    cur = "";
  };
  const newLine = (indent: string) => {
    flush();
    cur = indent;
  };
  const atLineStart = () => cur.length === 0 || /^\s+$/.test(cur);
  const spaceBefore = (v: string): boolean => {
    if (atLineStart()) return false;
    if (v === "," || v === ")" || v === ";" || v === "::" || v === ".") return false;
    if (prevVal === "(" || prevVal === "::" || prevVal === ".") return false;
    if (v === "(") return prevType === "word" && KEYWORDS.has(prevVal.toLowerCase());
    return true;
  };
  const append = (tk: Tok) => {
    cur += (spaceBefore(tk.v) ? " " : "") + tk.v;
    prevVal = tk.v;
    prevType = tk.t;
  };

  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === "ws") {
      i++;
      continue;
    }
    if (depth === 0 && tk.t === "word") {
      const lw = tk.v.toLowerCase();
      const end = clauseEnd(toks, i);
      if (end >= 0) {
        newLine("");
        for (let k = i; k <= end; k++) if (toks[k].t !== "ws") append(toks[k]);
        selectList = false;
        i = end + 1;
        continue;
      }
      if (lw === "select") {
        newLine("");
        append(tk);
        let adv = i + 1;
        const j = nextSig(toks, i);
        const w2 = wordAt(toks, j);
        if (w2 === "distinct" || w2 === "all") {
          append(toks[j]);
          adv = j + 1;
        }
        selectList = true;
        newLine("  ");
        i = adv;
        continue;
      }
      if (lw === "with") {
        newLine("");
        append(tk);
        i++;
        continue;
      }
    }
    if (depth === 0 && selectList && tk.t === "punct" && tk.v === ",") {
      append(tk);
      newLine("  ");
      i++;
      continue;
    }
    if (tk.t === "punct" && tk.v === "(") depth++;
    if (tk.t === "punct" && tk.v === ")") depth = Math.max(0, depth - 1);
    append(tk);
    i++;
  }
  flush();
  return lines.join("\n");
}

export function formatSql(sql: string): string {
  try {
    const out = reflow(sql);
    return out && canonical(out) === canonical(sql) ? out : sql;
  } catch {
    return sql;
  }
}
