import { flaskIcon } from "../icons";
import type { Card, SessionMeta } from "../types";

export type DevCardType = "pii" | "client" | "sensitive" | "star" | "plain";

export interface DevCardSpec {
  type: DevCardType;
  intent: string;
  sql: string;
}

// Purely local: this session never comes from /sessions nor reaches the broker.
const DEV_SESSION: SessionMeta = {
  sessionId: "dev-mode",
  harness: "dev-mode",
  harnessVersion: null,
  project: null,
  sessionLabel: "Synthetic session for UI testing",
};

// Generous enough that the lease visibly counts down without lapsing mid-demo;
// this is never a real broker lease.
const DEV_TTL_MS = 5 * 60_000;

// PII/client wrap the values in a derived table so the aliases are real column
// refs the parser reports (a bare projected literal is reported as its value, not
// its alias); no FROM-less WHERE, which MySQL rejects.
const SPECS: Record<DevCardType, Omit<DevCardSpec, "type">> = {
  pii: {
    intent: "Synthetic: person data",
    sql: "SELECT email, full_name, phone FROM (SELECT 'a@b.com' AS email, 'Jane Roe' AS full_name, '+1-202-555-0100' AS phone) AS t",
  },
  client: {
    intent: "Synthetic: client data",
    sql: "SELECT company_name, annual_revenue FROM (SELECT 'Globex' AS company_name, 12000000 AS annual_revenue) AS t",
  },
  sensitive: {
    intent: "Synthetic: sensitive literal",
    sql: "SELECT 'noreply@example.com' = '' AS is_empty",
  },
  star: {
    intent: "Synthetic: full-row read",
    sql: "SELECT * FROM information_schema.tables WHERE 1=0",
  },
  plain: {
    intent: "Synthetic: plain read",
    sql: "SELECT 1 AS ok",
  },
};

// Chip order in the dev panel, and the order "Send a bundle" injects.
export const DEV_CARD_TYPES: readonly DevCardType[] = [
  "pii",
  "client",
  "sensitive",
  "star",
  "plain",
];

const CHIP_LABEL: Record<DevCardType, string> = {
  pii: "PII",
  client: "Client-data",
  sensitive: "Sensitive literal",
  star: "SELECT *",
  plain: "Plain",
};

export function devCardSpec(type: DevCardType): DevCardSpec {
  return { type, ...SPECS[type] };
}

export function devBundle(): DevCardSpec[] {
  return DEV_CARD_TYPES.map(devCardSpec);
}

// dev:true routes every resolve down the local path; id, lease, and session are
// synthetic and never leave the tab.
export function buildDevCard(spec: DevCardSpec, id: string, now: number): Card {
  return {
    id,
    sql: spec.sql,
    intent: spec.intent,
    createdAt: now,
    expiresAt: now + DEV_TTL_MS,
    leaseId: `${id}-lease`,
    leaseExpiresAt: now + DEV_TTL_MS,
    sessionId: DEV_SESSION.sessionId,
    session: DEV_SESSION,
    state: "ready",
    dev: true,
  };
}

// Buttons carry the data-dev-* hooks the app delegates on.
export function devPanelHtml(): string {
  const chips = DEV_CARD_TYPES.map(
    (t) => `<button class="dp-chip" type="button" data-dev-chip="${t}">${CHIP_LABEL[t]}</button>`,
  ).join("");
  return `<div class="dev-panel">
        <div class="dp-head">
          <span class="dev-flask">${flaskIcon}</span>
          <span class="dp-title">Developer panel</span>
        </div>
        <div class="dp-group">
          <span class="dp-group-label">Synthetic proposals</span>
          <div class="dp-actions">
            <button class="dp-primary" type="button" data-dev-bundle>Send a bundle</button>
            <span class="dp-sep" aria-hidden="true"></span>
            ${chips}
          </div>
        </div>
        <div class="dp-group">
          <span class="dp-group-label">Quick tools</span>
          <div class="dp-actions">
            <button class="dp-chip" type="button" data-dev-reload>Reload view</button>
          </div>
        </div>
      </div>`;
}
