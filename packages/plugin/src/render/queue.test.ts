import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Card, RunState, SessionMeta } from "../types";
import { cardHtml, runningActions } from "./queue";

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
  it("renders a ready card with schema flags and an open deny draft", () => {
    expect(cardHtml(card, "postgresql", denyDrafts)).toBe(
      '\n      <div class="card " data-card="q_ab12">\n        <div class="top">\n          <span class="intent">Check a user\'s email</span>\n          <span class="lease">1:30</span>\n        </div>\n        <div class="meta">q_ab12 &middot; 12s ago</div>\n        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="SELECT email, company_name FROM audit.users WHERE email = \'jane@acme.io\'" aria-label="Copy SQL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button><code class="sql-body" id="sqlbody-q_ab12"><span class="kw">SELECT</span>\n  <span class="pii-col">email</span>,\n  <span class="client-col">company_name</span>\n<span class="kw">FROM</span> audit.users\n<span class="kw">WHERE</span> <span class="pii-col">email</span> = <span class="st sensitive-val">\'jane@acme.io\'</span></code></pre>\n        <div class="card-schema" id="cs-q_ab12"><div class="cs-reads"><span class="cs-reads-k"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/></svg>Read</span><span class="tbl-chip">audit.users</span></div><div class="cs-line cs-pii"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>possible PII</span><span class="cs-list">email</span></div><div class="cs-line cs-client"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>client data</span><span class="cs-list">company_name</span></div><div class="cs-line cs-literal"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>sensitive value</span><span class="cs-list">\'jane@acme.io\'</span></div></div>\n        <div class="actions">\n             <button class="btn approve" type="button" data-approve="q_ab12" >Approve</button>\n             <button class="btn reject" type="button" data-reject="q_ab12">Reject</button>\n             <div class="deny-field">\n             <input class="deny-reason" type="text" maxlength="140" data-deny-input="q_ab12" aria-label="What should the agent change?" placeholder="What should the agent change?" autocomplete="off" spellcheck="false" value="use a bind param" />\n             <button class="deny-send" type="button" data-deny="q_ab12" aria-label="Send to the agent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>\n           </div>\n           </div>\n      </div>',
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

  it("renders a write card in write mode: amber badge, Approve write, Write annotation", () => {
    const html = cardHtml(
      ready("q2", "INSERT INTO logs (id) VALUES (1)"),
      "postgresql",
      noDrafts,
      "write",
    );
    expect(html).toContain('class="card write"');
    expect(html).toContain('<span class="risk-badge write">Write</span>');
    expect(html).toContain('class="cs-writes write"');
    expect(html).toContain('data-approve="q2" >Approve write</button>');
    expect(html).not.toContain("blocked-note");
  });

  it("blocks a write card in read mode with the write-mode note, Approve disabled", () => {
    const html = cardHtml(
      ready("q3", "INSERT INTO logs (id) VALUES (1)"),
      "postgresql",
      noDrafts,
      "read",
    );
    expect(html).toContain('class="card write blocked"');
    expect(html).toContain("Write mode required to approve this query.");
    expect(html).toContain('data-approve="q3" disabled>Approve write</button>');
  });

  it("renders a destructive card in destructive mode: red badge, red Approve, Delete annotation", () => {
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
    expect(html).toContain('class="cs-writes destructive"');
    expect(html).toContain("Delete");
  });

  it("blocks a destructive card in write mode with the destructive-mode note", () => {
    const html = cardHtml(ready("q5", "DROP TABLE users"), "postgresql", noDrafts, "write");
    expect(html).toContain('class="card destructive blocked"');
    expect(html).toContain("Destructive mode required to approve this query.");
    expect(html).toContain("disabled>Approve destructive</button>");
  });

  it("shows both Writes and Reads for a mixed INSERT ... SELECT", () => {
    const html = cardHtml(
      ready("q6", "INSERT INTO audit SELECT * FROM users"),
      "postgresql",
      noDrafts,
      "write",
    );
    expect(html).toContain('class="cs-writes write"');
    expect(html).toContain('class="cs-reads"');
    expect(html).toContain('<span class="tbl-chip">audit</span>');
    expect(html).toContain('<span class="tbl-chip">users</span>');
  });

  it("labels every removal Delete and every other change Write", () => {
    for (const sql of ["DROP TABLE users", "DELETE FROM users WHERE id = 1", "TRUNCATE users"]) {
      const html = cardHtml(ready("q10", sql), "postgresql", noDrafts, "destructive");
      expect(html, sql).toContain('Delete</span><span class="tbl-chip">users</span>');
    }
    const update = cardHtml(
      ready("q11", "UPDATE users SET name = 'x'"),
      "postgresql",
      noDrafts,
      "write",
    );
    expect(update).toContain('Write</span><span class="tbl-chip">users</span>');
  });

  it("names the target of a SELECT ... INTO, not just the table it reads", () => {
    const html = cardHtml(
      ready("q8", "SELECT * INTO staging_copy FROM crm.people"),
      "postgresql",
      noDrafts,
      "destructive",
    );
    expect(html).toContain('class="cs-writes destructive"');
    expect(html).toContain('Write</span><span class="tbl-chip">staging_copy</span>');
    expect(html).toContain('class="cs-reads"');
    expect(html).toContain('<span class="tbl-chip">crm.people</span>');
  });

  it("names the file a MySQL INTO OUTFILE exports to", () => {
    const html = cardHtml(
      ready("q9", "SELECT id, email INTO OUTFILE '/tmp/people.csv' FROM crm.people"),
      "mysql",
      noDrafts,
      "destructive",
    );
    expect(html).toContain('class="cs-writes destructive"');
    expect(html).toContain('Write</span><span class="tbl-chip">/tmp/people.csv</span>');
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
    expect(html).toContain("Connection is read-only; this write cannot run.");
    expect(html).toContain('data-approve="q8" disabled>Approve write</button>');
  });

  it("renders a card with its open deny form and its draft", () => {
    expect(cardHtml(card, "postgresql", denyDrafts)).toBe(
      '\n      <div class="card " data-card="q_ab12">\n        <div class="top">\n          <span class="intent">Check a user\'s email</span>\n          <span class="lease">1:30</span>\n        </div>\n        <div class="meta">q_ab12 &middot; 12s ago</div>\n        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="SELECT email, company_name FROM audit.users WHERE email = \'jane@acme.io\'" aria-label="Copy SQL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button><code class="sql-body" id="sqlbody-q_ab12"><span class="kw">SELECT</span>\n  <span class="pii-col">email</span>,\n  <span class="client-col">company_name</span>\n<span class="kw">FROM</span> audit.users\n<span class="kw">WHERE</span> <span class="pii-col">email</span> = <span class="st sensitive-val">\'jane@acme.io\'</span></code></pre>\n        <div class="card-schema" id="cs-q_ab12"><div class="cs-reads"><span class="cs-reads-k"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/></svg>Read</span><span class="tbl-chip">audit.users</span></div><div class="cs-line cs-pii"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>possible PII</span><span class="cs-list">email</span></div><div class="cs-line cs-client"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>client data</span><span class="cs-list">company_name</span></div><div class="cs-line cs-literal"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>sensitive value</span><span class="cs-list">\'jane@acme.io\'</span></div></div>\n        <div class="actions">\n             <button class="btn approve" type="button" data-approve="q_ab12" >Approve</button>\n             <button class="btn reject" type="button" data-reject="q_ab12">Reject</button>\n             <div class="deny-field">\n             <input class="deny-reason" type="text" maxlength="140" data-deny-input="q_ab12" aria-label="What should the agent change?" placeholder="What should the agent change?" autocomplete="off" spellcheck="false" value="use a bind param" />\n             <button class="deny-send" type="button" data-deny="q_ab12" aria-label="Send to the agent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>\n           </div>\n           </div>\n      </div>',
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
      unavailable: "This feature is not available on SQLite.",
      ended: false,
    });
    expect(html).toContain('data-stop="q" disabled>');
    expect(html).toContain('<span class="approve-pop warn" role="tooltip">');
    expect(html).toContain("This feature is not available on SQLite.</span>");
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
    expect(html).toContain("<span>An error occurred while stopping the query.</span>");
    expect(html).toContain('<span class="stop-raw">permission &lt;denied&gt;</span>');
  });

  it("names the other transient states in the UI face", () => {
    const html = cardHtml({ ...base, state: "approving" }, "postgresql", noDrafts);
    expect(html).toContain('<span class="busy"><span class="spin"></span>Approving&hellip;</span>');
    expect(html).not.toContain('class="lease');
  });
});
