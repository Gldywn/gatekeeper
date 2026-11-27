import type {
  ActivityEntry,
  AutoEvaluation,
  Proposal,
  SessionMeta,
  SessionRoster,
} from "@gatekeeper/shared";
import { capResult, type HistResult } from "../../../packages/plugin/src/result";
import { AUTO_MODEL, AUTO_POLICY, AUTO_THRESHOLDS } from "../../../packages/plugin/src/sql/auto";
import type { HistItem } from "../../../packages/plugin/src/types";

// The landing's plugin replay: an invented shop on a test database, three agents, two
// requests already waiting, a few decisions already taken, then reads arriving now and then.
// Every name is made up; addresses use example.com.

const MIN = 60_000;

export const CONNECTION = {
  connectionType: "postgresql",
  id: 7,
  workspaceId: 0,
  connectionName: "shop-test",
  databaseType: "postgresql",
  databaseName: "shop",
  defaultSchema: "public",
  readOnlyMode: false,
} as const;

const session = (
  harness: string,
  project: string,
  sessionLabel: string,
  n: number,
): SessionMeta => ({
  sessionId: `sess_${(0x8f2c1d07 + n * 7919).toString(16)}`,
  harness,
  harnessVersion: null,
  project,
  sessionLabel,
});
const CC = session("claude-code", "billing-api", "Investigate duplicate invoices", 0);
const CX = session("codex", "analytics", "Weekly sales report", 1);
const OC = session("opencode", "web-app", "Fix the slow product search", 2);

export function roster(): SessionRoster[] {
  return [CC, CX, OC].map((s, i) => ({
    ...s,
    createdAt: Date.now() - (40 + i * 25) * MIN,
    lastSeen: Date.now() - 4_000,
    lastActive: Date.now() - 8_000,
    connection: CONNECTION.connectionName,
    leftAt: null,
    pendingCount: 0,
    lastIntent: null,
  }));
}

// Column types as PostgreSQL names them, for the catalog the local read analysis queries.
export const TABLES: Record<string, Record<string, string>> = {
  orders: {
    id: "int4",
    customer_id: "int4",
    status: "text",
    total_eur: "numeric",
    created_at: "timestamptz",
  },
  order_items: {
    id: "int4",
    order_id: "int4",
    product_id: "int4",
    quantity: "int4",
    amount_eur: "numeric",
    created_at: "timestamptz",
  },
  products: { id: "int4", sku: "text", name: "text", category: "text" },
  search_requests: { id: "int8", duration_ms: "int4", results: "int4", created_at: "timestamptz" },
  refunds: {
    id: "int4",
    order_id: "int4",
    reason: "text",
    amount_eur: "numeric",
    created_at: "timestamptz",
  },
  customers: { id: "int4", email: "text", name: "text", created_at: "timestamptz" },
  signups: { id: "int4", source: "text", created_at: "timestamptz" },
  tickets: {
    id: "int4",
    customer_id: "int4",
    subject: "text",
    status: "text",
    opened_at: "timestamptz",
  },
  invoices: {
    id: "int4",
    invoice_number: "text",
    customer_id: "int4",
    amount_eur: "numeric",
    status: "text",
    issued_at: "timestamptz",
  },
};

const day = (offset: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
};
const weekdaysSoFar = () => (new Date().getUTCDay() + 6) % 7;

export interface Read {
  sql: string;
  intent: string;
  session: SessionMeta;
  rows: () => Record<string, unknown>[];
}

