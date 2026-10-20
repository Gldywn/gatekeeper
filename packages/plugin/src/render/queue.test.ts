import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Card, RunState, SessionMeta } from "../types";
import { accessMatrix, cardHtml, paintLegend, runningActions } from "./queue";

// Byte-for-byte lock on the extracted builders: one ready read-only card whose
// schema annotation and open deny draft exercise every conditional branch.

const T = new Date("2026-01-01T00:00:00Z").getTime();

const session: SessionMeta = {
  sessionId: "s1",
  harness: "claude-code",
  harnessVersion: null,
  project: "gatekeeper",
  sessionLabel: "audit review",
};

const card: Card = {
  id: "q_ab12",
  sql: "SELECT email, company_name FROM audit.users WHERE email = 'jane@acme.io'",
  intent: "check a user's email",
  createdAt: T - 12_000,
  expiresAt: T + 90_000,
  leaseId: "lease-1",
  leaseExpiresAt: T + 90_000,
  sessionId: "s1",
  session,
  state: "ready",
  schema: {
    tables: ["audit.users"],
    pii: ["email"],
    client: ["company_name"],
    literals: ["jane@acme.io"],
    star: false,
  },
};

const denyDrafts = new Map<string, string>([["q_ab12", "use a bind param"]]);

// clock()/relAge() read Date.now(); freeze it so the lease and age render stably.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterAll(() => {
  vi.useRealTimers();
});

