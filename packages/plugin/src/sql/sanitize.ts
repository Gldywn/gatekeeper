// Bidi overrides and invisible formatting chars let submitted SQL render in an order the
// reviewer never approved (trojan source). Surface them so the human sees what was hidden.
// Tab (0x09), newline (0x0a), and carriage return (0x0d) are intentionally left intact.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
];

function isInvisible(cp: number): boolean {
  return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

// The executed SQL (card.sql) is never touched; only its display and exports are.
export function visibleControls(sql: string): string {
  let out = "";
  for (const ch of sql) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isInvisible(cp) ? `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]` : ch;
  }
  return out;
}
