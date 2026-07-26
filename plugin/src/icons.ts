import { svg as claudeSvg } from "@thesvg/icons/anthropic";
import { svg as geminiSvg } from "@thesvg/icons/google-gemini";
import { svg as codexSvg } from "@thesvg/icons/openai";
import { svg as opencodeSvg } from "@thesvg/icons/opencode";

// Neutral mark for an unrecognised harness. Every icon renders in currentColor
// (the CSS forces fill), so they inherit the badge colour rather than brand hues.
const PLACEHOLDER = `<svg viewBox="0 0 20 22" aria-hidden="true"><polygon points="10,1.2 18.7,6.1 18.7,15.9 10,20.8 1.3,15.9 1.3,6.1" opacity="0.55"/></svg>`;

const MARKS: Record<string, string> = {
  claude: claudeSvg,
  codex: codexSvg,
  opencode: opencodeSvg,
  gemini: geminiSvg,
};
const BRANDS = ["claude", "codex", "opencode", "gemini"] as const;

export function harnessIcon(harness: string | null): string {
  const key = (harness ?? "").toLowerCase();
  for (const brand of BRANDS) {
    if (key.includes(brand)) {
      return MARKS[brand];
    }
  }
  return PLACEHOLDER;
}
