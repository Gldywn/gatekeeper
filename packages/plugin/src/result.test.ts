import { describe, expect, it } from "vitest";
import { capResult, RESULT_MAX_ROWS } from "./result";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("capResult", () => {
  it("keeps a result within budget intact", () => {
    const rows = [{ a: 1 }, { a: 2 }];
    expect(capResult(rows, [{ name: "a" }])).toEqual({
      fields: [{ name: "a" }],
      rows,
      rowCount: 2,
      truncated: false,
    });
  });

  it("shrinks the whole result to fit an explicit byte budget and flags truncation", () => {
    const big = "x".repeat(20_000);
    const rows = Array.from({ length: 200 }, () => ({ blob: big }));
    const r = capResult(rows, [{ name: "blob" }], 512 * 1024);
    expect(r.rows.length).toBeLessThan(200);
    expect(r.truncated).toBe(true);
    expect(bytes(r)).toBeLessThanOrEqual(512 * 1024);
  });

  it("counts UTF-8 bytes, so text outside ASCII fits fewer rows than its length suggests", () => {
    // 1,000 characters, 3,000 bytes each: by length 30 rows would fit 64 KB, by bytes far fewer.
    const rows = Array.from({ length: 30 }, () => ({ t: "€".repeat(1_000) }));
    const r = capResult(rows, [{ name: "t" }], 64 * 1024);
    expect(r.truncated).toBe(true);
    expect(bytes(r)).toBeLessThanOrEqual(64 * 1024);
    expect(r.rowCount).toBe(30);
  });

  it("keeps only the counts when the fields alone exceed the budget", () => {
    const fields = Array.from({ length: 100 }, (_, i) => ({ name: `${"c".repeat(100)}${i}` }));
    expect(capResult([{ a: 1 }], fields, 1_000, undefined, 4)).toEqual({
      fields: [],
      rows: [],
      rowCount: 1,
      truncated: true,
      affectedRows: 4,
    });
  });

  it("sends at most the agent's row cap by default", () => {
    const rows = Array.from({ length: RESULT_MAX_ROWS + 1 }, (_, i) => ({ i }));
    const r = capResult(rows, [{ name: "i" }]);
    expect(r.rows).toHaveLength(RESULT_MAX_ROWS);
    expect(r.rowCount).toBe(RESULT_MAX_ROWS + 1);
    expect(r.truncated).toBe(true);
  });

  it("preserves the true row count even when truncated", () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ i }));
    expect(capResult(rows, [], 64).rowCount).toBe(250);
  });
});
