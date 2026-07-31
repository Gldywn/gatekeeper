import { escapeHtml } from "../html";
import { lockIcon } from "../icons";

// A real, persisted toggle: an appearance:none checkbox styled as a track+knob. Its
// data-setting maps it to a Settings key; the app's delegated change handler persists it.
export function switchInput(setting: string, ariaLabel: string, checked: boolean): string {
  return `<input class="switch" type="checkbox" role="switch" data-setting="${setting}" aria-label="${escapeHtml(ariaLabel)}"${checked ? " checked" : ""} />`;
}

const LOCKED_TITLE =
  "Locked on. Gatekeeper only runs read-only SELECT. Armed write access is planned.";

// The read-only mode control, pinned on and unflippable: the single place the
// read-only (vs future armed-write) mode is expressed, so nothing else offers a write toggle.
export function lockedReadOnlySwitch(): string {
  return `<span class="switch-lock" aria-hidden="true">${lockIcon}</span><input class="switch locked" type="checkbox" role="switch" checked disabled aria-label="${escapeHtml(LOCKED_TITLE)}" title="${escapeHtml(LOCKED_TITLE)}" />`;
}
