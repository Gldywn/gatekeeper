import { escapeHtml } from "../html";
import { checkIcon, chevronDown } from "../icons";
import type { RiskMode } from "../sql/mode";

export interface FlyoutOption {
  fmt: string;
  icon: string;
  name: string;
}

// A compact trigger + format popover, shared by the audit-trail export and the result
// copy/export controls. Each option carries the action and key, so the app's delegated
// click handler stays stateless; the app wires open/close on the data-flyout-* hooks.
export function flyoutMenu(
  action: string,
  key: string,
  triggerIcon: string,
  triggerLabel: string,
  options: FlyoutOption[],
): string {
  const k = escapeHtml(key);
  const opts = options
    .map(
      (o) =>
        `<button class="flyout-opt" type="button" role="menuitem" data-flyout-action="${action}" data-flyout-key="${k}" data-flyout-fmt="${o.fmt}">${o.icon}${o.name}<span class="flyout-ext">.${o.fmt}</span></button>`,
    )
    .join("\n                ");
  return `<span class="flyout-wrap">
              <button class="flyout" type="button" data-flyout-trigger="${k}" aria-haspopup="menu" aria-expanded="false">${triggerIcon}${triggerLabel}<span class="flyout-chev">${chevronDown}</span></button>
              <div class="flyout-menu" data-flyout-menu role="menu" hidden>
                ${opts}
              </div>
            </span>`;
}

// A real, persisted toggle: an appearance:none checkbox styled as a track+knob. Its
// data-setting maps it to a Settings key; the app's delegated change handler persists it.
export function switchInput(setting: string, ariaLabel: string, checked: boolean): string {
  return `<input class="switch" type="checkbox" role="switch" data-setting="${setting}" aria-label="${escapeHtml(ariaLabel)}"${checked ? " checked" : ""} />`;
}

interface ModeOption {
  mode: RiskMode;
  risk: "ro" | "rw" | "full";
  name: string;
  allow: string;
}

// The risk dot escalates green -> amber -> red as the mode widens. Raising the mode
// needs confirmation (the app wires it); dropping applies immediately.
const MODE_OPTIONS: ModeOption[] = [
  { mode: "read", risk: "ro", name: "Read-only", allow: "SELECT only" },
  { mode: "write", risk: "rw", name: "Write", allow: "adds INSERT, UPDATE" },
  { mode: "destructive", risk: "full", name: "Destructive", allow: "adds DELETE, DROP, TRUNCATE" },
];

// A styled (non-native) dropdown for the access mode, reflecting the live armed mode.
// The app wires open/close on [data-mode-trigger]/[data-mode-menu] and selection on
// [data-mode-opt].
export function modeDropdown(mode: RiskMode, compact = false): string {
  const current = MODE_OPTIONS.find((m) => m.mode === mode) ?? MODE_OPTIONS[0];
  const options = MODE_OPTIONS.map((m) => {
    const sel = m.mode === mode;
    const check = sel ? `<span class="dd-check">${checkIcon}</span>` : "";
    return `<div class="dd-opt${sel ? " sel" : ""}" role="option" aria-selected="${sel}" data-mode-opt="${m.mode}">
              <span class="risk-dot ${m.risk}"></span>
              <div><div class="o-name">${m.name}</div><div class="o-allow">${m.allow}</div></div>
              ${check}
            </div>`;
  }).join("");
  return `<span class="mode-dd">
            <button class="dd-trigger${compact ? " compact" : ""}" type="button" data-mode-trigger aria-haspopup="listbox" aria-expanded="false">
              <span class="risk-dot ${current.risk}"></span>
              <span class="t-name">${current.name}</span>
              <span class="chev">${chevronDown}</span>
            </button>
            <div class="dd-menu" data-mode-menu role="listbox" hidden>${options}</div>
          </span>`;
}