describe("render/queue", () => {
  it("renders a ready card: request, tables, legend, SQL, then the decision with its expiry", () => {
    const html = cardHtml(card, "postgresql", denyDrafts);
    expect(html).toContain('<div class="card " data-card="q_ab12">');
    expect(html).toContain('<span class="intent">Check a user\'s email</span>');
    expect(html).toContain('<div class="meta">q_ab12 &middot; Requested 12s ago</div>');
    // Tables by role, before the SQL; the read's table comes from the column analysis.
    expect(html).toContain('<div class="cs-matrix" id="cm-q_ab12"><table class="mx">');
    expect(html).toContain('<th scope="row" class="nm">audit.users</th><td class="mk on read">');
    // The legend names each category the SQL marks, with its count; focus names its objects.
    expect(html).toContain(
      '<span class="lg-slot"><button class="lg pii" type="button" aria-describedby="lg-pii-q_ab12"><span class="sw">Possible PII</span><span class="ct">1</span></button><span class="lg-pop" id="lg-pii-q_ab12" role="tooltip">email</span></span>',
    );
    expect(html).toContain(
      '<span class="lg-pop" id="lg-client-q_ab12" role="tooltip">company_name</span>',
    );
    expect(html).toContain(
      '<span class="lg-pop" id="lg-val-q_ab12" role="tooltip">\'jane@acme.io\'</span>',
    );
    expect(html.indexOf('id="cs-q_ab12"')).toBeLessThan(html.indexOf('<pre class="sql">'));
    expect(html).toContain('<span class="pii-col" title="Possible PII">email</span>');
    expect(html).toContain(
      "data-copy-sql=\"SELECT email, company_name FROM audit.users WHERE email = 'jane@acme.io'\"",
    );
    // The decision closes the card: actions, the open deny draft, then the expiry.
    expect(html).toContain('<div class="dbar"><div class="actions">');
    expect(html).toContain('value="use a bind param"');
    expect(html).toContain(
      '<span class="nb-due">Expires in <span class="lease">1:30</span></span>',
    );
    // The expiry left the title line.
    expect(html).not.toMatch(
      /<div class="top">[\s\S]*?class="lease"[\s\S]*?<\/div>\s*<div class="meta">/,
    );
  });

  const noDrafts = new Map<string, string>();
  function ready(id: string, sql: string): Card {
    return {
      id,
      sql,
      createdAt: T - 1000,
      expiresAt: T + 90_000,
      leaseId: "l",
      leaseExpiresAt: T + 90_000,
      sessionId: "s1",
      session,
      state: "ready",
    };
  }

  it("leaves a read card unchanged: no badge, plain enabled Approve", () => {
    const html = cardHtml(ready("q1", "SELECT 1"), "postgresql", noDrafts, "read");
    expect(html).toContain('class="card "');
    expect(html).not.toContain("risk-badge");
    expect(html).toContain('data-approve="q1" >Approve</button>');
  });

  it("renders a write card in write mode: amber badge, Approve write, the table under Write", () => {
    const html = cardHtml(
      ready("q2", "INSERT INTO logs (id) VALUES (1)"),
      "postgresql",
      noDrafts,
      "write",
    );
    expect(html).toContain('class="card write"');
    expect(html).toContain('<span class="risk-badge write">Write</span>');
    expect(html).toContain('<th scope="row" class="nm">logs</th>');
    expect(html).toContain('<td class="mk on write">');
    expect(html).toContain('data-approve="q2" >Approve write</button>');
    expect(html).not.toContain("nb-msg");
  });

  it("blocks a write card in read mode, the reason written above a disabled Approve", () => {
    const html = cardHtml(
      ready("q3", "INSERT INTO logs (id) VALUES (1)"),
      "postgresql",
      noDrafts,
      "read",
    );
    expect(html).toContain('class="card write blocked"');
    expect(html).toContain('<div class="nb-msg" id="gate-q3">');
    expect(html).toContain("Write mode is required to approve this query.");
    expect(html).toContain(
      'data-approve="q3" aria-describedby="gate-q3" disabled>Approve write</button>',
    );
    expect(html.indexOf('id="gate-q3"')).toBeLessThan(html.indexOf('data-approve="q3"'));
  });

  it("renders a destructive card in destructive mode: red badge, red Approve, the table under Delete", () => {
    const html = cardHtml(
      ready("q4", "DELETE FROM users WHERE id = 1"),
      "postgresql",
      noDrafts,
      "destructive",
    );
    expect(html).toContain('class="card destructive"');
    expect(html).toContain('<span class="risk-badge destructive">Destructive</span>');
    expect(html).toContain('class="btn approve destructive"');
    expect(html).toContain(">Approve destructive</button>");
    expect(html).toContain('<td class="mk on delete">');
  });

  it("blocks a destructive card in write mode with the destructive-mode note", () => {
    const html = cardHtml(ready("q5", "DROP TABLE users"), "postgresql", noDrafts, "write");
    expect(html).toContain('class="card destructive blocked"');
    expect(html).toContain("Destructive mode is required to approve this query.");
    expect(html).toContain("disabled>Approve destructive</button>");
  });

  // A row per table, with the role cells it plays: Read, Write, Delete.
  const roles = (html: string, table: string) => {
    const row = html.match(new RegExp(`<tr><th scope="row" class="nm">${table}</th>(.*?)</tr>`));
    return [...(row?.[1].matchAll(/<td class="mk( on (\w+))?">/g) ?? [])].map((m) => m[2] ?? "-");
  };

  it("shows both the written and the read table of a mixed INSERT ... SELECT", () => {
    const html = cardHtml(
      ready("q6", "INSERT INTO audit SELECT * FROM users"),
      "postgresql",
      noDrafts,
      "write",
    );
    expect(roles(html, "audit")).toEqual(["-", "write", "-"]);
    expect(roles(html, "users")).toEqual(["read", "-", "-"]);
  });

  it("labels every removal Delete and every other change Write", () => {
    for (const sql of ["DROP TABLE users", "DELETE FROM users WHERE id = 1", "TRUNCATE users"]) {
      const html = cardHtml(ready("q10", sql), "postgresql", noDrafts, "destructive");
      expect(roles(html, "users"), sql).toEqual(["-", "-", "delete"]);
    }
    const update = cardHtml(
      ready("q11", "UPDATE users SET name = 'x'"),
      "postgresql",
      noDrafts,
      "write",
    );
    expect(roles(update, "users")).toEqual(["-", "write", "-"]);
  });

  it("names the target of a SELECT ... INTO, not just the table it reads", () => {
    const html = cardHtml(
      ready("q8", "SELECT * INTO staging_copy FROM crm.people"),
      "postgresql",
      noDrafts,
      "destructive",
    );
    expect(roles(html, "staging_copy")).toEqual(["-", "write", "-"]);
    expect(roles(html, "crm.people")).toEqual(["read", "-", "-"]);
  });

  it("names the file a MySQL INTO OUTFILE exports to", () => {
    const html = cardHtml(
      ready("q9", "SELECT id, email INTO OUTFILE '/tmp/people.csv' FROM crm.people"),
      "mysql",
      noDrafts,
      "destructive",
    );
    expect(roles(html, "/tmp/people.csv")).toEqual(["-", "write", "-"]);
  });

  it("keeps a multi-statement query blocked even in destructive mode", () => {
    const html = cardHtml(
      ready("q7", "SELECT 1; DROP TABLE t"),
      "postgresql",
      noDrafts,
      "destructive",
    );
    expect(html).toContain("blocked");
    expect(html).toContain("A single, non-empty SQL statement is required.");
    expect(html).toContain("disabled");
  });

  it("blocks a write by a read-only connection even with write mode armed", () => {
    const html = cardHtml(
      ready("q8", "INSERT INTO logs (id) VALUES (1)"),
      "postgresql",
      noDrafts,
      "write",
      true,
    );
    expect(html).toContain('class="card write blocked"');
    expect(html).toContain("A writable connection is required to run this write.");
    expect(html).toContain(
      'data-approve="q8" aria-describedby="gate-q8" disabled>Approve write</button>',
    );
  });

  it("names the class it guessed when the parser could not read the statement", () => {
    // A plain SELECT the parser refuses (an ambiguous escaped quote) still reads
    // as a read: the note must not call it destructive.
    const unparsedRead = cardHtml(
      { ...card, sql: "SELECT regexp_replace(code, 'a\\'b', '', 'g') FROM audit.parts" },
      "postgresql",
      denyDrafts,
    );
    expect(unparsedRead).toContain(
      "This statement could not be parsed. The read classification is a guess. Waiting for your review.",
    );
    expect(unparsedRead).not.toContain("destructive classification");

    // A statement the fallback cannot vouch for keeps the strict wording.
    const unparsedDestructive = cardHtml(
      { ...card, sql: "DROP DATABASE IF EXISTS audit \\" },
      "postgresql",
      denyDrafts,
      "destructive",
    );
    expect(unparsedDestructive).toContain("The destructive classification is a guess.");

    // A parsed statement says nothing at all.
    expect(cardHtml(card, "postgresql", denyDrafts)).not.toContain("could not be parsed");
  });
});

