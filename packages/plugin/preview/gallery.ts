// The same stylesheets, in the same order, as src/main.ts: Tabulator's base theme first.
import "tabulator-tables/dist/css/tabulator_midnight.min.css";
import "../src/style.css";
import type { ActivityEntry, AutoEvaluation, SessionMeta } from "@gatekeeper/shared";
import { capitalize, escapeHtml } from "../src/html";
import { agentBadge } from "../src/icons";
import { activityEntryHtml } from "../src/render/activity";
import { CANCELLED_NOTE, detailHtml } from "../src/render/detail";
import { mountResultGrid } from "../src/render/grid";
import { recentRowHtml } from "../src/render/inbox";
import { AUTO_EVALUATING, cardHtml } from "../src/render/queue";
import { capResult, type HistResult } from "../src/result";
import { AUTO_POLICY, AUTO_THRESHOLDS } from "../src/sql/auto";
import { classifyQuery } from "../src/sql/classify";
import type { RiskMode } from "../src/sql/mode";
import type { SchemaContext } from "../src/sql/schema";
import type { Card, HistItem } from "../src/types";
import { CONNECTION, duplicateRows, NOW, SQL, session, weekRows } from "./fixtures";

// Every state a row, a pending card and a decided detail can take, drawn by the plugin's
// own renderers, so a redesign is judged against all of them at once.

const MIN = 60_000;
const DIALECT = "postgresql";

const SQL_MORE = {
  purge: `DELETE FROM sessions WHERE last_seen < now() - interval '90 days'`,
  contact: `SELECT c.email, c.company_name FROM customers c WHERE c.email = 'jane@example.com'`,
  two: "SELECT count(*) FROM invoices; SELECT count(*) FROM payments",
  vacuum: "VACUUM FULL invoices",
  big: "SELECT * FROM events WHERE created_at >= '2026-10-01'",
};

const fieldsOf = (rows: Record<string, unknown>[]) =>
  Object.keys(rows[0] ?? {}).map((name) => ({ name }));

function evaluation(eligible: boolean, reasons: string[] = []): AutoEvaluation {
  const probabilities = Object.fromEntries(
    Object.keys(AUTO_THRESHOLDS).map((id, i) => [id, eligible ? 0.02 + i * 0.01 : 0.71 - i * 0.2]),
  );
  return {
    provider: "typesafe",
    model: "jev-1.13.0",
    policy: AUTO_POLICY,
    evaluatedAt: NOW - 5 * MIN,
    sqlDigest: "sha256:4b1d…e07a",
    eligible,
    reasons,
    probabilities,
  };
}

const DEFAULT_INTENT = "find duplicate invoice numbers this month";

const noProject: SessionMeta = { ...session(2), project: null };

interface DoneState {
  label: string;
  hist: HistItem;
  entry: ActivityEntry;
}

// One decided request seen from both lists: the local item (Recently resolved) and the
// server's record of it (Audit Trail).
function done(
  label: string,
  sql: string,
  hist: Partial<HistItem>,
  entry: Partial<ActivityEntry>,
  who: SessionMeta = session(0),
  at = NOW - 3 * MIN,
): DoneState {
  const id = `req_${(label.length * 7919 + at).toString(16).slice(-12)}`;
  return {
    label,
    hist: {
      id,
      status: "approved",
      note: "",
      sql,
      resolvedAt: at,
      connection: CONNECTION.connectionName,
      session: who,
      intent: DEFAULT_INTENT,
      ...hist,
    },
    entry: {
      id,
      createdAt: at - 20_000,
      decidedAt: at,
      sessionId: who.sessionId,
      harness: who.harness,
      project: who.project,
      sessionLabel: who.sessionLabel,
      sql,
      intent: "intent" in hist ? (hist.intent ?? null) : DEFAULT_INTENT,
      state: "approved",
      reason: null,
      error: null,
      rowCount: null,
      affectedRows: null,
      ...entry,
    },
  };
}

