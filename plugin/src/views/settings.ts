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
          <div class="set-row">
            <div class="set-text">
              <span class="set-name">Schema access</span>
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