describe("render/queue running row", () => {
  const noDrafts = new Map<string, string>();
  const base: Card = {
    id: "req_0123456789ab",
    sql: "SELECT 1",
    createdAt: T - 60_000,
    expiresAt: T + 90_000,
    leaseId: "l",
    leaseExpiresAt: T + 90_000,
    sessionId: "s1",
    session: null,
    state: "executing",
  };
  const tagged: RunState = {
    startedAt: T - 4_000,
    limitMs: 0,
    engine: "postgresql",
    tag: "/* gatekeeper req_0123456789ab a1b2c3d4e5f6 */",
    ended: false,
  };
  const card = (run: Partial<RunState>, state: Card["state"] = "executing"): Card => ({
    ...base,
    state,
    run: { ...tagged, ...run },
  });

  it("shows a live Stop in Approve's place with the elapsed clock, and no expiry clock", () => {
    const html = cardHtml(card({}), "postgresql", noDrafts);
    expect(html).toContain('class="card  running"');
    expect(html).toContain(
      '<button class="btn stop" type="button" data-stop="req_0123456789ab"><span class="sq" aria-hidden="true"></span>Stop</button>',
    );
    expect(html).toContain('<span class="clock run-clock">0:04</span>');
    expect(html).not.toContain('class="lease');
    expect(html).not.toContain("btn approve");
  });

  it("reads as long from 45 s", () => {
    expect(cardHtml(card({ startedAt: T - 44_000 }), "postgresql", noDrafts)).not.toContain(
      "running long",
    );
    expect(cardHtml(card({ startedAt: T - 45_000 }), "postgresql", noDrafts)).toContain(
      'class="card  running long"',
    );
  });

  it("counts down to the auto-stop until a stop is requested", () => {
    const limited = runningActions("q", { ...tagged, limitMs: 300_000, startedAt: T - 192_000 });
    expect(limited).toContain('Auto-stop in<span class="clock autostop-clock">1:48</span>');
    const requested = runningActions("q", {
      ...tagged,
      limitMs: 300_000,
      stop: { by: "operator", atMs: 1, state: "pending", inFlight: true, attempts: 1 },
    });
    expect(requested).not.toContain("Auto-stop in");
    expect(requested).toContain(
      'disabled><span class="sq" aria-hidden="true"></span>Stopping&hellip;',
    );
  });

  it("disables Stop with the standard warning where it is unavailable", () => {
    const html = runningActions("q", {
      startedAt: T,
      limitMs: 300_000,
      unavailable: "PostgreSQL or MySQL is required to stop a query.",
      ended: false,
    });
    expect(html).toContain('data-stop="q" disabled>');
    expect(html).toContain('<span class="approve-pop warn" role="tooltip">');
    expect(html).toContain("PostgreSQL or MySQL is required to stop a query.</span>");
    expect(html).not.toContain("Auto-stop in");
  });

  it("shows a failed stop as an error note with the database's raw text", () => {
    const html = runningActions("q", {
      ...tagged,
      stop: {
        by: "operator",
        atMs: 1,
        state: "idle",
        inFlight: false,
        attempts: 1,
        error: "permission <denied>",
      },
    });
    expect(html).toContain('data-stop="q"><span');
    expect(html).toContain('<div class="cs-unparsed stop-error" role="status">');
    expect(html).toContain("<span>Stop could not be confirmed.</span>");
    expect(html).toContain('<span class="stop-raw">permission &lt;denied&gt;</span>');
    const byLimit = runningActions("q", {
      ...tagged,
      stop: { by: "limit", atMs: 1, state: "idle", inFlight: false, attempts: 1, error: "x" },
    });
    expect(byLimit).toContain("<span>Auto-stop could not be confirmed.</span>");
  });

  it("names the other transient states in the UI face", () => {
    const html = cardHtml({ ...base, state: "approving" }, "postgresql", noDrafts);
    expect(html).toContain('<span class="busy"><span class="spin"></span>Approving&hellip;</span>');
    expect(html).not.toContain('class="lease');
  });
});