const dup = duplicateRows();
const weeks = weekRows();
const dupResult = capResult(dup, fieldsOf(dup));
const bigRows = Array.from({ length: 60 }, (_, i) => ({
  id: 9_000_000 + i,
  kind: ["view", "click", "signup"][i % 3],
  created_at: `2026-10-0${1 + (i % 9)} 1${i % 10}:0${i % 6}:00`,
}));
const bigResult: HistResult = {
  ...capResult(bigRows, fieldsOf(bigRows)),
  rowCount: 12_400,
  truncated: true,
};

const DONE: DoneState[] = [
  done(
    "Read · approved by you · rows returned",
    SQL.dup,
    { note: "39 rows returned", result: dupResult },
    { rowCount: 39 },
  ),
  done(
    "Read · approved automatically",
    SQL.active,
    {
      note: "11 rows returned",
      intent: "active customers per week since August",
      result: capResult(weeks, fieldsOf(weeks)),
      approval: { source: "automatic", evaluation: evaluation(true) },
    },
    {
      rowCount: 11,
      intent: "active customers per week since August",
      approval: { source: "automatic", evaluation: evaluation(true) },
    },
    session(1),
  ),
  done(
    "Read · approved after Auto mode held it",
    SQL.dup,
    {
      note: "39 rows returned",
      result: dupResult,
      approval: { source: "human" },
      autoHold: { sent: false, reason: "Reads a column flagged as PII." },
    },
    {
      rowCount: 39,
      approval: { source: "human" },
      autoHold: { sent: false, reason: "Reads a column flagged as PII." },
    },
  ),
  done(
    "Read · approved · no rows",
    SQL.status,
    {
      note: "0 rows returned",
      intent: "check the invoices.status values",
      result: {
        fields: [{ name: "status" }, { name: "invoices" }],
        rows: [],
        rowCount: 0,
        truncated: false,
      },
    },
    { rowCount: 0, intent: "check the invoices.status values" },
  ),
  done(
    "Read · approved · more rows than the agent got",
    SQL_MORE.big,
    {
      note: "12,400 rows returned (agent received 10,000)",
      intent: "events since October 1",
      result: bigResult,
    },
    { rowCount: 12_400, intent: "events since October 1" },
  ),
  done(
    "Read · approved · rows no longer held",
    SQL.dup,
    { note: "39 rows returned", result: { ...dupResult, rows: [], truncated: true, bytes: 0 } },
    { rowCount: 39 },
  ),
  done("Read · approved · no count recorded", SQL.status, { note: "" }, {}),
  done(
    "Write · approved · rows changed",
    SQL.voidDup,
    {
      note: "2 rows changed · 0 rows returned",
      intent: "mark the two duplicate invoices as void",
      result: { fields: [], rows: [], rowCount: 0, affectedRows: 2, truncated: false },
    },
    { rowCount: 0, affectedRows: 2, intent: "mark the two duplicate invoices as void" },
  ),
  done(
    "Write · approved · nothing changed",
    SQL.voidDup,
    {
      note: "0 rows changed · 0 rows returned",
      intent: "mark the two duplicate invoices as void",
      result: { fields: [], rows: [], rowCount: 0, affectedRows: 0, truncated: false },
    },
    { rowCount: 0, affectedRows: 0, intent: "mark the two duplicate invoices as void" },
  ),
  done(
    "Destructive · approved",
    SQL_MORE.purge,
    {
      note: "1,204 rows changed · 0 rows returned",
      intent: "purge sessions idle for 90 days",
      result: { fields: [], rows: [], rowCount: 0, affectedRows: 1204, truncated: false },
    },
    { rowCount: 0, affectedRows: 1204, intent: "purge sessions idle for 90 days" },
  ),
  done(
    "Read · declined",
    SQL.plans,
    { status: "rejected", note: "declined", intent: "revenue per plan last quarter" },
    { state: "rejected", intent: "revenue per plan last quarter" },
    session(1),
  ),
  done(
    "Write · declined with a reason",
    SQL.voidDup,
    {
      status: "rejected",
      note: "Only void the newer copy of each pair",
      intent: "void the duplicate invoices",
    },
    {
      state: "rejected",
      reason: "Only void the newer copy of each pair",
      intent: "void the duplicate invoices",
    },
  ),
  done(
    "Destructive · declined with a long reason",
    SQL_MORE.purge,
    {
      status: "rejected",
      note: "Not on production during the billing run. Ask again after 18:00 and scope it to sessions of deleted accounts only.",
      intent: "purge sessions idle for 90 days",
    },
    {
      state: "rejected",
      reason:
        "Not on production during the billing run. Ask again after 18:00 and scope it to sessions of deleted accounts only.",
      intent: "purge sessions idle for 90 days",
    },
  ),
  done(
    "Read · failed · database error",
    SQL.join,
    {
      status: "failed",
      note: "column p.order_ref does not exist",
      intent: "join invoices to payments",
    },
    {
      state: "failed",
      error: "column p.order_ref does not exist",
      intent: "join invoices to payments",
    },
  ),
  done(
    "Read · failed · stopped",
    SQL_MORE.big,
    {
      status: "failed",
      note: "Stop requested by the operator after 42s. The query then ended with: canceling statement due to user request",
      intent: "events since October 1",
    },
    {
      state: "failed",
      error:
        "Stop requested by the operator after 42s. The query then ended with: canceling statement due to user request",
      intent: "events since October 1",
    },
  ),
  done(
    "Read · failed · result not delivered (local)",
    SQL.unpaid,
    {
      status: "failed",
      note: "result not delivered",
      intent: "list invoices that have no payment yet",
    },
    { state: "failed", intent: "list invoices that have no payment yet" },
  ),
  done(
    "Read · expired",
    SQL.plans,
    { status: "expired", note: "expired", intent: "revenue per plan last quarter" },
    { state: "expired", intent: "revenue per plan last quarter" },
    session(1),
  ),
  done(
    "Read · cancelled by the agent",
    SQL.unpaid,
    { status: "expired", note: CANCELLED_NOTE, intent: "list invoices that have no payment yet" },
    { state: "cancelled", intent: "list invoices that have no payment yet" },
  ),
  done(
    "Read · no intent (titled by its SQL)",
    SQL.status,
    { note: "4 rows returned", intent: undefined },
    { rowCount: 4, intent: null },
  ),
  done(
    "Read · agent without a project (tool name)",
    SQL.status,
    { note: "4 rows returned", intent: "count invoices by status" },
    { rowCount: 4, intent: "count invoices by status" },
    noProject,
  ),
];

