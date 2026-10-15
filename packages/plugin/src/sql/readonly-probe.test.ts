import type { RunQueryResult } from "@beekeeperstudio/plugin";
import { describe, expect, it, vi } from "vitest";
import { hasProbe, probeReadOnly } from "./readonly-probe";

function ok(row: Record<string, unknown>): RunQueryResult {
  return { results: [{ fields: [], rows: [row] }] };
}

describe("probeReadOnly", () => {
  it("reads replica and session_read_only from row 0 of the Postgres probe", async () => {
    const run = vi.fn(async () => ok({ replica: true, session_read_only: false }));
    expect(await probeReadOnly("postgresql", run)).toEqual({
      readOnly: { replica: true, sessionReadOnly: false },
    });
    expect(run).toHaveBeenCalledWith(
      "SELECT pg_is_in_recovery() AS replica, current_setting('transaction_read_only') = 'on' AS session_read_only",
    );
  });

  it("reports a read-only session even off a primary", async () => {
    const run = vi.fn(async () => ok({ replica: false, session_read_only: true }));
    expect(await probeReadOnly("postgresql", run)).toEqual({
      readOnly: { replica: false, sessionReadOnly: true },
    });
  });

  it("coerces driver truthy encodings ('t', 1) to booleans, others to false", async () => {
    const run = vi.fn(async () => ok({ replica: "t", session_read_only: 0 }));
    expect(await probeReadOnly("postgresql", run)).toEqual({
      readOnly: { replica: true, sessionReadOnly: false },
    });
  });

  it("returns the driver's message when runQuery surfaces an error", async () => {
    const run = vi.fn(async () => ({ results: [], error: { message: "permission denied" } }));
    expect(await probeReadOnly("postgresql", run)).toEqual({ error: "permission denied" });
  });

  it("returns the thrown message when the host call rejects", async () => {
    const run = vi.fn(async () => {
      throw new Error("connection down");
    });
    expect(await probeReadOnly("postgresql", run)).toEqual({ error: "connection down" });
  });

  it("fails the check when no row comes back", async () => {
    const run = vi.fn(
      async (): Promise<RunQueryResult> => ({ results: [{ fields: [], rows: [] }] }),
    );
    expect(await probeReadOnly("postgresql", run)).toEqual({
      error: "The check returned no row",
    });
  });

  it.each(["sqlite", "oracle", "redshift", "clickhouse", "toString"])(
    "has no check for %s and never queries it",
    async (type) => {
      const run = vi.fn(async () => ok({ replica: true, session_read_only: true }));
      expect(hasProbe(type)).toBe(false);
      expect(await probeReadOnly(type, run)).toBeNull();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("reads both global read-only flags off the MySQL probe", async () => {
    const run = vi.fn(async () => ok({ read_only: 0, super_read_only: 1 }));
    expect(await probeReadOnly("mysql", run)).toEqual({
      readOnly: { replica: true, sessionReadOnly: false },
    });
    expect(run).toHaveBeenCalledWith(
      "SELECT @@global.read_only AS read_only, @@global.super_read_only AS super_read_only",
    );
  });

  it("reports a writable MySQL primary as not read-only", async () => {
    const run = vi.fn(async () => ok({ read_only: 0, super_read_only: 0 }));
    expect(await probeReadOnly("mysql", run)).toEqual({
      readOnly: { replica: false, sessionReadOnly: false },
    });
  });

  it("asks MariaDB for read_only alone, since it has no super_read_only", async () => {
    const run = vi.fn(async () => ok({ read_only: 1 }));
    expect(await probeReadOnly("mariadb", run)).toEqual({
      readOnly: { replica: true, sessionReadOnly: false },
    });
    expect(run).toHaveBeenCalledWith("SELECT @@global.read_only AS read_only");
    run.mockResolvedValueOnce(ok({ read_only: 0 }));
    expect(await probeReadOnly("mariadb", run)).toEqual({
      readOnly: { replica: false, sessionReadOnly: false },
    });
  });

  it("passes a MariaDB error through", async () => {
    const run = vi.fn(async () => ({ results: [], error: "Lost connection to server" }));
    expect(await probeReadOnly("mariadb", run)).toEqual({ error: "Lost connection to server" });
  });
});