// The reads that arrive and that Auto mode approves: aggregates over plain columns, the kind
// of question an agent asks while building a report.
export const ARRIVALS: Read[] = [
  {
    intent: "orders per day this week",
    session: CX,
    sql: `SELECT date_trunc('day', o.created_at) AS day, count(*) AS orders
FROM public.orders o
WHERE o.created_at >= date_trunc('week', now())
GROUP BY day
ORDER BY day`,
    rows: () =>
      Array.from({ length: weekdaysSoFar() + 1 }, (_, i) => ({
        day: day(weekdaysSoFar() - i),
        orders: 380 + ((i * 47) % 90),
      })),
  },
  {
    intent: "search latency per day this week",
    session: OC,
    sql: `SELECT date_trunc('day', s.created_at) AS day, round(avg(s.duration_ms)) AS avg_ms, max(s.duration_ms) AS slowest_ms
FROM public.search_requests s
WHERE s.created_at >= date_trunc('week', now())
GROUP BY day
ORDER BY day`,
    rows: () =>
      Array.from({ length: weekdaysSoFar() + 1 }, (_, i) => ({
        day: day(weekdaysSoFar() - i),
        avg_ms: 182 + ((i * 29) % 70),
        slowest_ms: 1240 + ((i * 311) % 1100),
      })),
  },
  {
    intent: "top products by revenue this month",
    session: CX,
    sql: `SELECT p.name AS product, sum(oi.amount_eur) AS revenue_eur
FROM public.order_items oi
JOIN public.products p ON p.id = oi.product_id
WHERE oi.created_at >= date_trunc('month', now())
GROUP BY p.name
ORDER BY revenue_eur DESC
LIMIT 10`,
    rows: () =>
      [
        "Linen duvet cover",
        "Oak side table",
        "Wool throw",
        "Ceramic table lamp",
        "Walnut bookshelf",
        "Cotton bath towel set",
        "Rattan pendant light",
        "Stoneware dinner set",
        "Velvet cushion",
        "Jute rug",
      ].map((product, i) => ({ product, revenue_eur: 18_420 - i * 1_385 - ((i * 211) % 400) })),
  },
  {
    intent: "refunds since Monday by reason",
    session: CC,
    sql: `SELECT r.reason, count(*) AS refunds, sum(r.amount_eur) AS total_eur
FROM public.refunds r
WHERE r.created_at >= date_trunc('week', now())
GROUP BY r.reason
ORDER BY total_eur DESC`,
    rows: () => [
      { reason: "damaged in transit", refunds: 14, total_eur: 1_862.4 },
      { reason: "wrong size", refunds: 11, total_eur: 954.9 },
      { reason: "late delivery", refunds: 6, total_eur: 488 },
      { reason: "changed mind", refunds: 4, total_eur: 301.5 },
    ],
  },
  {
    intent: "average basket per day this week",
    session: CX,
    sql: `SELECT date_trunc('day', o.created_at) AS day, round(avg(o.total_eur), 2) AS avg_basket_eur
FROM public.orders o
WHERE o.created_at >= date_trunc('week', now())
GROUP BY day
ORDER BY day`,
    rows: () =>
      Array.from({ length: weekdaysSoFar() + 1 }, (_, i) => ({
        day: day(weekdaysSoFar() - i),
        avg_basket_eur: (642 + ((i * 73) % 190)) / 10,
      })),
  },
  {
    intent: "units sold per category this month",
    session: CX,
    sql: `SELECT p.category, sum(oi.quantity) AS units
FROM public.order_items oi
JOIN public.products p ON p.id = oi.product_id
WHERE oi.created_at >= date_trunc('month', now())
GROUP BY p.category
ORDER BY units DESC`,
    rows: () =>
      ["bedding", "lighting", "furniture", "bath", "tableware", "rugs"].map((category, i) => ({
        category,
        units: 2_140 - i * 297 - ((i * 53) % 120),
      })),
  },
  {
    intent: "slowest searches today",
    session: OC,
    sql: `SELECT s.id, s.duration_ms, s.results, s.created_at
FROM public.search_requests s
WHERE s.created_at >= date_trunc('day', now())
ORDER BY s.duration_ms DESC
LIMIT 10`,
    rows: () =>
      Array.from({ length: 10 }, (_, i) => ({
        id: 8_830_412 + ((i * 7_919) % 40_000),
        duration_ms: 2_310 - i * 143 - ((i * 37) % 60),
        results: (i * 7) % 3 === 0 ? 0 : 12 + ((i * 17) % 80),
        created_at: new Date(Date.now() - (i * 23 + 9) * MIN).toISOString(),
      })),
  },
  {
    intent: "searches with no results per day this week",
    session: OC,
    sql: `SELECT date_trunc('day', s.created_at) AS day, count(*) AS empty_searches
FROM public.search_requests s
WHERE s.results = 0
  AND s.created_at >= date_trunc('week', now())
GROUP BY day
ORDER BY day`,
    rows: () =>
      Array.from({ length: weekdaysSoFar() + 1 }, (_, i) => ({
        day: day(weekdaysSoFar() - i),
        empty_searches: 212 + ((i * 59) % 140),
      })),
  },
  {
    intent: "invoice numbers issued twice this month",
    session: CC,
    sql: `SELECT i.invoice_number, count(*) AS copies
FROM public.invoices i
WHERE i.issued_at >= date_trunc('month', now())
GROUP BY i.invoice_number
HAVING count(*) > 1
ORDER BY i.invoice_number`,
    rows: () => [
      { invoice_number: "INV-2611-1040", copies: 2 },
      { invoice_number: "INV-2611-1047", copies: 2 },
    ],
  },
  {
    intent: "invoices by status this month",
    session: CC,
    sql: `SELECT i.status, count(*) AS invoices, sum(i.amount_eur) AS total_eur
FROM public.invoices i
WHERE i.issued_at >= date_trunc('month', now())
GROUP BY i.status
ORDER BY invoices DESC`,
    rows: () => [
      { status: "paid", invoices: 1_284, total_eur: 241_903.5 },
      { status: "open", invoices: 312, total_eur: 58_440.2 },
      { status: "overdue", invoices: 41, total_eur: 9_872 },
      { status: "void", invoices: 6, total_eur: 1_130.8 },
    ],
  },
];