const schemaDup: SchemaContext = {
  tables: ["invoices", "customers"],
  pii: ["customer_email"],
  client: [],
  literals: [],
  star: false,
};

function card(over: Partial<Card>): Card {
  const s = over.session ?? session(0);
  return {
    id: "req_b84f21c07d55",
    sql: SQL.unpaid,
    intent: "list invoices that have no payment yet",
    createdAt: NOW - 40_000,
    expiresAt: Date.now() + 4.4 * MIN,
    leaseId: "lease",
    leaseExpiresAt: Date.now() + 30_000,
    sessionId: s.sessionId,
    session: s,
    state: "ready",
    schema: { tables: ["invoices", "payments"], pii: [], client: [], literals: [], star: false },
    ...over,
  };
}

interface CardState {
  label: string;
  card: Card;
  mode?: RiskMode;
  connReadOnly?: boolean;
  draft?: string;
}

const run = (startedAgo: number, extra: Partial<NonNullable<Card["run"]>> = {}) => ({
  startedAt: Date.now() - startedAgo,
  limitMs: 5 * MIN,
  engine: "postgresql" as const,
  tag: "gk",
  ended: false,
  ...extra,
});

const CARDS: CardState[] = [
  { label: "Read · ready", card: card({}) },
  {
    label: "Read · possible PII",
    card: card({
      sql: SQL.dup,
      intent: "find duplicate invoice numbers this month",
      schema: schemaDup,
    }),
  },
  {
    label: "Read · client data and a sensitive value",
    card: card({
      sql: SQL_MORE.contact,
      intent: "look up one customer's contact",
      schema: {
        tables: ["customers"],
        pii: ["email"],
        client: ["company_name"],
        literals: ["jane@example.com"],
        star: false,
      },
    }),
  },
  { label: "Read · lease running low", card: card({ expiresAt: Date.now() + 28_000 }) },
  {
    label: "Write · Read-only mode (blocked)",
    card: card({
      sql: SQL.voidDup,
      intent: "mark the two duplicate invoices as void",
      schema: null,
    }),
  },
  {
    label: "Write · Write mode",
    card: card({
      sql: SQL.voidDup,
      intent: "mark the two duplicate invoices as void",
      schema: null,
    }),
    mode: "write",
  },
  {
    label: "Write · read-only connection (blocked)",
    card: card({
      sql: SQL.voidDup,
      intent: "mark the two duplicate invoices as void",
      schema: null,
    }),
    mode: "write",
    connReadOnly: true,
  },
  {
    label: "Destructive · Write mode (blocked)",
    card: card({ sql: SQL_MORE.purge, intent: "purge sessions idle for 90 days", schema: null }),
    mode: "write",
  },
  {
    label: "Destructive · Destructive mode",
    card: card({ sql: SQL_MORE.purge, intent: "purge sessions idle for 90 days", schema: null }),
    mode: "destructive",
  },
  {
    label: "Destructive · not parsed",
    card: card({ sql: SQL_MORE.vacuum, intent: "reclaim space on invoices", schema: null }),
    mode: "destructive",
  },
  {
    label: "Several statements (blocked)",
    card: card({ sql: SQL_MORE.two, intent: "count invoices and payments", schema: null }),
  },
  { label: "Auto mode · evaluating", card: card({ autoStatus: AUTO_EVALUATING }) },
  {
    label: "Auto mode · needs review (Jev refused)",
    card: card({
      sql: SQL.dup,
      intent: "find duplicate invoice numbers this month",
      schema: schemaDup,
      autoStatus: "Needs review: Reads a column flagged as PII.",
      autoSent: true,
      evaluation: evaluation(false, ["Reads a column flagged as PII"]),
    }),
  },
  {
    label: "Auto mode · held locally (nothing sent)",
    card: card({
      sql: SQL.dup,
      intent: "find duplicate invoice numbers this month",
      schema: schemaDup,
      autoStatus: "Needs review: Reads customer_email.",
    }),
  },
  {
    label: "Request changes · open with a draft",
    card: card({}),
    draft: "Limit it to invoices issued this month",
  },
  { label: "Approving", card: card({ state: "approving" }) },
  { label: "Running · with auto-stop", card: card({ state: "executing", run: run(12_000) }) },
  { label: "Running · long", card: card({ state: "executing", run: run(75_000, { limitMs: 0 }) }) },
  {
    label: "Running · Stop unavailable",
    card: card({
      state: "executing",
      run: run(9_000, {
        limitMs: 0,
        engine: undefined,
        tag: undefined,
        unavailable: "This feature is not available on read-only MySQL connections.",
      }),
    }),
  },
  {
    label: "Running · Stop failed",
    card: card({
      state: "executing",
      run: run(31_000, {
        limitMs: 0,
        stop: {
          by: "operator",
          atMs: 28_000,
          state: "idle",
          inFlight: false,
          attempts: 1,
          error: "permission denied to cancel query",
        },
      }),
    }),
  },
  { label: "Returning rows", card: card({ state: "posting" }) },
];