describe("the pending card's order", () => {
  it("puts the analysis note above the SQL and Auto mode's note between the SQL and the bar", () => {
    const base = {
      id: "q_o",
      createdAt: T - 1000,
      expiresAt: T + 90_000,
      leaseId: "l",
      leaseExpiresAt: T + 90_000,
      sessionId: "s1",
      session,
      state: "ready" as const,
    };
    const unparsed = cardHtml(
      { ...base, sql: "SELECT regexp_replace(code, 'a\\'b', '', 'g') FROM audit.parts" },
      "postgresql",
      new Map(),
    );
    expect(unparsed.indexOf("could not be parsed")).toBeLessThan(
      unparsed.indexOf('<pre class="sql">'),
    );
    const held = cardHtml(
      {
        ...base,
        sql: "SELECT 1",
        autoStatus: "Needs review: Evaluation timed out. Approve manually",
      },
      "postgresql",
      new Map(),
    );
    const sql = held.indexOf('<pre class="sql">');
    const note = held.indexOf("Held on this machine before evaluation.");
    expect(sql).toBeLessThan(note);
    expect(note).toBeLessThan(held.indexOf('<div class="dbar">'));
  });

  it("lists a read's tables from the column analysis once it lands", () => {
    const html = accessMatrix("SELECT * FROM v", "postgresql", "read", {
      tables: ["public.orders"],
      pii: [],
      client: [],
      literals: [],
      star: true,
    });
    expect(html).toContain('<th scope="row" class="nm">public.orders</th>');
    expect(accessMatrix("SELECT 1", "postgresql", "read", null)).toBe("");
  });
});

describe("sensitive names the SQL does not spell out", () => {
  it("lists a column a SELECT * expands to under its category in the legend", () => {
    const html = cardHtml(
      {
        id: "q_s",
        sql: "SELECT * FROM public.users",
        createdAt: T - 1000,
        expiresAt: T + 90_000,
        leaseId: "l",
        leaseExpiresAt: T + 90_000,
        sessionId: "s1",
        session,
        state: "ready",
        schema: { tables: ["public.users"], pii: ["email"], client: [], literals: [], star: true },
      },
      "postgresql",
      new Map(),
    );
    expect(html).toContain('<span class="lg-pop" id="lg-pii-q_s" role="tooltip">email</span>');
  });
});

describe("paintLegend", () => {
  // A fake host that holds one entry per painted aria-describedby and records what took focus.
  function fakeHost() {
    const focused: string[] = [];
    type Entry = { getAttribute: () => string; focus: () => void };
    let entries: Entry[] = [];
    const doc = { activeElement: null as unknown };
    const el = {
      ownerDocument: doc,
      set innerHTML(html: string) {
        entries = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map(([, id]) => ({
          getAttribute: () => id,
          focus: () => focused.push(id),
        }));
      },
      contains: (n: unknown) => entries.includes(n as Entry),
      querySelector: (s: string) =>
        s === ".lg"
          ? (entries[0] ?? null)
          : (entries.find((e) => s === `[aria-describedby="${e.getAttribute()}"]`) ?? null),
    };
    return { el: el as unknown as HTMLElement, doc, focused, entry: (i: number) => entries[i] };
  }
  const both = { tables: [], pii: ["email"], client: ["company_name"], literals: [], star: false };

  afterAll(() => vi.unstubAllGlobals());

  it("keeps a focused entry on its category across a repaint, else on the first one left", () => {
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    const h = fakeHost();
    paintLegend(h.el, both, "q1");
    h.doc.activeElement = h.entry(1);
    paintLegend(h.el, both, "q1");
    expect(h.focused).toEqual(["lg-client-q1"]);
    h.doc.activeElement = h.entry(0);
    paintLegend(h.el, { ...both, pii: [] }, "q1");
    expect(h.focused).toEqual(["lg-client-q1", "lg-client-q1"]);
  });

  it("leaves the focus alone when it is elsewhere", () => {
    const h = fakeHost();
    paintLegend(h.el, both, "q1");
    h.doc.activeElement = {};
    paintLegend(h.el, both, "q1");
    expect(h.focused).toEqual([]);
  });
});
