import type { ConnectionInfo } from "@beekeeperstudio/plugin";
import type { ActivityEntry, Proposal, SessionMeta, SessionRoster } from "@gatekeeper/shared";
import { capResult } from "../src/result";
import type { HistItem } from "../src/types";

// Synthetic data for the preview only: invented projects, tables and addresses on
// example.com, so nothing here can be mistaken for a real database or a real person.

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const raw = params.get(key);
  return raw === null || Number.isNaN(Number(raw)) ? fallback : Number(raw);
};

export const scenario = {
  agents: num("agents", 2),
  queue: num("queue", 3),
  history: num("history", 11),
  // Activity entries per page; a large one shows past months without scrolling to load them.
  page: num("page", 40),
  // How long an approved query runs, to see the running row, Stop and the auto-stop.
  delay: num("delay", 400),
  // 0 empties the Audit Trail, to see its empty state; history=0 alone keeps the older days.
  audit: num("audit", 1),
};

export const NOW = Date.now();
const MIN = 60_000;
const DAY = 86_400_000;

// Any engine but PostgreSQL and MySQL (sqlite, sqlserver...) opens the "not officially tested"
// notice.
const engine = (params.get("engine") ?? "postgresql") as ConnectionInfo["databaseType"];

export const CONNECTION = {
  connectionType: engine,
  id: 7,
  workspaceId: 0,
  connectionName: "gatekeeper_test",
  databaseType: engine,
  databaseName: "gatekeeper_test",
  defaultSchema: "public",
  readOnlyMode: false,
};

const HARNESSES = ["claude-code", "codex", "opencode"];
const PROJECTS = [
  "billing-api",
  "analytics",
  "web-app",
  "etl-jobs",
  "search-indexer",
  "payments",
  "notifications",
  "admin-panel",
  "mobile-api",
  "reporting",
  "crm-sync",
  "auth-service",
  "catalog",
  "inventory",
  "pricing",
  "ml-features",
  "docs-site",
  "data-quality",
  "infra-scripts",
  "support-tools",
];
const TASKS = [
  "Investigate duplicate invoices",
  "Weekly retention report",
  "Fix the slow product search",
  "Backfill the October exports",
  "Audit unused indexes",
  "Reconcile refunds with the payment provider",
  "Clean up stale sessions",
  "Draft the churn dashboard",
];

export function session(i: number): SessionMeta {
  return {
    sessionId: `sess_${(0x8f2c1d07 + i * 7919).toString(16)}`,
    harness: HARNESSES[i % HARNESSES.length],
    harnessVersion: null,
    project: PROJECTS[i % PROJECTS.length],
    sessionLabel: TASKS[i % TASKS.length],
  };
}

export function roster(): SessionRoster[] {
  return Array.from({ length: scenario.agents }, (_, i) => {
    const s = session(i);
    const active = i % 3 === 0;
    return {
      ...s,
      createdAt: Date.now() - 3 * 60 * MIN,
      lastSeen: Date.now() - 5_000,
      lastActive: active ? Date.now() - 10_000 : NOW - (4 + i * 3) * MIN,
      connection: CONNECTION.connectionName,
      leftAt: null,
      pendingCount: 0,
      lastIntent: null,
    };
  });
}

export const SQL = {
  plans: `SELECT p.name AS plan, SUM(i.amount_eur) AS revenue_eur
FROM invoices i
JOIN subscriptions s ON s.id = i.subscription_id
JOIN plans p ON p.id = s.plan_id
WHERE i.issued_at >= '2026-07-01' AND i.issued_at < '2026-10-01'
GROUP BY p.name
ORDER BY revenue_eur DESC`,
  unpaid: `SELECT i.invoice_number, i.amount_eur, i.issued_at
FROM invoices i
LEFT JOIN payments p ON p.invoice_id = i.id
WHERE p.id IS NULL
ORDER BY i.issued_at DESC
LIMIT 100`,
  voidDup: `UPDATE invoices SET status = 'void' WHERE invoice_number IN ('INV-2610-1040', 'INV-2610-1047')`,
  dup: `SELECT invoice_number, customer_id, customer_email, amount_eur, issued_at, copies
FROM (
  SELECT i.invoice_number, i.customer_id, c.email AS customer_email, i.amount_eur, i.issued_at,
    COUNT(*) OVER (PARTITION BY i.invoice_number) AS copies
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  WHERE i.issued_at >= '2026-10-01'
) d
WHERE copies > 1
ORDER BY invoice_number, issued_at`,
  active: `SELECT date_trunc('week', o.created_at) AS week, COUNT(DISTINCT o.customer_id) AS active_customers
FROM orders o
WHERE o.created_at >= '2026-08-01'
GROUP BY week
ORDER BY week`,
  join: `SELECT i.invoice_number, p.amount_eur, p.paid_at
FROM invoices i
JOIN payments p ON p.order_ref = i.order_id`,
  cohort: `SELECT date_trunc('month', created_at) AS cohort, COUNT(*) AS customers
FROM customers
WHERE created_at >= '2026-08-01'
GROUP BY cohort`,
  status: `SELECT status, COUNT(*) AS invoices FROM invoices GROUP BY status`,
};