// The same who-line the app puts over the open card (app.ts renderSelectedCard).
function whoLine(s: SessionMeta | null): string {
  const who = s?.project?.trim() || s?.harness?.trim() || "agent";
  const task = s?.sessionLabel?.trim();
  return `<div class="pd-who">${agentBadge(s?.harness?.trim() || null)}<span class="pd-name">${escapeHtml(who)}</span>${task ? `<span class="pd-task">${escapeHtml(capitalize(task))}</span>` : ""}</div>`;
}

const label = (text: string) => `<div class="g-label">${escapeHtml(text)}</div>`;

function rowsSection(): string {
  const lines = DONE.map(
    (s, i) => `<div class="g-row">${label(s.label)}
      <section class="pane pane-list g-pane"><div class="pane-body">${recentRowHtml(s.hist, i === 0, classifyQuery(s.hist.sql, DIALECT).class)}</div></section>
      <section class="pane pane-list g-pane"><div class="pane-body">${activityEntryHtml(s.entry, i === 0, DIALECT)}</div></section>
    </div>`,
  ).join("");
  return `<h2 id="rows">Rows</h2><p class="g-note">Left, Recently resolved (this tab's decisions). Right, the Audit Trail (the server's record). The first row is selected.</p>
    <div class="g-row g-head"><span></span><span>Recently resolved</span><span>Audit Trail</span></div>${lines}`;
}

