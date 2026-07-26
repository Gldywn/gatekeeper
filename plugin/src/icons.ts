// Placeholder mark until the real @thesvg/icons brand SVGs are dropped into
// MARKS (keyed by harness substring). Icons use currentColor so CSS colours them.
const PLACEHOLDER = `<svg viewBox="0 0 20 22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><polygon points="10,1.2 18.7,6.1 18.7,15.9 10,20.8 1.3,15.9 1.3,6.1"/></svg>`;

const MARKS: Record<string, string> = {};
const BRANDS = ["claude", "codex", "opencode", "gemini"] as const;

export function harnessIcon(harness: string | null): string {
  const key = (harness ?? "").toLowerCase();
  for (const brand of BRANDS) {
    if (key.includes(brand) && MARKS[brand]) {
      return MARKS[brand];
    }
  }
  return PLACEHOLDER;
}