export const COLUMNS: Record<string, { name: string; type: string }[]> = {
  invoices: [
    { name: "id", type: "integer" },
    { name: "invoice_number", type: "text" },
    { name: "customer_id", type: "integer" },
    { name: "subscription_id", type: "integer" },
    { name: "order_id", type: "integer" },
    { name: "amount_eur", type: "numeric" },
    { name: "status", type: "text" },
    { name: "issued_at", type: "timestamptz" },
  ],
  customers: [
    { name: "id", type: "integer" },
    { name: "email", type: "text" },
    { name: "name", type: "text" },
    { name: "created_at", type: "timestamptz" },
  ],
  payments: [
    { name: "id", type: "integer" },
    { name: "invoice_id", type: "integer" },
    { name: "amount_eur", type: "numeric" },
    { name: "paid_at", type: "timestamptz" },
  ],
  subscriptions: [
    { name: "id", type: "integer" },
    { name: "plan_id", type: "integer" },
  ],
  plans: [
    { name: "id", type: "integer" },
    { name: "name", type: "text" },
  ],
  orders: [
    { name: "id", type: "integer" },
    { name: "customer_id", type: "integer" },
    { name: "created_at", type: "timestamptz" },
  ],
};

// 18 duplicated invoice numbers and one triplicate: 37 rows, wide enough to exercise the grid.
export function duplicateRows(): Record<string, unknown>[] {
  const names = [
    "a.moreau",
    "l.bernard",
    "c.petit",
    "m.durand",
    "s.leroy",
    "j.roux",
    "e.fontaine",
    "n.garnier",
    "p.chevalier",
    "h.lambert",
    "r.faure",
    "t.mercier",
    "v.blanc",
    "g.guerin",
    "b.muller",
    "o.henry",
    "k.perrin",
    "d.morel",
    "f.girard",
  ];
  const rows: Record<string, unknown>[] = [];
  names.forEach((n, i) => {
    const copies = i === 7 ? 3 : 2;
    for (let k = 0; k < copies; k++) {
      rows.push({
        invoice_number: `INV-2610-${String(1040 + i * 7).padStart(4, "0")}`,
        customer_id: 10220 + i * 31,
        customer_email: `${n}@example.com`,
        amount_eur: Number((180 + ((i * 137) % 1900)).toFixed(2)),
        issued_at: `2026-10-${String(1 + ((i * 3) % 14)).padStart(2, "0")}T${String(8 + ((i + k) % 9)).padStart(2, "0")}:14:22Z`,
        copies,
      });
    }
  });
  return rows;
}

export function weekRows(): Record<string, unknown>[] {
  return Array.from({ length: 11 }, (_, w) => ({
    week: new Date(Date.UTC(2026, 7, 3 + w * 7)).toISOString().slice(0, 10),
    active_customers: 1180 + ((w * 97) % 260),
  }));
}

// Pending proposals the fake broker hands out one per poll: two reads and a write, which
// stays blocked until Write mode is armed.
export function proposals(): Proposal[] {
  const list: Omit<Proposal, "leaseId" | "leaseExpiresAt">[] = [
    {
      id: "req_d05e7a1b3c96",
      sql: SQL.plans,
      intent: "revenue per plan last quarter",
      createdAt: NOW - 25_000,
      expiresAt: NOW + 4.5 * MIN,
      sessionId: session(1).sessionId,
      session: session(1),
    },
    {
      id: "req_a3c1e0f2e917",
      sql: SQL.unpaid,
      intent: "list invoices that have no payment yet",
      createdAt: NOW - 12_000,
      expiresAt: NOW + 4.7 * MIN,
      sessionId: session(0).sessionId,
      session: session(0),
    },
    {
      id: "req_b84f21c07d55",
      sql: SQL.voidDup,
      intent: "mark the two duplicate invoices as void",
      createdAt: NOW - 6_000,
      expiresAt: NOW + 4.9 * MIN,
      sessionId: session(0).sessionId,
      session: session(0),
    },
  ];
  return list
    .slice(0, scenario.queue)
    .map((p) => ({ ...p, leaseId: `lease_${p.id}`, leaseExpiresAt: NOW + 30_000 }));
}

