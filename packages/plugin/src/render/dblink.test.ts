import { describe, expect, it } from "vitest";
import { type DbCheck, dbLink, dbLinkLabel, dbStatusHtml, nextCheckText } from "./dblink";

const base: DbCheck = { supported: true, checkedAt: 1000, failures: 0, error: null };

describe("dbLink", () => {
  it("is none for an engine with no check, whatever was recorded", () => {
    expect(dbLink({ ...base, supported: false, failures: 5 })).toBe("none");
  });

  it("is pending until a check completes", () => {
    expect(dbLink({ ...base, checkedAt: 0 })).toBe("pending");
  });

  it("goes passed, then failed for one or two failures, then failing from the third", () => {
    expect(dbLink(base)).toBe("passed");
    expect(dbLink({ ...base, failures: 1 })).toBe("failed");
    expect(dbLink({ ...base, failures: 2 })).toBe("failed");
    expect(dbLink({ ...base, failures: 3 })).toBe("failing");
    expect(dbLink({ ...base, failures: 40 })).toBe("failing");
  });
});

describe("dbStatusHtml", () => {
  it("names the engine when it has no check", () => {
    const html = dbStatusHtml({ ...base, supported: false }, "SQLite");
    expect(html).toContain('class="db-note"');
    expect(html).toContain("This feature is not available on SQLite.");
  });

  it("renders nothing before the first check completes", () => {
    expect(dbStatusHtml({ ...base, checkedAt: 0 }, "PostgreSQL")).toBe("");
  });

  it("shows a passed check with no error box", () => {
    const html = dbStatusHtml({ ...base, error: "stale" }, "PostgreSQL");
    expect(html).toContain('class="db-status passed"');
    expect(html).toContain("Last check passed");
    expect(html).not.toContain("db-err");
  });

  it("shows the escaped driver error under a failed check", () => {
    const html = dbStatusHtml({ ...base, failures: 1, error: "<b>refused</b>" }, "PostgreSQL");
    expect(html).toContain('class="db-status failed"');
    expect(html).toContain("Last check failed");
    expect(html).toContain('<span class="db-err">&lt;b&gt;refused&lt;/b&gt;</span>');
  });

  it("counts the failures in a row once failing, and caps a long error", () => {
    const html = dbStatusHtml({ ...base, failures: 4, error: "x".repeat(500) }, "PostgreSQL");
    expect(html).toContain('class="db-status failing"');
    expect(html).toContain("4 checks failed in a row");
    expect(html).toContain(`>${"x".repeat(200)}<`);
  });
});

describe("dbLinkLabel", () => {
  it("names the state in words, since the dot only says it in colour", () => {
    expect(dbLinkLabel({ ...base, supported: false }, "SQLite")).toBe(
      "No database check on SQLite",
    );
    expect(dbLinkLabel({ ...base, checkedAt: 0 }, "PostgreSQL")).toBe("Database check pending");
    expect(dbLinkLabel(base, "PostgreSQL")).toBe("Database check passed");
    expect(dbLinkLabel({ ...base, failures: 2 }, "PostgreSQL")).toBe("Database check failed");
    expect(dbLinkLabel({ ...base, failures: 5 }, "PostgreSQL")).toBe(
      "5 database checks failed in a row",
    );
  });
});

describe("nextCheckText", () => {
  it("counts down in whole seconds, then says shortly once due", () => {
    expect(nextCheckText(15_000, 1_000)).toBe("Checking again in 14s.");
    expect(nextCheckText(15_000, 14_500)).toBe("Checking again in 1s.");
    expect(nextCheckText(15_000, 15_000)).toBe("Checking again shortly.");
  });
});
