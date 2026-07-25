import { describe, expect, it } from "vitest";
import { capResult, cell } from "./result";

describe("capResult", () => {
  it("keeps small results intact", () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const r = capResult(rows, [{ name: "a" }]);
    expect(r.rows).toEqual(rows);
    expect(r.rowCount).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it("caps to 200 rows and flags truncation", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ i }));
    const r = capResult(rows, [{ name: "i" }]);
    expect(r.rows).toHaveLength(200);
    expect(r.rowCount).toBe(500);
    expect(r.truncated).toBe(true);
  });

  it("shrinks further when the serialized payload exceeds the byte budget", () => {
    const big = "x".repeat(20_000);
    const rows = Array.from({ length: 200 }, () => ({ blob: big }));
    const r = capResult(rows, [{ name: "blob" }]);
    expect(r.rows.length).toBeLessThan(200);
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r.rows).length).toBeLessThanOrEqual(512 * 1024);
  });

  it("preserves the true row count even when truncated", () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ i }));
    expect(capResult(rows, []).rowCount).toBe(250);
  });
});

describe("cell", () => {
  it("renders null and undefined as NULL", () => {
    expect(cell(null)).toBe("NULL");
    expect(cell(undefined)).toBe("NULL");
  });

  it("serializes objects and arrays", () => {
    expect(cell({ a: 1 })).toBe('{"a":1}');
    expect(cell([1, 2])).toBe("[1,2]");
  });

  it("coerces primitives to a string", () => {
    expect(cell(42)).toBe("42");
    expect(cell(true)).toBe("true");
    expect(cell("hi")).toBe("hi");
  });
});