const fieldsOf = (rows: Record<string, unknown>[]) =>
  Object.keys(rows[0] ?? {}).map((name) => ({ name }));

// Recently resolved only ever fills from decisions taken in this tab, so the preview seeds it.
// The same requests open the Audit Trail, so an entry still held here shows its rows there.
export function seededHistory(): HistItem[] {
  const base = { connection: CONNECTION.connectionName };
  const dup = duplicateRows();
  const weeks = weekRows();
  const items: HistItem[] = [
    {
      ...base,
      id: "req_4e1a9c07b2d3",
      status: "approved",
      note: `${dup.length} rows returned`,
      sql: SQL.dup,
      resolvedAt: NOW - 1.5 * MIN,
      session: session(0),
      intent: "find duplicate invoice numbers this month",
      result: capResult(dup, fieldsOf(dup)),
      sensitivity: { pii: true, value: false, client: false },
    },
    {
      ...base,
      id: "req_9d4b2e6a0c18",
      status: "approved",
      note: "2 rows changed",
      sql: SQL.voidDup,
      resolvedAt: NOW - 3 * MIN,
      session: session(0),
      intent: "mark the two duplicate invoices as void",
      result: { fields: [], rows: [], rowCount: 0, affectedRows: 2, truncated: false },
    },
    {
      // More rows than one page holds, and more than the agent was sent.
      ...base,
      id: "req_2c8a6e1f9b04",
      status: "approved",
      note: "12,400 rows returned (agent received 10000)",
      sql: SQL.cohort,
      resolvedAt: NOW - 3.5 * MIN,
      session: session(1),
      intent: "events since October 1",
      result: {
        ...capResult(eventRows(), [{ name: "id" }, { name: "kind" }, { name: "created_at" }]),
        rowCount: 12_400,
      },
      approval: { source: "human" },
    },
    {
      ...base,
      id: "req_6f3d0a9c2e71",
      status: "failed",
      note: "result not delivered",
      outcome: "result not delivered",
      sql: SQL.status,
      resolvedAt: NOW - 4 * MIN,
      session: session(1),
      intent: "list the invoice statuses in use",
    },
    {
      ...base,
      id: "req_91f0d2a6c4e8",
      status: "approved",
      note: "11 rows returned",
      sql: SQL.active,
      resolvedAt: NOW - 5 * MIN,
      session: session(1),
      intent: "active customers per week since August",
      result: capResult(weeks, fieldsOf(weeks)),
      approval: { source: "automatic" },
    },
    {
      ...base,
      id: "req_0b7d3e5f1a29",
      status: "rejected",
      note: "declined",
      sql: SQL.voidDup,
      resolvedAt: NOW - 8 * MIN,
      session: session(0),
      intent: "void the duplicate invoices",
    },
    {
      ...base,
      id: "req_c3a8e6f40d17",
      status: "failed",
      note: "column p.order_ref does not exist",
      sql: SQL.join,
      resolvedAt: NOW - 10 * MIN,
      session: session(0),
      intent: "join invoices to payments",
    },
    {
      ...base,
      id: "req_7d2b9f1e8c05",
      status: "approved",
      note: "3 rows returned",
      sql: SQL.cohort,
      resolvedAt: NOW - 24 * MIN,
      session: session(1),
      intent: "cohort sizes since August",
      result: { fields: [], rows: [], rowCount: 3, truncated: true, bytes: 0 },
    },
    {
      ...base,
      id: "req_e85f0a3b6d92",
      status: "expired",
      note: "expired",
      sql: SQL.status,
      resolvedAt: NOW - 31 * MIN,
      session: session(1),
      intent: "churned customers with their last order",
    },
    {
      ...base,
      id: "req_5a6c1f9e3b40",
      status: "approved",
      note: "4 rows returned",
      sql: SQL.status,
      resolvedAt: NOW - 43 * MIN,
      session: session(0),
      intent: "check the invoices.status values",
      result: { fields: [], rows: [], rowCount: 4, truncated: true, bytes: 0 },
    },
    {
      ...base,
      id: "req_2f9e7c4a1d63",
      status: "approved",
      note: "0 rows returned",
      sql: SQL.status,
      resolvedAt: NOW - 51 * MIN,
      session: session(0),
      intent: "count the archived invoices",
      result: { fields: [], rows: [], rowCount: 0, truncated: false },
    },
  ];
  return items.slice(0, scenario.history);
}

