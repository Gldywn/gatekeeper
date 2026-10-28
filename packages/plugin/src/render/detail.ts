import { capitalize, escapeHtml, formatCount, previewSql, sessionDisplayName } from "../html";
import {
  agentBadge,
  checkIcon,
  chevronDown,
  clockIcon,
  copyIcon,
  downloadIcon,
  jsonIcon,
  markdownIcon,
  maximizeIcon,
  tableIcon,
  xCircleIcon,
  xIcon,
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

// Which list a decided request was opened from: the Queue's Recently resolved says when it was
// resolved, the Audit Trail when it was recorded.
export type DetailSource = "hist" | "audit";

// The decided request, result first: what happened and who decided, what the query did (and
// its rows, once opened), then what was asked, folded, as the pending card showed it.
export function detailHtml(
  item: HistItem,
  source: DetailSource,
  dialect: string,
  requestOpen = false,
  loadingRows = false,
): string {
  const cls = classifyQuery(item.sql, dialect).class;
  return `
      <div class="detail-flat ${cls === "read" ? "" : cls}">
        ${statusHtml(item, source)}${resultHtml(item, dialect, cls, loadingRows)}
        ${requestFoldHtml(item, requestOpen)}
        <div class="rq-body" id="detail-rq"${requestOpen ? "" : " hidden"}>${requestHtml(item, dialect, cls)}</div>
      </div>`;
}

// Once decided, what was asked folds under one line that names it by its intent; the whole line
// opens it. It starts closed on each item and keeps its state while that item re-renders.
function requestFoldHtml(item: HistItem, open: boolean): string {
  const what = escapeHtml(item.intent ? capitalize(item.intent) : previewSql(item.sql));
  return `<button class="rq-row" type="button" data-request-toggle aria-expanded="${open}" aria-controls="detail-rq"><span class="rq-chev">${chevronDown}</span><span class="rq-label">${open ? "Hide" : "Show"} request</span><span class="rq-intent">${what}</span></button>`;
}

interface Outcome {
  cls: "ok" | "no" | "fail" | "mut";
  icon: string;
  label: string;
  // Who decided: only what the record establishes.
  attr: string;
  // A fact between the status and the message (a stop request).
  line?: string;
  // The one explanation box: `err` for an execution error's raw text, `reason` for your words.
  message?: { text: string; tone?: "err" | "reason" };
}

function outcome(item: HistItem): Outcome {
  const approver =
    item.approval?.source === "automatic"
      ? "Approved automatically"
      : item.approval?.source === "human"
        ? "Approved by you"
        : "Approver not recorded";
  if (item.status === "approved") {
    return { cls: "ok", icon: checkIcon, label: "Completed", attr: approver };
  }
  if (item.status === "rejected" && item.declinedBy === "gate") {
    return {
      cls: "mut",
      icon: xCircleIcon,
      label: "Not run",
      attr: "",
      message: { text: item.sent ?? item.reason ?? "Execution was blocked." },
    };
  }
  if (item.status === "rejected" && item.autoDenied) {
    return {
      cls: "no",
      icon: xCircleIcon,
      label: "Declined",
      attr: "Declined by the load check",
      message: item.sent ? { text: item.sent } : undefined,
    };
  }
  if (item.status === "rejected") {
    // The words the person typed, when the record says there were some.
    const typed = item.reason ?? "";
    // Only a decline recorded as a person's names its author and can read as your words: an
    // unmarked one may be the gate's own, with the gate's own sentence as its reason.
    const yours = item.declinedBy === "human";
    // The box shows what the agent received: the words typed, then any load check hints.
    const said = item.sent || typed;
    return {
      cls: "no",
      icon: xCircleIcon,
      label: "Declined",
      attr: yours ? "Declined by you" : "",
      message: said
        ? { text: said, tone: yours && typed ? "reason" : undefined }
        : {
            text: yours
              ? "You declined this proposal without giving a reason."
              : "The proposal was declined.",
          },
    };
  }
  if (item.status === "failed") {
    const note = item.note?.trim() || "The query failed at execution.";
    if (item.note === EXECUTION_UNKNOWN) {
      return failed("Execution outcome unknown", approver, {
        text: "The execution lease expired before the outcome was recorded. The query may have changed data.",
      });
    }
    if (item.outcome === NOT_DELIVERED_NOTE) {
      return failed("Result delivery unconfirmed", approver, {
        text: "The database returned successfully. Delivery to the server could not be confirmed.",
      });
    }
    if (item.outcome === "lease lost") {
      return {
        cls: "mut",
        icon: xCircleIcon,
        label: "Not run",
        attr: approver,
        message: { text: "Execution could not be authorized." },
      };
    }
    // A stop request is one more fact, never the claimed cause of the error after it.
    const stop = parseStopNote(note);
    return {
      ...failed("Failed", approver, { text: stop ? stop.message : note, tone: "err" }),
      ...(stop ? { line: stop.stop } : {}),
    };
  }
  return item.note === CANCELLED_NOTE
    ? {
        cls: "mut",
        icon: clockIcon,
        label: "Cancelled",
        attr: "Withdrawn by the agent",
        message: { text: "The agent withdrew the proposal before execution." },
      }
    : {
        cls: "mut",
        icon: clockIcon,
        label: "Expired",
        // An approval whose execution was withdrawn can still expire: then it says who approved.
        attr: item.approval ? approver : "Not decided in time",
        message: { text: "The proposal expired before execution." },
      };
}

function failed(label: string, attr: string, message: Outcome["message"]): Outcome {
  return { cls: "fail", icon: xCircleIcon, label, attr, message };
}

function statusHtml(item: HistItem, source: DetailSource): string {
  const o = outcome(item);
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
    ? `<div class="dt-msg${o.message.tone ? ` ${o.message.tone}` : ""}"><span class="q">Message</span>${escapeHtml(o.message.text)}</div>`
    : "";
  return `<div class="dt-status ${o.cls}"><span class="dt-st">${o.icon}${o.label}</span></div><div class="dt-sub">${sub}</div>${o.line ? `<div class="dt-sub">${escapeHtml(o.line)}</div>` : ""}${message}`;
}

const rowsHtml = (n: number) => `<b>${formatCount(n)}</b> ${n === 1 ? "row" : "rows"}`;

// The result block alone, for rows that arrive after the detail is on screen.
export function detailResultHtml(item: HistItem, dialect: string): string {
  return resultHtml(item, dialect, classifyQuery(item.sql, dialect).class, false);
}

// One receipt for reads and writes alike. DDL reports a conventional zero that measures
// nothing, and a write's empty result set says nothing either: neither is counted.
function resultHtml(item: HistItem, dialect: string, cls: RiskClass, loading: boolean): string {
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
  const rows = r?.rows.length ?? 0;
  // Rows that should be there: a count above zero, or a read whose count was never recorded. A
  // known zero and a write's empty result have nothing missing.
  const owed = Boolean(r?.rowCount) || (r?.rowCount == null && cls === "read");
  // Whatever kept them from showing (decided before rows were kept, a key this Beekeeper no
  // longer has, a failed read), one sentence: the reader can do nothing different about any.
  const body = rows
    ? resultGrid()
    : loading
      ? resultGrid(true)
      : owed
        ? `<p class="dt-fact dt-quiet">These rows are not available.</p>`
        : "";
  // The kept result is what the agent was sent, so a cut says how many rows that was.
  const cap =
    rows && r?.truncated
      ? `<p class="dt-fact dt-quiet">Only the first ${formatCount(rows)} rows were sent to the agent to avoid context pollution.</p>`
      : "";
  return `<div class="dt-result">${line}${body}${cap}</div>`;
}

// The rows: Copy, Export and Enlarge left, Tabulator's pager mounted right (views/detail.ts), the
// position written beside it; no footer under the grid. While they load, the same frame with its
// tools inert and a few breathing bars, so nothing moves when the grid arrives.
function resultGrid(loading = false): string {
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
  const enlarge = `<button class="flyout res-zoom" type="button" data-result-zoom aria-label="Enlarge the results" title="Enlarge">${maximizeIcon}</button>`;
  if (loading) {
    return `<div class="res loading" id="detail-grid" aria-busy="true"><div class="res-bar"><span class="res-tools" inert>${copy}${exportMenu}${enlarge}</span></div><div class="res-skel" role="status" aria-label="Loading rows"><i></i><i></i><i></i></div></div>`;
  }
  return `<div class="res" id="detail-grid"><div class="res-bar"><span class="res-tools">${copy}${exportMenu}${enlarge}</span><span class="res-pg"><span class="res-count" data-grid-count></span><span class="res-pager" data-grid-pager></span></span></div><div class="gk-grid" data-result-grid></div></div>`;
}

// The held rows over the whole tab: the request named as in its fold, the Queue's own count while
// its tab is out of sight, then the result bar and grid moved in below (views/detail.ts).
export function resultsDialogHtml(item: HistItem, pending: number): string {
  const what = escapeHtml(item.intent ? capitalize(item.intent) : previewSql(item.sql));
  return `<div class="detail-card results-card" role="dialog" aria-modal="true" aria-labelledby="resultsTitle"><div class="panel-head"><span class="panel-head-ico">${tableIcon}</span><span class="panel-title" id="resultsTitle">${what}</span><button class="results-queue" type="button" data-results-queue${pending ? "" : " hidden"}>Queue<span class="n">${pending}</span></button><button class="detail-close" type="button" data-results-close aria-label="Close" title="Close">${xIcon}</button></div></div>`;
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
