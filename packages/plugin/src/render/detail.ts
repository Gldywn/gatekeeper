import { capitalize, escapeHtml, formatCount, previewSql, sessionDisplayName } from "../html";
import {
  agentBadge,
  checkIcon,
  clockIcon,
  copyIcon,
  downloadIcon,
  jsonIcon,
  markdownIcon,
  tableIcon,
  xCircleIcon,
} from "../icons";
import { classifyQuery, type RiskClass } from "../sql/classify";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import { visibleControls } from "../sql/sanitize";
import { countsRows, statementReceipt } from "../sql/schema";
import { parseStopNote } from "../sql/stop";
import type { HistItem } from "../types";
import { approvalHtml } from "./auto";
import { flyoutMenu } from "./controls";
import { accessMatrix, riskBadge } from "./queue";

// An agent cancellation is stored as an expiry; this note is what tells the two apart.
export const CANCELLED_NOTE = "cancelled by the agent";
// The rows ran but the broker never took the result; and the error the server's sweep records
// when an execution lease lapses with no outcome. Both leave the outcome unconfirmed.
export const NOT_DELIVERED_NOTE = "result not delivered";
export const EXECUTION_UNKNOWN = "execution_unknown";

// Where a decided request comes from: the local history (Recently resolved) knows its own notes
// and who declined; an Audit Trail entry knows only what the server recorded.
export type DetailSource = "hist" | "audit";

// The decided request, result first: what happened and who decided, what the query did (and
// its rows, if held), then what was asked under the REQUEST line, as the pending card showed it.
export function detailHtml(item: HistItem, source: DetailSource, dialect: string): string {
  const cls = classifyQuery(item.sql, dialect).class;
  return `
      <div class="detail-flat ${cls === "read" ? "" : cls}">
        ${statusHtml(item, source)}${resultHtml(item, dialect, cls)}
        <div class="sep-label"><span>Request</span></div>
        ${requestHtml(item, dialect, cls)}
      </div>`;
}

interface Outcome {
  cls: "ok" | "no" | "fail" | "mut";
  icon: string;
  label: string;
  // Who decided: only what the record establishes.
  attr: string;
  // A fact between the status and the message (a stop request).
  line?: string;
  // The one explanation box; `err` for an execution error's raw text.
  message?: { text: string; err: boolean };
}

function outcome(item: HistItem, source: DetailSource): Outcome {
  const approver =
    item.approval?.source === "automatic"
      ? "Approved automatically"
      : item.approval?.source === "human"
        ? "Approved by you"
        : "Approver not recorded";
  if (item.status === "approved") {
    return { cls: "ok", icon: checkIcon, label: "Completed", attr: approver };
  }
  if (item.status === "rejected") {
    // "declined" is the label a decline without a typed reason carries; only a real reason shows.
    const reason = item.note?.trim();
    return {
      cls: "no",
      icon: xCircleIcon,
      label: "Declined",
      // Only a local decline names its author: an Audit Trail rejection may be the gate's own.
      attr: source === "hist" ? "Declined by you" : "",
      ...(reason && reason !== "declined" ? { message: { text: reason, err: false } } : {}),
    };
  }
  if (item.status === "failed") {
    const note = item.note?.trim() || "The query failed at execution.";
    if (item.note === EXECUTION_UNKNOWN) {
      return failed("Execution outcome unknown", approver, {
        text: "The execution lease expired before the outcome was recorded. The query may have changed data.",
        err: false,
      });
    }
    if (item.outcome === NOT_DELIVERED_NOTE) {
      return failed("Result delivery unconfirmed", approver, {
        text: "The database returned successfully. Delivery to the server could not be confirmed.",
        err: false,
      });
    }
    if (item.outcome === "blocked" || item.outcome === "lease lost") {
      return {
        cls: "mut",
        icon: xCircleIcon,
        label: "Not run",
        attr: approver,
        message: {
          text:
            item.outcome === "blocked"
              ? "Execution was blocked."
              : "Execution could not be authorized.",
          err: false,
        },
      };
    }
    // A stop request is one more fact, never the claimed cause of the error after it.
    const stop = parseStopNote(note);
    return {
      ...failed("Failed", approver, { text: stop ? stop.message : note, err: true }),
      ...(stop ? { line: stop.stop } : {}),
    };
  }
  return item.note === CANCELLED_NOTE
    ? {
        cls: "mut",
        icon: clockIcon,
        label: "Cancelled",
        attr: "",
        message: { text: "The agent withdrew the proposal before execution.", err: false },
      }
    : {
        cls: "mut",
        icon: clockIcon,
        label: "Expired",
        attr: "",
        message: { text: "The proposal expired before execution.", err: false },
      };
}

function failed(label: string, attr: string, message: Outcome["message"]): Outcome {
  return { cls: "fail", icon: xCircleIcon, label, attr, message };
}