// Decided requests the Audit Trail pages through, newest first: today's seeded results, a
// write whose returned count was never recorded, one with no count at all, then three weeks of
// older days, enough for several preview pages.
export function activity(): ActivityEntry[] {
  if (!scenario.audit) return [];
  const STATE: Record<HistItem["status"], ActivityEntry["state"]> = {
    approved: "approved",
    rejected: "rejected",
    failed: "failed",
    expired: "expired",
  };
  const out: ActivityEntry[] = seededHistory().map((h) => ({
    id: h.id,
    createdAt: h.resolvedAt - 40_000,
    decidedAt: h.resolvedAt,
    sessionId: h.session?.sessionId ?? "",
    harness: h.session?.harness ?? null,
    project: h.session?.project ?? null,
    sessionLabel: h.session?.sessionLabel ?? null,
    sql: h.sql,
    intent: h.intent ?? null,
    state: STATE[h.status],
    reason: null,
    error: h.status === "failed" ? h.note : null,
    rowCount: h.result?.rowCount ?? null,
    affectedRows: null,
    approval: h.approval,
  }));
  const s0 = session(0);
  const extra = (id: string, at: number, patch: Partial<ActivityEntry>): ActivityEntry => ({
    id,
    createdAt: at - 30_000,
    decidedAt: at,
    sessionId: s0.sessionId,
    harness: s0.harness,
    project: s0.project,
    sessionLabel: s0.sessionLabel,
    sql: SQL.voidDup,
    intent: "mark yesterday's test invoices as void",
    state: "approved",
    reason: null,
    error: null,
    rowCount: null,
    affectedRows: null,
    ...patch,
  });
  out.push(
    extra("req_9a71c0d4e2b8", NOW - 70 * MIN, { affectedRows: 2 }),
    extra("req_3c5e8f1a7b20", NOW - 95 * MIN, {
      sql: SQL.status,
      intent: "status counts from before the counts were recorded",
    }),
  );
  const pool: [ActivityEntry["state"], string, string, number | null][] = [
    ["approved", "find duplicate invoice numbers", SQL.dup, 37],
    ["approved", "active customers per week", SQL.active, 11],
    ["rejected", "void the duplicate invoices", SQL.voidDup, null],
    ["failed", "join invoices to payments", SQL.join, null],
    ["approved", "cohort sizes since August", SQL.cohort, 3],
    ["expired", "churned customers with their last order", SQL.status, null],
    ["cancelled", "list every invoice", SQL.status, null],
    ["approved", "check the invoices.status values", SQL.status, 4],
  ];
  for (let day = 1; day < 22; day++) {
    const n = 3 + ((day * 5) % 5);
    for (let k = 0; k < n; k++) {
      const [state, intent, sql, rowCount] = pool[(day * 3 + k) % pool.length];
      const s = session((day + k) % Math.max(2, scenario.agents));
      const decidedAt = NOW - day * DAY - (k + 1) * 9 * MIN;
      out.push({
        id: `req_${(0x51a0c0 + day * 97 + k * 13).toString(16)}9e2f`,
        createdAt: decidedAt - 40_000,
        decidedAt,
        sessionId: s.sessionId,
        harness: s.harness,
        project: s.project,
        sessionLabel: s.sessionLabel,
        sql,
        intent,
        state,
        reason: null,
        error: state === "failed" ? "column p.order_ref does not exist" : null,
        rowCount,
        affectedRows: null,
      });
    }
  }
  return out;
}

// A result past one page of the grid, so its pager and position show in the result bar.
export function eventRows(): Record<string, unknown>[] {
  return Array.from({ length: 2000 }, (_, i) => ({
    id: 9_000_000 + i,
    kind: ["view", "click", "signup"][i % 3],
    created_at: new Date(Date.UTC(2026, 9, 1 + (i % 19), 10 + (i % 9))).toISOString().slice(0, 19),
  }));
}
