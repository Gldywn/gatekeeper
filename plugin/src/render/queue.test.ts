import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Card, SessionMeta } from "../types";
import { cardHtml, groupHtml } from "./queue";

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
      '\n      <div class="card " data-card="q_ab12">\n        <div class="top">\n          <span class="intent">Check a user\'s email</span>\n          <span class="lease">1:30</span>\n        </div>\n        <div class="meta">q_ab12 &middot; 12s ago</div>\n        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="SELECT email, company_name FROM audit.users WHERE email = \'jane@acme.io\'" aria-label="Copy SQL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button><code class="sql-body" id="sqlbody-q_ab12"><span class="kw">SELECT</span>\n  <span class="pii-col">email</span>,\n  <span class="client-col">company_name</span>\n<span class="kw">FROM</span> audit.users\n<span class="kw">WHERE</span> <span class="pii-col">email</span> = <span class="st sensitive-val">\'jane@acme.io\'</span></code></pre>\n        <div class="card-schema" id="cs-q_ab12"><div class="cs-reads"><span class="cs-reads-k"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/></svg>Reads</span><span class="tbl-chip">audit.users</span></div><div class="cs-line cs-pii"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>possible PII</span><span class="cs-list">email</span></div><div class="cs-line cs-client"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>client data</span><span class="cs-list">company_name</span></div><div class="cs-line cs-literal"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>sensitive value</span><span class="cs-list">\'jane@acme.io\'</span></div></div>\n        <div class="actions">\n             <button class="btn approve" type="button" data-approve="q_ab12" >Approve</button>\n             <button class="btn reject" type="button" data-reject="q_ab12">Reject</button>\n             <div class="deny-field">\n             <input class="deny-reason" type="text" maxlength="140" data-deny-input="q_ab12" aria-label="What should the agent change?" placeholder="What should the agent change?" autocomplete="off" spellcheck="false" value="use a bind param" />\n             <button class="deny-send" type="button" data-deny="q_ab12" aria-label="Send to the agent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>\n           </div>\n           </div>\n      </div>',
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

  it("keeps a multi-statement query blocked even in destructive mode", () => {
    const html = cardHtml(
      ready("q7", "SELECT 1; DROP TABLE t"),
      "postgresql",
      noDrafts,
      "destructive",
    );
    expect(html).toContain("blocked");
    expect(html).toContain("Only a single statement can be approved.");
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

  it("wraps cards in a session group header", () => {
    expect(groupHtml(session, [card], "postgresql", denyDrafts)).toBe(
      '\n      <section class="group">\n        <div class="group-head">\n          <span class="harness-badge"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n  <title>Claude Code</title>\n  <path clip-rule="evenodd"\n        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"\n        fill="#D97757"\n        fill-rule="evenodd" />\n</svg></span>\n          <span class="group-label">gatekeeper</span>\n          <span class="group-intent" title="Audit review">Audit review</span>\n          <span class="group-count count-badge">1</span>\n        </div>\n        \n      <div class="card " data-card="q_ab12">\n        <div class="top">\n          <span class="intent">Check a user\'s email</span>\n          <span class="lease">1:30</span>\n        </div>\n        <div class="meta">q_ab12 &middot; 12s ago</div>\n        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="SELECT email, company_name FROM audit.users WHERE email = \'jane@acme.io\'" aria-label="Copy SQL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button><code class="sql-body" id="sqlbody-q_ab12"><span class="kw">SELECT</span>\n  <span class="pii-col">email</span>,\n  <span class="client-col">company_name</span>\n<span class="kw">FROM</span> audit.users\n<span class="kw">WHERE</span> <span class="pii-col">email</span> = <span class="st sensitive-val">\'jane@acme.io\'</span></code></pre>\n        <div class="card-schema" id="cs-q_ab12"><div class="cs-reads"><span class="cs-reads-k"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/></svg>Reads</span><span class="tbl-chip">audit.users</span></div><div class="cs-line cs-pii"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>possible PII</span><span class="cs-list">email</span></div><div class="cs-line cs-client"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>client data</span><span class="cs-list">company_name</span></div><div class="cs-line cs-literal"><span class="cs-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>sensitive value</span><span class="cs-list">\'jane@acme.io\'</span></div></div>\n        <div class="actions">\n             <button class="btn approve" type="button" data-approve="q_ab12" >Approve</button>\n             <button class="btn reject" type="button" data-reject="q_ab12">Reject</button>\n             <div class="deny-field">\n             <input class="deny-reason" type="text" maxlength="140" data-deny-input="q_ab12" aria-label="What should the agent change?" placeholder="What should the agent change?" autocomplete="off" spellcheck="false" value="use a bind param" />\n             <button class="deny-send" type="button" data-deny="q_ab12" aria-label="Send to the agent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>\n           </div>\n           </div>\n      </div>\n      </section>',
    );
  });
});