function statusHtml(item: HistItem, source: DetailSource): string {
  const o = outcome(item, source);
  const when = `${source === "audit" ? "Recorded" : "Resolved"} ${escapeHtml(
    new Date(item.resolvedAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  )}`;
  const sub = [o.attr, when].filter(Boolean).join(" &middot; ");
  const message = o.message
    ? `<div class="dt-msg${o.message.err ? " err" : ""}"><span class="q">Message</span>${escapeHtml(o.message.text)}</div>`
    : "";
  return `<div class="dt-status ${o.cls}"><span class="dt-st">${o.icon}${o.label}</span></div><div class="dt-sub">${sub}</div>${o.line ? `<div class="dt-sub">${escapeHtml(o.line)}</div>` : ""}${message}`;
}

const rowsHtml = (n: number) => `<b>${formatCount(n)}</b> ${n === 1 ? "row" : "rows"}`;

// One receipt for reads and writes alike. DDL reports a conventional zero that measures
// nothing, and a write's empty result set says nothing either: neither is counted.
function resultHtml(item: HistItem, dialect: string, cls: RiskClass): string {
  if (item.status !== "approved") {
    return "";
  }
  const receipt = statementReceipt(item.sql, dialect);
  const head = receipt
    ? `<code class="kw">${receipt.op}</code> on ${receipt.tables.map((t) => `<code class="name">${escapeHtml(t)}</code>`).join(", ")} completed`
    : "Query completed";
  const r = item.result;
  const parts: string[] = [];
  if (r?.affectedRows != null && countsRows(item.sql, dialect)) {
    parts.push(`<b>affecting</b> ${rowsHtml(r.affectedRows)}`);
  }
  if (r?.rowCount != null && !(cls !== "read" && r.rowCount === 0)) {
    parts.push(`<b>returning</b> ${rowsHtml(r.rowCount)}`);
  }
  const line = `<p class="dt-fact">${head}${parts.length ? `, ${parts.join(" and ")}` : ""}.</p>`;
  const grid = r?.rows.length ? resultGrid() : "";
  // The local note records how many rows the agent was sent when its cap cut them.
  const sent = /\(agent received (\d+)\)$/.exec(item.note ?? "");
  const cap = sent
    ? `<p class="dt-fact dt-quiet">Only the first ${formatCount(Number(sent[1]))} rows were sent to the agent to avoid context pollution.</p>`
    : "";
  return `<div class="dt-result">${line}${grid}${cap}</div>`;
}

// The held rows: Copy and Export left, Tabulator's pager mounted right (views/detail.ts), the
// position written beside it; no footer under the grid.
function resultGrid(): string {
  const copy = flyoutMenu(
    "copy",
    "result",
    `<span class="flyout-ico" data-flyout-ico>${copyIcon}</span>`,
    "Copy",
    [{ fmt: "md", icon: markdownIcon, name: "Markdown" }],
  );
  const exportMenu = flyoutMenu("export", "result", downloadIcon, "Export", [
    { fmt: "csv", icon: tableIcon, name: "CSV" },
    { fmt: "json", icon: jsonIcon, name: "JSON" },
  ]);
  return `<div class="res" id="detail-grid"><div class="res-bar"><span class="res-tools">${copy}${exportMenu}</span><span class="res-pg"><span class="res-count" data-grid-count></span><span class="res-pager" data-grid-pager></span></span></div><div class="gk-grid" data-result-grid></div></div>`;
}

function requestHtml(item: HistItem, dialect: string, cls: RiskClass): string {
  const harness = item.session?.harness?.trim() || null;
  const task = item.session?.sessionLabel?.trim();
  const meta = [
    escapeHtml(item.id),
    item.session?.sessionId ? escapeHtml(item.session.sessionId) : "",
    item.connection ? `on ${escapeHtml(item.connection)}` : "",
  ].filter(Boolean);
  return `<div class="pd-who">${agentBadge(harness)}<span class="pd-name">${escapeHtml(sessionDisplayName(item.session, item.id))}</span>${task ? `<span class="pd-task" title="${escapeHtml(capitalize(task))}">${escapeHtml(capitalize(task))}</span>` : ""}</div>
        <div class="top">${riskBadge(cls)}<span class="intent">${escapeHtml(item.intent ? capitalize(item.intent) : previewSql(item.sql))}</span></div>
        <div class="meta">${meta.join(" &middot; ")}</div>
        <div class="cs-matrix" id="detail-cm">${accessMatrix(item.sql, dialect, cls)}</div>
        <div class="cs-legend" id="detail-cs"></div>
        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(visibleControls(item.sql))}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="detail-sqlbody">${highlight(formatSql(item.sql))}</code></pre>
        ${approvalHtml(item.approval, item.evaluation, item.autoHold)}`;
}
