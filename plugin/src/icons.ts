import { svg as claudeSvg } from "@thesvg/icons/claude-code";
import { svg as codexSvg } from "@thesvg/icons/codex";
import { svg as geminiSvg } from "@thesvg/icons/gemini";
import { svg as kimiSvg } from "@thesvg/icons/kimi";
import { svg as opencodeSvg } from "@thesvg/icons/opencode";

// Neutral mark for an unrecognised harness. Every icon renders in currentColor
// (the CSS forces fill), so they inherit the badge colour rather than brand hues.
const PLACEHOLDER = `<svg viewBox="0 0 20 22" aria-hidden="true"><polygon points="10,1.2 18.7,6.1 18.7,15.9 10,20.8 1.3,15.9 1.3,6.1" opacity="0.55"/></svg>`;

const MARKS: Record<string, string> = {
  claude: claudeSvg,
  codex: codexSvg,
  opencode: opencodeSvg,
  gemini: geminiSvg,
  kimi: kimiSvg,
};
// The harness is the MCP client name (claude-code, codex, opencode, gemini). kimi
// is kept for the day a harness reports its sub-model; MCP does not expose it today.
const BRANDS = ["claude", "codex", "opencode", "gemini", "kimi"] as const;

export function harnessIcon(harness: string | null): string {
  const key = (harness ?? "").toLowerCase();
  for (const brand of BRANDS) {
    if (key.includes(brand)) {
      return MARKS[brand];
    }
  }
  return PLACEHOLDER;
}

// Lucide "chevron-down" (lucide.dev, ISC License), inlined for the strict CSP.
// It is a stroke icon (not filled), rotated -90deg by CSS for the collapsed state.
export const chevronDown = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

// Lucide "copy" (lucide.dev, ISC License), inlined for the strict CSP.
export const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

// Lucide "check" (lucide.dev, ISC License), shown briefly after a copy.
export const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

// Lucide "shield-alert" (lucide.dev, ISC License), the possible-PII flag.
export const warnIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;

// Lucide "shield-check" (lucide.dev, ISC License), the read-only guarantee mark.
export const shieldCheckIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`;

// Lucide "shield-question" (lucide.dev, ISC License), the unknown read-only layer.
export const shieldQuestionIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`;

// Lucide "history" (lucide.dev, ISC License), the activity-log trigger.
export const historyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>`;

// Lucide "download" (lucide.dev, ISC License), the per-session markdown export.
export const downloadIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`;

// Lucide "pencil" (lucide.dev, ISC License), opens the ask-the-agent-to-revise field.
export const pencilIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;

// Lucide "corner-down-left" (lucide.dev, ISC License), the send / Enter affordance.
export const sendIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`;

// Distinguishes the client-confidentiality flag from the person-PII shield.
export const buildingIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>`;

// The reject-with-a-note action: a message the human sends the agent.
export const messageIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

// Lucide "settings" (lucide.dev, ISC License), the header settings gear.
export const gearIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

// External-link glyph: the popover footer's hook to the full-settings overlay.
export const externalLinkIcon = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h4v4"/><path d="M13 3l-6 6"/><path d="M11 9v3.5H3.5V4.5H7"/></svg>`;

// Lucide "flask-conical" (lucide.dev, ISC License), the developer-mode mark. A
// stroke icon (not filled), so it renders outside the fill-forcing .harness-badge.
export const flaskIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/></svg>`;

// The left agent icon: the flask for the synthetic dev-mode session (stroke, so it rides
// .dev-flask not the fill-forcing badge), else the harness mark in .harness-badge.
export function agentBadge(harness: string | null): string {
  return (harness ?? "").toLowerCase().includes("dev-mode")
    ? `<span class="dev-flask">${flaskIcon}</span>`
    : `<span class="harness-badge">${harnessIcon(harness)}</span>`;
}

// The connection target: a database cylinder leading the header chip.
export const dbCylinderIcon = `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/></svg>`;

// The "reads" label cylinder in the schema annotation; classless so it takes only
// the local .cs-reads-k sizing, not the header chip's .ico styling.
export const dbReadsIcon = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/></svg>`;

// Lucide "circle-x" (lucide.dev, ISC License), the failed-outcome mark.
export const xCircleIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`;

// Lucide "x" (lucide.dev, ISC License), the header armed-banner disarm affordance.
export const xIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

// Lucide "clock" (lucide.dev, ISC License), the expired-outcome mark.
export const clockIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;

// Lucide "chevron-left"/"chevron-right" (lucide.dev, ISC License), the result pager.
export const chevronLeft = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`;
export const chevronRight = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
