import { describe, expect, it } from "vitest";
import type { HistResult } from "../result";
import { resultCsv, resultJson, resultMarkdown } from "./resultexport";

// A result spanning every cell type: numbers (one negative), a string with CSV metachars,
// booleans, a nested object and array, and a SQL null.
const result: HistResult = {
  fields: [
    { name: "id" },
    { name: "name" },
    { name: "active" },
    { name: "meta" },
    { name: "note" },
  ],
  rows: [
    { id: 1, name: "Acme", active: true, meta: { tier: "gold" }, note: "hi" },
    { id: -5, name: 'a,b"c', active: false, meta: [1, 2], note: null },
  ],
  rowCount: 2,
  truncated: false,
};

describe("render/resultexport", () => {
  it("exports CSV: BOM, RFC-4180 quoting, inlined JSON, and a NEGATIVE NUMBER stays -5", () => {
    expect(resultCsv(result)).toBe(
      "﻿id,name,active,meta,note\r\n" +
        '1,Acme,true,"{""tier"":""gold""}",hi\r\n' +
        '-5,"a,b""c",false,"[1,2]",\r\n',
    );
  });

  it("formula-guards a string cell but never a numeric one", () => {
    const r: HistResult = {
      fields: [{ name: "expr" }, { name: "n" }],
      rows: [{ expr: "=SUM(A1:A2)", n: -5 }],
      rowCount: 1,
      truncated: false,
    };
    // The string gains a leading ', the negative number does not.
    expect(resultCsv(r)).toContain("'=SUM(A1:A2),-5");
  });

  it("maps a missing cell to blank in CSV and null in JSON", () => {
    const r: HistResult = {
      fields: [{ name: "a" }, { name: "b" }],
      rows: [{ a: 1 }],
      rowCount: 1,
      truncated: false,
    };
    expect(resultCsv(r)).toBe("﻿a,b\r\n1,\r\n");
    expect(JSON.parse(resultJson(r))).toEqual([{ a: 1, b: null }]);
  });

  it("exports a Markdown table: pipes escaped and newlines collapsed", () => {
    const r: HistResult = {
      fields: [{ name: "col" }, { name: "note" }],
      rows: [{ col: "a|b", note: "line1\nline2" }],
      rowCount: 1,
      truncated: false,
    };
    expect(resultMarkdown(r)).toBe("| col | note |\n| --- | --- |\n| a\\|b | line1 line2 |\n");
  });

  it("exports a Markdown table over mixed cell types in column order", () => {
    expect(resultMarkdown(result)).toBe(
      "| id | name | active | meta | note |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        '| 1 | Acme | true | {"tier":"gold"} | hi |\n' +
        '| -5 | a,b"c | false | [1,2] |  |\n',
    );
  });

  it("exports JSON: an array of native-typed row objects keyed in column order", () => {
    const json = resultJson(result);
    expect(JSON.parse(json)).toEqual([
      { id: 1, name: "Acme", active: true, meta: { tier: "gold" }, note: "hi" },
      { id: -5, name: 'a,b"c', active: false, meta: [1, 2], note: null },
    ]);
    // Pretty-printed, keys following resultColumns() order, one trailing newline.
    expect(json.startsWith("[\n  {\n")).toBe(true);
    expect(json.endsWith("\n")).toBe(true);
    expect(json.indexOf('"id"')).toBeLessThan(json.indexOf('"name"'));
  });
});