function cardsSection(): string {
  return `<h2 id="pending">Pending approval detail</h2>${CARDS.map((c) => {
    const drafts = new Map<string, string>(c.draft ? [[c.card.id, c.draft]] : []);
    return `<div class="g-detail">${label(c.label + (c.mode ? ` (mode: ${c.mode})` : ""))}
      <section class="pane pane-detail g-pane-detail"><div class="pane-body"><div class="queue">${whoLine(c.card.session)}${cardHtml(c.card, DIALECT, drafts, c.mode ?? "read", c.connReadOnly ?? false)}</div></div></section>
    </div>`;
  }).join("")}`;
}

function detailsSection(): string {
  return `<h2 id="decided">Decided detail</h2>${DETAILS.map(
    (s, i) => `<div class="g-detail">${label(s.label)}
      <section class="pane pane-detail g-pane-detail"><div class="pane-body"><div class="detail-host" data-i="${i}">${detailHtml(s.item)}</div></div></section>
    </div>`,
  ).join("")}`;
}

// Recently resolved items, then two Audit Trail mappings: the server keeps counts, and rows
// show only while this tab still holds them.
const DETAILS: { label: string; item: HistItem }[] = [
  ...DONE.filter(
    (s) => !s.label.includes("no intent") && !s.label.includes("without a project"),
  ).map((s) => ({ label: s.label, item: s.hist })),
  {
    label: "Audit Trail · approved read, rows not held by this tab",
    item: { ...DONE[0].hist, result: { ...dupResult, rows: [] } },
  },
  {
    label: "Audit Trail · approved write, counts only",
    item: {
      ...DONE[7].hist,
      result: { fields: [], rows: [], rowCount: null, affectedRows: 2, truncated: false },
    },
  },
];

const root = document.querySelector<HTMLDivElement>("#gallery");
if (root) {
  root.innerHTML = `<nav class="g-nav"><a href="#rows">Rows</a><a href="#pending">Pending approval detail</a><a href="#decided">Decided detail</a></nav>
    ${rowsSection()}${cardsSection()}${detailsSection()}`;
  // The detail's grid mounts once its markup is laid out, as the app does.
  for (const host of root.querySelectorAll<HTMLElement>(".detail-host[data-i]")) {
    const item = DETAILS[Number(host.dataset.i)]?.item;
    const grid = host.querySelector<HTMLElement>(".gk-grid");
    if (grid && item?.result?.rows.length) mountResultGrid(grid, item.result, 320);
  }
}
