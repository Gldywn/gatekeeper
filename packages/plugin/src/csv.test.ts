import { describe, expect, it } from "vitest";
import { csvFormulaGuard, csvQuote } from "./csv";

describe("csvFormulaGuard", () => {
  it("prefixes a leading formula trigger", () => {
    for (const v of ["=1+1", "+1", "-1", "@x", "=cmd|' /C calc'"]) {
      expect(csvFormulaGuard(v), v).toBe(`'${v}`);
    }
  });

  it("prefixes a trigger hidden behind leading whitespace, tab, or CR", () => {
    for (const v of [" =1+1", "\t=1", "\r=1", "  @x"]) {
      expect(csvFormulaGuard(v), JSON.stringify(v)).toBe(`'${v}`);
    }
  });

  it("leaves a genuine non-trigger cell alone", () => {
    for (const v of ["hello", "a=b", "SELECT 1", "café"]) {
      expect(csvFormulaGuard(v), v).toBe(v);
    }
  });
});

describe("csvQuote", () => {
  it("doubles quotes and wraps a field carrying a comma, quote, or newline", () => {
    expect(csvQuote('a"b')).toBe('"a""b"');
    expect(csvQuote("a,b")).toBe('"a,b"');
    expect(csvQuote("plain")).toBe("plain");
  });
});
