import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

describe("highlight (pinned output for the Phase 2 rewrite)", () => {
  it("wraps SQL keywords in kw", () => {
    expect(highlight("SELECT id FROM users")).toBe(
      '<span class="kw">SELECT</span> id <span class="kw">FROM</span> users',
    );
  });

  it("wraps aggregate/function names in fn", () => {
    expect(highlight("SELECT count(id) FROM users")).toBe(
      '<span class="kw">SELECT</span> <span class="fn">count</span>(id) <span class="kw">FROM</span> users',
    );
  });

  it("wraps string literals in st", () => {
    expect(highlight("SELECT id FROM users WHERE name = 'bob'")).toBe(
      '<span class="kw">SELECT</span> id <span class="kw">FROM</span> users <span class="kw">WHERE</span> name = <span class="st">\'bob\'</span>',
    );
  });

  it("marks a pii column as pii-col", () => {
    expect(highlight("SELECT email FROM users", ["email"])).toBe(
      '<span class="kw">SELECT</span> <span class="pii-col">email</span> <span class="kw">FROM</span> users',
    );
  });

  it("marks a client column as client-col", () => {
    expect(highlight("SELECT company_name FROM accounts", undefined, ["company_name"])).toBe(
      '<span class="kw">SELECT</span> <span class="client-col">company_name</span> <span class="kw">FROM</span> accounts',
    );
  });

  it("flags a sensitive literal value as sensitive-val", () => {
    expect(
      highlight("SELECT id FROM users WHERE token = 'secret'", undefined, undefined, ["secret"]),
    ).toBe(
      '<span class="kw">SELECT</span> id <span class="kw">FROM</span> users <span class="kw">WHERE</span> token = <span class="st sensitive-val">\'secret\'</span>',
    );
  });

  it("marks a client column that is table-qualified", () => {
    expect(highlight("SELECT u.company_name FROM users u", undefined, ["company_name"])).toBe(
      '<span class="kw">SELECT</span> u.<span class="client-col">company_name</span> <span class="kw">FROM</span> users u',
    );
  });

  it("marks a pii column that is table-qualified", () => {
    expect(highlight("SELECT u.email FROM users u", ["email"])).toBe(
      '<span class="kw">SELECT</span> u.<span class="pii-col">email</span> <span class="kw">FROM</span> users u',
    );
  });

  it("composes pii, client, and sensitive-literal passes without corrupting each other", () => {
    expect(
      highlight(
        "SELECT email, company_name FROM users WHERE plan = 'enterprise'",
        ["email"],
        ["company_name"],
        ["enterprise"],
      ),
    ).toBe(
      '<span class="kw">SELECT</span> <span class="pii-col">email</span>, <span class="client-col">company_name</span> <span class="kw">FROM</span> users <span class="kw">WHERE</span> plan = <span class="st sensitive-val">\'enterprise\'</span>',
    );
  });

  it("keeps a backtick-quoted pii identifier flagged (MySQL)", () => {
    expect(highlight("SELECT `email` FROM users", ["email"])).toBe(
      '<span class="kw">SELECT</span> `<span class="pii-col">email</span>` <span class="kw">FROM</span> users',
    );
  });

  it("keeps a double-quoted client identifier flagged (ANSI/Postgres)", () => {
    expect(highlight('SELECT "company_name" FROM accounts', undefined, ["company_name"])).toBe(
      '<span class="kw">SELECT</span> &quot;<span class="client-col">company_name</span>&quot; <span class="kw">FROM</span> accounts',
    );
  });

  it("marks the key of a JSON accessor as the column it exposes", () => {
    expect(highlight("SELECT profile->>'email' FROM crm.people", ["email"])).toBe(
      '<span class="kw">SELECT</span> profile-&gt;&gt;\'<span class="pii-col">email</span>\' <span class="kw">FROM</span> crm.people',
    );
  });

  it("tints only the flagged segment of a JSON path", () => {
    expect(highlight("SELECT profile ->> '$.contact.email' FROM people", ["email"])).toBe(
      '<span class="kw">SELECT</span> profile -&gt;&gt; \'$.contact.<span class="pii-col">email</span>\' <span class="kw">FROM</span> people',
    );
    expect(
      highlight("SELECT profile#>>'{contact,company_name}' FROM crm.people", undefined, [
        "company_name",
      ]),
    ).toBe(
      '<span class="kw">SELECT</span> profile#&gt;&gt;\'{contact,<span class="client-col">company_name</span>}\' <span class="kw">FROM</span> crm.people',
    );
  });

  it("keeps a plain literal a value even when its text matches a flagged column", () => {
    expect(highlight("SELECT id FROM t WHERE note = 'email'", ["email"])).toBe(
      '<span class="kw">SELECT</span> id <span class="kw">FROM</span> t <span class="kw">WHERE</span> note = <span class="st">\'email\'</span>',
    );
  });

  it("leaves a quoted non-sensitive identifier untinted", () => {
    expect(highlight('SELECT "status" FROM t', ["email"], ["company_name"])).toBe(
      '<span class="kw">SELECT</span> &quot;status&quot; <span class="kw">FROM</span> t',
    );
  });
});