export const WAITING = {
  voidDup: `UPDATE public.invoices SET status = 'void' WHERE invoice_number IN ('INV-2611-1040', 'INV-2611-1047')`,
  openTickets: `SELECT c.id, c.email, t.subject, t.opened_at
FROM public.tickets t
JOIN public.customers c ON c.id = t.customer_id
WHERE t.status = 'open'
ORDER BY t.opened_at DESC
LIMIT 50`,
};

// What the email read returns if a visitor approves it.
export function ticketRows(): Record<string, unknown>[] {
  const subjects = [
    "Parcel marked delivered but not received",
    "Refund not showing on my card",
    "Wrong size in my order",
    "Cannot change the delivery address",
    "Discount code rejected at checkout",
    "Duplicate charge on my invoice",
  ];
  return subjects.map((subject, i) => ({
    id: 10_412 + i * 37,
    email: `customer${212 + i * 7}@example.com`,
    subject,
    opened_at: new Date(Date.now() - (i + 1) * 47 * MIN).toISOString(),
  }));
}

// How long the server keeps a request nobody decides (PROPOSAL_TTL_MS, packages/server).
const TTL = 15 * MIN;
const freshId = () =>
  `req_${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

// Every request is new to the server, even one an agent asks again.
function request(sql: string, intent: string, session: SessionMeta, createdAt: number): Proposal {
  const id = freshId();
  return {
    id,
    sql,
    intent,
    createdAt,
    expiresAt: createdAt + TTL,
    leaseId: `lease_${id}`,
    leaseExpiresAt: Date.now() + 30_000,
    sessionId: session.sessionId,
    session,
  };
}

// Already waiting when the replay starts, so Auto mode, turned on after them, leaves them
// for a human: a write (Write mode is off) and a read that returns customer emails.
export function waiting(): Proposal[] {
  return [
    request(WAITING.voidDup, "mark the two duplicate invoices as void", CC, Date.now() - 50_000),
    request(
      WAITING.openTickets,
      "customers with an open ticket and their email",
      CX,
      Date.now() - 20_000,
    ),
  ];
}

/** The same request, asked again by its agent once the first one ended. */
export function askedAgain(p: Proposal): Proposal {
  return request(p.sql, p.intent ?? "", p.session ?? CC, Date.now());
}

export function arrival(read: Read): Proposal {
  return request(read.sql, read.intent, read.session, Date.now());
}

const fieldsOf = (rows: Record<string, unknown>[]) =>
  Object.keys(rows[0] ?? {}).map((name) => ({ name }));
const rowsOf = (n: number, make: (i: number) => Record<string, unknown>) =>
  Array.from({ length: n }, (_, i) => make(i));

// The latest decisions. Recently resolved lists them from the server's record, as the Audit
// Trail does, and opens their rows from the server's sealed copy.
export function history(): HistItem[] {
  const base = { connection: CONNECTION.connectionName };
  const weeks = rowsOf(11, (i) => ({
    week: day(77 - i * 7),
    active_customers: 1180 + ((i * 97) % 260),
  }));
  const sources = ["search", "newsletter", "referral", "social", "partner", "direct"].map(
    (source, i) => ({ source, signups: 420 - i * 61 }),
  );
  const dups = rowsOf(39, (i) => ({
    invoice_number: `INV-2611-${1040 + Math.floor(i / 2) * 7}`,
    customer_email: `customer${101 + Math.floor(i / 2)}@example.com`,
    amount_eur: 180 + ((i * 137) % 1900),
  }));
  return [
    {
      ...base,
      id: "req_91f0d2a6c4e8",
      status: "approved",
      note: `${weeks.length} rows returned`,
      sql: "SELECT date_trunc('week', o.created_at) AS week, count(DISTINCT o.customer_id) AS active_customers\nFROM public.orders o\nWHERE o.created_at >= date_trunc('quarter', now())\nGROUP BY week\nORDER BY week",
      resolvedAt: Date.now() - 1.5 * MIN,
      session: CX,
      intent: "active customers per week this quarter",
      result: capResult(weeks, fieldsOf(weeks)),
      approval: { source: "automatic" },
    },
    {
      ...base,
      id: "req_2c8a6e1f9b04",
      status: "approved",
      note: `${sources.length} rows returned`,
      sql: "SELECT u.source, count(*) AS signups\nFROM public.signups u\nWHERE u.created_at >= date_trunc('month', now())\nGROUP BY u.source\nORDER BY signups DESC",
      resolvedAt: Date.now() - 4 * MIN,
      session: OC,
      intent: "signups by source this month",
      result: capResult(sources, fieldsOf(sources)),
      approval: { source: "automatic" },
    },
    {
      ...base,
      id: "req_4e1a9c07b2d3",
      status: "approved",
      note: `${dups.length} rows returned`,
      sql: "SELECT i.invoice_number, c.email AS customer_email, i.amount_eur\nFROM public.invoices i\nJOIN public.customers c ON c.id = i.customer_id\nWHERE i.issued_at >= date_trunc('month', now())\n  AND i.invoice_number IN (SELECT invoice_number FROM public.invoices GROUP BY invoice_number HAVING count(*) > 1)",
      resolvedAt: Date.now() - 7 * MIN,
      session: CC,
      intent: "find duplicate invoice numbers this month",
      result: capResult(dups, fieldsOf(dups)),
      sensitivity: { pii: true, value: false, client: false },
      approval: { source: "human" },
    },
    {
      ...base,
      id: "req_0b7d3e5f1a29",
      status: "rejected",
      note: "declined",
      sql: "DROP TABLE public.sessions_archive",
      resolvedAt: Date.now() - 12 * MIN,
      session: OC,
      intent: "drop the old sessions table",
    },
  ];
}

// What TypeSafe answers for an eligible read: clear on every axis, well under the cutoffs.
export function evaluation(evaluatedAt: number, sqlDigest: string): AutoEvaluation {
  return {
    provider: "typesafe",
    model: AUTO_MODEL,
    policy: AUTO_POLICY,
    evaluatedAt,
    sqlDigest,
    eligible: true,
    reasons: [],
    probabilities: {
      personal_disclosure: 0.02,
      organization_disclosure: 0.03,
      secret_disclosure: 0.01,
      insufficient_context: 0.08,
    },
    thresholds: { ...AUTO_THRESHOLDS },
    builtIn: true,
  };
}

type Past = Pick<ActivityEntry, "intent" | "sql" | "state"> &
  Partial<Pick<ActivityEntry, "reason" | "error" | "rowCount" | "affectedRows" | "sensitivity">> & {
    by: SessionMeta;
    auto?: boolean;
  };

// A week of earlier decisions, so the Audit Trail reads like a team's real use.
const PAST: Past[] = [
  {
    intent: "orders per day this week",
    sql: ARRIVALS[0].sql,
    state: "approved",
    auto: true,
    rowCount: 5,
    by: CX,
  },
  {
    intent: "customers with an open ticket and their email",
    sql: WAITING.openTickets,
    state: "approved",
    rowCount: 23,
    sensitivity: { pii: true, value: false, client: false },
    by: CX,
  },
  {
    intent: "search latency per day this week",
    sql: ARRIVALS[1].sql,
    state: "approved",
    auto: true,
    rowCount: 7,
    by: OC,
  },
  {
    intent: "mark the duplicate invoices as void",
    sql: WAITING.voidDup,
    state: "approved",
    affectedRows: 2,
    by: CC,
  },
  {
    intent: "top products by revenue this month",
    sql: ARRIVALS[2].sql,
    state: "approved",
    auto: true,
    rowCount: 10,
    by: CX,
  },
  {
    intent: "drop the old sessions table",
    sql: "DROP TABLE public.sessions_archive",
    state: "rejected",
    reason: "Not on this database.",
    by: OC,
  },
  {
    intent: "refunds since Monday by reason",
    sql: ARRIVALS[3].sql,
    state: "approved",
    auto: true,
    rowCount: 4,
    by: CC,
  },
  {
    intent: "reset the trial end date for two accounts",
    sql: "UPDATE public.subscriptions SET trial_ends_at = now() + interval '7 days' WHERE id IN (4102, 4117)",
    state: "expired",
    by: CC,
  },
  {
    intent: "slowest product searches today",
    sql: "SELECT s.query_text, s.duration_ms FROM public.search_requests s ORDER BY s.duration_ms DESC LIMIT 20",
    state: "failed",
    error: "column s.query_text does not exist",
    by: OC,
  },
];

const toEntry = (h: HistItem): ActivityEntry => ({
  id: h.id,
  createdAt: h.resolvedAt - 40_000,
  decidedAt: h.resolvedAt,
  sessionId: h.session?.sessionId ?? "",
  harness: h.session?.harness ?? null,
  project: h.session?.project ?? null,
  sessionLabel: h.session?.sessionLabel ?? null,
  sql: h.sql,
  intent: h.intent ?? null,
  state: h.status,
  reason: null,
  error: null,
  rowCount: h.result?.rowCount ?? null,
  affectedRows: h.result?.affectedRows ?? null,
  approval:
    h.approval?.source === "automatic"
      ? {
          source: "automatic",
          evaluation: evaluation(h.resolvedAt, h.id.slice(4).repeat(6).slice(0, 64)),
        }
      : h.approval,
  sensitivity: h.sensitivity,
  kept: Boolean(h.result?.rows.length),
});

/** The rows the server keeps sealed for the latest approvals, by request id. */
export function keptResults(): Map<string, HistResult> {
  return new Map(
    history()
      .filter((h) => h.result?.rows.length)
      .map((h) => [h.id, h.result as HistResult]),
  );
}

/** The Audit Trail: today's decisions (the same as Recently resolved), then the past week. */
export function activity(): ActivityEntry[] {
  const entries = history().map(toEntry);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  for (const daysAgo of [1, 2, 3, 4, 6, 7]) {
    const count = 3 + ((daysAgo * 7) % 4);
    for (let k = 0; k < count; k++) {
      // A stride prime to the template count, so no day repeats a request.
      const p = PAST[(daysAgo * 5 + k * 2) % PAST.length];
      const decidedAt =
        midnight.getTime() -
        daysAgo * 24 * 60 * MIN +
        (9 + k * 2) * 60 * MIN +
        ((daysAgo * 13) % 50) * MIN;
      const id = `req_${(0x5a17c0de0000 + daysAgo * 977 + k * 131).toString(16).slice(-12)}`;
      entries.push({
        id,
        createdAt: decidedAt - (p.auto ? 20_000 : 3 * MIN),
        decidedAt,
        sessionId: p.by.sessionId,
        harness: p.by.harness,
        project: p.by.project,
        sessionLabel: p.by.sessionLabel,
        sql: p.sql,
        intent: p.intent,
        state: p.state,
        reason: p.reason ?? null,
        error: p.error ?? null,
        rowCount: p.rowCount ?? null,
        affectedRows: p.affectedRows ?? null,
        approval:
          p.state !== "approved"
            ? undefined
            : p.auto
              ? {
                  source: "automatic",
                  evaluation: evaluation(decidedAt, id.slice(4).repeat(6).slice(0, 64)),
                }
              : { source: "human" },
        sensitivity: p.sensitivity,
      });
    }
  }
  return entries;
}
