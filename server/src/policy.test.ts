import { describe, expect, it } from "vitest";
import { assessReadOnly } from "./policy.js";

const cases: Array<[string, boolean]> = [
  ["SELECT 1", true],
  ["select * from users", true],
  ["  SELECT 1  ", true],
  ["WITH t AS (SELECT 1) SELECT * FROM t", true],
  ["SELECT 1;", true],
  ["/* note */ SELECT 1", true],
  ["DELETE FROM users", false],
  ["UPDATE users SET x = 1", false],
  ["INSERT INTO t VALUES (1)", false],
  ["DROP TABLE t", false],
  ["SELECT 1; DROP TABLE t", false],
  ["", false],
  ["   ", false],
  ["-- SELECT 1\nDELETE FROM t", false],
];

describe("assessReadOnly", () => {
  it.each(cases)("%s -> readOnly=%s", (sql, expected) => {
    expect(assessReadOnly(sql).readOnly).toBe(expected);
  });

  it("fails closed on a semicolon inside a string literal (known limitation)", () => {
    expect(assessReadOnly("SELECT 'a;b'").readOnly).toBe(false);
  });
});
