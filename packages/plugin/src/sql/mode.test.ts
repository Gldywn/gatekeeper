import { describe, expect, it } from "vitest";
import { isApprovable, modeRank } from "./mode";

const pg = "postgresql";

describe("modeRank", () => {
  it("orders read < write < destructive", () => {
    expect(modeRank("read")).toBeLessThan(modeRank("write"));
    expect(modeRank("write")).toBeLessThan(modeRank("destructive"));
  });
});

describe("isApprovable", () => {
  it("approves a read in every mode", () => {
    for (const mode of ["read", "write", "destructive"] as const) {
      expect(isApprovable("SELECT 1", pg, mode), mode).toBe(true);
    }
  });

  it("gates a write behind write or destructive mode", () => {
    const sql = "INSERT INTO users (id) VALUES (1)";
    expect(isApprovable(sql, pg, "read")).toBe(false);
    expect(isApprovable(sql, pg, "write")).toBe(true);
    expect(isApprovable(sql, pg, "destructive")).toBe(true);
  });

  it("gates a destructive statement behind destructive mode only", () => {
    const sql = "DELETE FROM users";
    expect(isApprovable(sql, pg, "read")).toBe(false);
    expect(isApprovable(sql, pg, "write")).toBe(false);
    expect(isApprovable(sql, pg, "destructive")).toBe(true);
  });

  it("never approves a multi-statement query, even in destructive mode", () => {
    expect(isApprovable("SELECT 1; DROP TABLE t", pg, "destructive")).toBe(false);
  });

  // An unreadable statement takes the strictest class, so destructive is the only mode
  // that can approve it; the card warns that the class is a guess.
  it("lets only destructive mode approve an unparseable statement", () => {
    expect(isApprovable("VACUUM", pg, "read")).toBe(false);
    expect(isApprovable("VACUUM", pg, "write")).toBe(false);
    expect(isApprovable("VACUUM", pg, "destructive")).toBe(true);
  });

  it("never approves a multi-statement input, even in destructive mode", () => {
    expect(isApprovable("VACUUM users; DROP TABLE users", pg, "destructive")).toBe(false);
  });

  it("treats a write hidden in a read shape by its true class", () => {
    // INSERT ... SELECT needs write mode; read mode must not approve it.
    expect(isApprovable("INSERT INTO audit SELECT * FROM users", pg, "read")).toBe(false);
    expect(isApprovable("INSERT INTO audit SELECT * FROM users", pg, "write")).toBe(true);
  });
});
