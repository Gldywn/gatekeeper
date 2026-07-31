import { escapeHtml } from "../html";
import { arrowLeftIcon } from "../icons";
import { lockedReadOnlySwitch, switchInput } from "../render/controls";
import { RECENTLY_RESOLVED_OPTIONS, type Settings } from "../settings";

interface SettingsViewDeps {
  root: HTMLElement;
  settings: () => Settings;
  connectionName: () => string;
  dialect: () => string;
}

interface ToggleSpec {
  key: keyof Settings;
  name: string;
  desc: string;
}

const GUARD_TOGGLES: ToggleSpec[] = [
  {
    key: "piiFlagging",
    name: "PII flagging",
    desc: "Highlight person-data columns and values on the approval card.",
  },
  {
    key: "clientFlagging",
    name: "Client-data flagging",
    desc: "Highlight company and commercial columns and values, with a separate accent.",
  },
  {
    key: "schemaAnnotation",
    name: "Schema annotation",
    desc: "Resolve and show the tables and columns a query reads (host-side).",
  },
  {
    key: "sensitiveValues",
    name: "Sensitive-value detection",
    desc: "Flag a sensitive literal used in a WHERE filter, not just projected columns.",
  },
];

// Owns the full-screen settings overlay (#settings): the same .detail chrome as the
// activity and detail views. Renders on open from the live Settings; the app's
// delegated change handler persists and re-syncs, so this never rebuilds mid-edit.
export class SettingsView {
  private readonly root: HTMLElement;
  private readonly settings: () => Settings;
  private readonly connectionName: () => string;
  private readonly dialect: () => string;

  constructor(deps: SettingsViewDeps) {
    this.root = deps.root;
    this.settings = deps.settings;
    this.connectionName = deps.connectionName;
    this.dialect = deps.dialect;
  }

  open(): void {
    const panel = this.root.querySelector<HTMLDivElement>("#settings");
    if (!panel) {
      return;
    }
    panel.innerHTML = this.html();
    panel.hidden = false;
  }

  close(): void {
    const panel = this.root.querySelector<HTMLDivElement>("#settings");
    if (panel && !panel.hidden) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }

  private html(): string {
    const s = this.settings();
    const conn = this.connectionName();
    const dialect = this.dialect();
    const scope = conn
      ? `<span class="act-conn">${escapeHtml(conn)}${dialect ? ` &middot; ${escapeHtml(dialect)}` : ""}</span>`
      : "";
    return `
      <div class="detail-card settings-card">
        <div class="detail-head">
          <button class="set-back" type="button" data-close aria-label="Back to the queue">${arrowLeftIcon}Back</button>
          <span class="detail-who">Settings</span>
          ${scope}
          <button class="detail-close" type="button" data-close aria-label="Close settings">&times;</button>
        </div>
        <section class="set-group">
          <div class="set-group-head">Guards</div>
          <div class="set-row set-locked">
            <div class="set-text">
              <span class="set-name">Read-only mode</span>
              <span class="set-desc">Gatekeeper only ever executes SELECT. Core guarantee; armed write access is planned.</span>
            </div>
            <span class="set-control">${lockedReadOnlySwitch()}</span>
          </div>
          ${GUARD_TOGGLES.map((t) => toggleRow(t, s)).join("")}
        </section>
        <section class="set-group">
          <div class="set-group-head">Behavior</div>
          <div class="set-row">
            <div class="set-text">
              <span class="set-name">Recently resolved</span>
              <span class="set-desc">How many resolved items the history panel keeps.</span>
            </div>
            <span class="set-control">${selectHtml(s.recentlyResolved)}</span>
          </div>
          ${toggleRow(
            {
              key: "activityLog",
              name: "Activity log",
              desc: "Show the connection activity log.",
            },
            s,
          )}
        </section>
      </div>`;
  }
}

function toggleRow(t: ToggleSpec, s: Settings): string {
  return `
          <div class="set-row">
            <div class="set-text">
              <span class="set-name">${escapeHtml(t.name)}</span>
              <span class="set-desc">${escapeHtml(t.desc)}</span>
            </div>
            <span class="set-control">${switchInput(t.key, t.name, Boolean(s[t.key]))}</span>
          </div>`;
}

function selectHtml(value: number): string {
  const opts = RECENTLY_RESOLVED_OPTIONS.map(
    (n) => `<option value="${n}"${n === value ? " selected" : ""}>${n}</option>`,
  ).join("");
  return `<select class="set-select" data-setting="recentlyResolved" aria-label="Recently resolved count">${opts}</select>`;
}
