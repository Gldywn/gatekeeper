import { escapeHtml } from "../html";
import { flaskIcon, gearIcon } from "../icons";
import { modeDropdown, switchInput } from "../render/controls";
import { RECENTLY_RESOLVED_OPTIONS, RESULT_CACHE_OPTIONS, type Settings } from "../settings";
import type { RiskMode } from "../sql/mode";

interface SettingsViewDeps {
  root: HTMLElement;
  settings: () => Settings;
  mode: () => RiskMode;
}

interface ToggleSpec {
  key: keyof Settings;
  name: string;
  desc: string;
  // A tiny sample rendered in the detection's own on-card style, so its effect reads
  // at a glance next to the name.
  example?: { text: string; cls: string };
}

// Ordered so schema annotation, the base that resolves the columns the flags read,
// leads its group.
const DETECTION_TOGGLES: ToggleSpec[] = [
  {
    key: "schemaAnnotation",
    name: "Schema annotation",
    desc: "Resolve and show the tables and columns a query reads (host-side).",
    example: { text: "reads users", cls: "reads" },
  },
  {
    key: "piiFlagging",
    name: "PII flagging",
    desc: "Highlight person-data columns and values on the approval card.",
    example: { text: "email", cls: "pii" },
  },
  {
    key: "clientFlagging",
    name: "Client-data flagging",
    desc: "Highlight company and commercial columns and values, with a separate accent.",
    example: { text: "company", cls: "client" },
  },
  {
    key: "sensitiveValues",
    name: "Sensitive-value detection",
    desc: "Flag a sensitive literal used in a WHERE filter, not just projected columns.",
    example: { text: "'a@b.co'", cls: "lit" },
  },
];

// Owns the settings overlay (#settings): the same .detail chrome as the activity and
// detail views. Renders on open from the live Settings; the app's delegated change
// handler persists and re-syncs, so this never rebuilds mid-edit.
export class SettingsView {
  private readonly root: HTMLElement;
  private readonly settings: () => Settings;
  private readonly mode: () => RiskMode;

  constructor(deps: SettingsViewDeps) {
    this.root = deps.root;
    this.settings = deps.settings;
    this.mode = deps.mode;
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
    return `
      <div class="detail-card settings-card">
        <div class="panel-head">
          <span class="panel-head-ico">${gearIcon}</span>
          <span class="panel-title">Settings</span>
          <button class="detail-close" type="button" data-close aria-label="Close settings">&times;</button>
        </div>
        <div class="starbar">
          <span class="ghtile"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg></span>
          <div class="starbar-txt">
            <div class="starbar-t1">Enjoying Gatekeeper?</div>
            <div class="starbar-t2">A star helps others find it, and lets you follow releases.</div>
            <div class="starbar-t2">It's open source and open to contributions, pull requests welcome.</div>
          </div>
          <button class="starbtn" type="button" data-gh-star><svg class="star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>Star</button>
        </div>
        <section class="set-group">
          ${groupHead("Access")}
          <div class="set-row">
            <div class="set-text">
              <span class="set-name">Execution mode</span>
              <span class="set-desc">Which statements Gatekeeper will run once you approve. Resets to read-only on load or a connection switch.</span>
            </div>
            <span class="set-control" id="modeCtlSettings">${modeDropdown(this.mode())}</span>
          </div>
          <div class="set-row">
            <div class="set-text">
              <span class="set-name">Double confirmation</span>
              <span class="set-desc">Ask for a second one-click confirmation, showing the statement, before an approved write or destructive query runs. Reads never prompt.</span>
            </div>
            <span class="set-control">${switchInput("confirmWrites", "Double confirmation", s.confirmWrites)}</span>
          </div>
          <div class="set-row recommend">
            <div class="set-text">
              <span class="set-name"><span class="set-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg></span>Schema access <span class="set-rec">recommended</span></span>
              <span class="set-desc">Give connected agents your database structure (tables, columns, types, keys) so they write more accurate, valid SQL instead of guessing names. Never exposes any row data. Off by default.</span>
            </div>
            <span class="set-control">${switchInput("schemaAccess", "Schema access", s.schemaAccess)}</span>
          </div>
        </section>
        <section class="set-group">
          ${groupHead("Detection")}
          ${DETECTION_TOGGLES.map((t) => toggleRow(t, s)).join("")}
        </section>
        <section class="set-group">
          ${groupHead("History")}
          <div class="set-row">
            <div class="set-text">
              <span class="set-name">Recently resolved</span>
              <span class="set-desc">How many resolved items the history panel keeps.</span>
            </div>
            <span class="set-control">${selectHtml(s.recentlyResolved)}</span>
          </div>
          <div class="set-row">
            <div class="set-text">
              <span class="set-name">Result memory</span>
              <span class="set-desc">How much result data this tab keeps in memory so you can reopen a past result and scroll its full table. Once the limit is reached, the oldest results are dropped.</span>
            </div>
            <span class="set-control">${cacheSelectHtml(s.resultCacheMb)}</span>
          </div>
        </section>
        <section class="set-group danger-zone">
          <div class="set-group-head"><span class="set-group-name">Danger zone</span></div>
          <div class="set-row">
            <div class="set-text">
              <span class="set-name">Reset all settings</span>
              <span class="set-desc">Restore every setting on this connection to its default. This can't be undone.</span>
            </div>
            <button class="dz-reset" type="button" data-reset-settings>Reset to defaults</button>
          </div>
        </section>
        <div class="settings-sep"></div>
        ${devZone(s)}
      </div>`;
  }
}

// A recessed, dashed, dimmer block set apart from the real settings: one blue
// toggle for the whole developer suite. Blue (never amber/green/red) so it reads
// as technical, not a warning.
function devZone(s: Settings): string {
  return `
        <div class="dev-zone">
          <div class="dev-row">
            <div class="dev-main">
              <span class="dev-name"><span class="dev-flask">${flaskIcon}</span>Developer mode <span class="dev-tag">dev</span></span>
              <span class="dev-desc">Turn on developer mode and its utilities. Only ever runs neutral read-only queries, never touches your data.</span>
            </div>
            <span class="set-control">${switchInput("developerMode", "Developer mode", s.developerMode)}</span>
          </div>
        </div>`;
}

function groupHead(name: string): string {
  return `<div class="set-group-head"><span class="set-group-name">${name}</span></div>`;
}

function toggleRow(t: ToggleSpec, s: Settings): string {
  const example = t.example
    ? `<span class="set-ex ${t.example.cls}">${escapeHtml(t.example.text)}</span>`
    : "";
  return `
          <div class="set-row">
            <div class="set-text">
              <span class="set-name-line"><span class="set-name">${escapeHtml(t.name)}</span>${example}</span>
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

function cacheLabel(mb: number): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
}

function cacheSelectHtml(value: number): string {
  const opts = RESULT_CACHE_OPTIONS.map(
    (n) => `<option value="${n}"${n === value ? " selected" : ""}>${cacheLabel(n)}</option>`,
  ).join("");
  return `<select class="set-select" data-setting="resultCacheMb" aria-label="Result memory budget">${opts}</select>`;
}
