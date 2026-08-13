import { describe, expect, it } from "vitest";
import { visibleControls } from "./sanitize";

const marker = (cp: number) => `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]`;

describe("visibleControls", () => {
  it("surfaces a bidi override that would reorder the reviewer's view", () => {
    const rlo = String.fromCodePoint(0x202e);
    const out = visibleControls(`SELECT 1 -- ${rlo}evil`);
    expect(out).not.toContain(rlo);
    expect(out).toContain("[U+202E]");
  });

  it("surfaces zero-width, isolate, and BOM characters", () => {
    for (const cp of [0x200b, 0x200f, 0x061c, 0x2066, 0x2069, 0x2060, 0xfeff]) {
      expect(visibleControls(`a${String.fromCodePoint(cp)}b`)).toBe(`a${marker(cp)}b`);
    }
  });

  it("leaves ordinary SQL with tabs and newlines untouched", () => {
    const sql = "SELECT *\n\tFROM users\nWHERE id = 1";
    expect(visibleControls(sql)).toBe(sql);
  });
});
