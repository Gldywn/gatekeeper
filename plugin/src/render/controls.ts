import { escapeHtml } from "../html";
import { checkIcon, chevronDown } from "../icons";

// A real, persisted toggle: an appearance:none checkbox styled as a track+knob. Its
// data-setting maps it to a Settings key; the app's delegated change handler persists it.
export function switchInput(setting: string, ariaLabel: string, checked: boolean): string {
  return `<input class="switch" type="checkbox" role="switch" data-setting="${setting}" aria-label="${escapeHtml(ariaLabel)}"${checked ? " checked" : ""} />`;
}

interface ModeOption {
  risk: "ro" | "rw" | "full";
  name: string;
  allow: string;
  current: boolean;
}

// Only read-only is available today; the others preview the planned escalation, dimmed
// and unselectable, since read-only is enforced regardless (isReadOnlyQuery).
const MODE_OPTIONS: ModeOption[] = [
  { risk: "ro", name: "Read-only", allow: "SELECT only", current: true },
  { risk: "rw", name: "Write", allow: "adds INSERT, UPDATE", current: false },
  { risk: "full", name: "Destructive", allow: "adds DELETE, DROP, TRUNCATE", current: false },
];

const CURRENT_MODE = MODE_OPTIONS.find((m) => m.current) ?? MODE_OPTIONS[0];

// A styled (non-native) dropdown for the access mode; display-only, the app wires
// open/close on [data-mode-trigger]/[data-mode-menu].
export function modeDropdown(compact = false): string {
  const options = MODE_OPTIONS.map((m) => {
    const check = m.current ? `<span class="dd-check">${checkIcon}</span>` : "";
    return `<div class="dd-opt${m.current ? " sel" : " off"}" role="option" aria-selected="${m.current}"${m.current ? "" : ' aria-disabled="true"'}>
              <span class="risk-dot ${m.risk}"></span>
              <div><div class="o-name">${m.name}</div><div class="o-allow">${m.allow}</div></div>
              ${check}
            </div>`;
  }).join("");
  return `<span class="mode-dd">
            <button class="dd-trigger${compact ? " compact" : ""}" type="button" data-mode-trigger aria-haspopup="listbox" aria-expanded="false">
              <span class="risk-dot ${CURRENT_MODE.risk}"></span>
              <span class="t-name">${CURRENT_MODE.name}</span>
              <span class="chev">${chevronDown}</span>
            </button>
            <div class="dd-menu" data-mode-menu role="listbox" hidden>${options}</div>
          </span>`;
}
