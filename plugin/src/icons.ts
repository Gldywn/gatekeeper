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
