import { describe, expect, it } from "vitest";
import { capResult } from "./result";

describe("capResult", () => {
  it("keeps a result within budget intact and caches its byte size", () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const r = capResult(rows, [{ name: "a" }]);
    expect(r.rows).toEqual(rows);
    expect(r.rowCount).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.bytes).toBe(JSON.stringify(rows).length);
  });

  it("shrinks to fit an explicit byte budget and flags truncation", () => {
    const big = "x".repeat(20_000);
    const rows = Array.from({ length: 200 }, () => ({ blob: big }));
    const r = capResult(rows, [{ name: "blob" }], 512 * 1024);
    expect(r.rows.length).toBeLessThan(200);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(512 * 1024);
  });

  it("caps at the hard row ceiling regardless of budget", () => {
    const rows = Array.from({ length: 100_001 }, (_, i) => ({ i }));
    const r = capResult(rows, [{ name: "i" }], Number.MAX_SAFE_INTEGER);
    expect(r.rows).toHaveLength(100_000);
    expect(r.rowCount).toBe(100_001);
    expect(r.truncated).toBe(true);
  });

  it("preserves the true row count even when truncated", () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ i }));
    expect(capResult(rows, [], 64).rowCount).toBe(250);
  });

  it("applies a tighter explicit row cap for the agent-bound path", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ i }));
    const r = capResult(rows, [{ name: "i" }], Number.MAX_SAFE_INTEGER, 1000);
    expect(r.rows).toHaveLength(1000);
    expect(r.rowCount).toBe(5000);
    expect(r.truncated).toBe(true);
  });
});
