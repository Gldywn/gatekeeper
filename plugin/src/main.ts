import "./style.css";
import {
  addNotificationListener,
  getAppInfo,
  log,
  runQuery,
} from "@beekeeperstudio/plugin";
import type { RunQueryResult } from "@beekeeperstudio/plugin";

const BROKER_URL = "http://localhost:9999";
const POLL_INTERVAL_MS = 1000;
const RESUME_DELAY_MS = 1500;

interface Proposal {
  id: string;
  sql: string;
  intent?: string;
  createdAt: number;
}

interface Field {
  name: string;
}

// The plugin is the only component that can call runQuery, so the read-only
// rule lives here. Conservative by design (fails closed); this is the extension
// point to harden the policy later.
export function isReadOnlyQuery(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  if (stripped.length === 0) {
    return false;
  }
  // A lone trailing semicolon is fine; anything past it means stacked statements.
  const single = stripped.replace(/;\s*$/, "");
  if (single.includes(";")) {
    return false;
  }
  return /^(select|with)\b/i.test(single);
}

/** Claim the next pending proposal from the broker, or null if none is waiting. */
export async function fetchPending(): Promise<Proposal | null> {
  const response = await fetch(`${BROKER_URL}/pending`);
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GET /pending returned ${response.status}`);
  }
  return (await response.json()) as Proposal;
}

/** Post the human's decision back to the broker, unblocking the run_query call. */
export async function postResult(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${BROKER_URL}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST /result returned ${response.status}`);
  }
}

/** Run an approved query and shape its first result set for the broker. */
export async function runApprovedQuery(
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; fields: Field[] }> {
  const result: RunQueryResult = await runQuery(sql);
  const first = result.results[0];
  return {
    rows: first?.rows ?? [],
    fields: (first?.fields ?? []).map((field) => ({ name: field.name })),
  };
}

// Proposal text comes from the agent, so escape before injecting into the DOM.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class Gatekeeper {
  private polling = false;
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  start(): void {
    this.root.innerHTML = `
      <main class="container">
        <h1>Gatekeeper</h1>
        <p class="subtitle">Approve read-only queries proposed by an AI agent.</p>
        <div id="status" class="status"></div>
        <div id="panel"></div>
      </main>
    `;
    this.polling = true;
    void this.poll();
  }

  private setStatus(text: string, isError = false): void {
    const el = this.root.querySelector<HTMLDivElement>("#status")!;
    el.textContent = text;
    el.classList.toggle("error", isError);
  }

  private async poll(): Promise<void> {
    if (!this.polling) {
      return;
    }
    try {
      const proposal = await fetchPending();
      if (proposal) {
        this.polling = false;
        this.renderProposal(proposal);
        return;
      }
      this.setStatus("Waiting for a query proposal...");
    } catch (err) {
      this.setStatus(`Broker unreachable at ${BROKER_URL}. Retrying...`, true);
      log.error(err instanceof Error ? err : String(err));
    }
    setTimeout(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private renderProposal(proposal: Proposal): void {
    const readOnly = isReadOnlyQuery(proposal.sql);
    this.setStatus("A query is awaiting your approval.");
    const panel = this.root.querySelector<HTMLDivElement>("#panel")!;
    panel.innerHTML = `
      <div class="proposal">
        ${proposal.intent ? `<p class="intent"><strong>Intent:</strong> ${escapeHtml(proposal.intent)}</p>` : ""}
        <pre class="sql">${escapeHtml(proposal.sql)}</pre>
        ${readOnly ? "" : `<p class="blocked">Blocked: only read-only SELECT queries can be approved.</p>`}
        <div class="actions">
          <button id="approve-btn" class="primary-btn" type="button" ${readOnly ? "" : "disabled"}>Approve &amp; run</button>
          <button id="reject-btn" class="secondary-btn" type="button">Reject</button>
        </div>
        <pre id="outcome" class="output" hidden></pre>
      </div>
    `;
    panel
      .querySelector<HTMLButtonElement>("#approve-btn")!
      .addEventListener("click", () => void this.approve(proposal));
    panel
      .querySelector<HTMLButtonElement>("#reject-btn")!
      .addEventListener("click", () => void this.reject(proposal));
  }

  private async approve(proposal: Proposal): Promise<void> {
    const outcome = this.beginAction("Running query...");
    // Re-check at the only runQuery call site, even though Approve is disabled
    // for non-SELECT proposals.
    if (!isReadOnlyQuery(proposal.sql)) {
      await this.safePost({
        id: proposal.id,
        status: "rejected",
        reason: "Blocked: not a read-only SELECT.",
      });
      this.endAction(outcome, "Blocked: not a read-only SELECT.", true);
      return;
    }
    try {
      const { rows, fields } = await runApprovedQuery(proposal.sql);
      await postResult({ id: proposal.id, status: "approved", rows, fields });
      this.endAction(outcome, `Approved. Returned ${rows.length} row(s).`, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Human approved but execution failed; report the error to the agent.
      await this.safePost({ id: proposal.id, status: "approved", error: message });
      this.endAction(outcome, `Query failed: ${message}`, true);
    }
  }

  private async reject(proposal: Proposal): Promise<void> {
    const outcome = this.beginAction("Rejecting...");
    await this.safePost({
      id: proposal.id,
      status: "rejected",
      reason: "Rejected by user.",
    });
    this.endAction(outcome, "Rejected.", false);
  }

  private beginAction(text: string): HTMLPreElement {
    this.root
      .querySelectorAll<HTMLButtonElement>(".actions button")
      .forEach((button) => (button.disabled = true));
    const outcome = this.root.querySelector<HTMLPreElement>("#outcome")!;
    outcome.hidden = false;
    outcome.classList.remove("error");
    outcome.textContent = text;
    return outcome;
  }

  private endAction(outcome: HTMLPreElement, text: string, isError: boolean): void {
    outcome.textContent = text;
    outcome.classList.toggle("error", isError);
    setTimeout(() => {
      this.root.querySelector<HTMLDivElement>("#panel")!.innerHTML = "";
      this.polling = true;
      void this.poll();
    }, RESUME_DELAY_MS);
  }

  private async safePost(body: Record<string, unknown>): Promise<void> {
    try {
      await postResult(body);
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }
}

function applyTheme(cssString: string): void {
  const themeElement = document.getElementById("app-theme");
  if (themeElement) {
    themeElement.textContent = `:root { ${cssString} }`;
  }
}

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    return;
  }
  new Gatekeeper(root).start();
  try {
    const appInfo = await getAppInfo();
    applyTheme(appInfo.theme.cssString);
    addNotificationListener("themeChanged", (theme) => {
      applyTheme(theme.cssString);
    });
  } catch (err) {
    log.error(err instanceof Error ? err : String(err));
  }
}

void bootstrap();
