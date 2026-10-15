import type { RunQueryResult } from "@beekeeperstudio/plugin";
import { describe, expect, it } from "vitest";
import type { RunState } from "../types";
import {
  newStopToken,
  readStop,
  serverVersion,
  stopNote,
  stopStatement,
  stopTag,
  stopUnavailable,
} from "./stop";

const rows = (...r: Record<string, unknown>[]) =>
  ({ results: [{ rows: r, fields: [] }] }) as unknown as RunQueryResult;

describe("stop tag", () => {
  it("carries the request id and a fresh token", () => {
    const token = newStopToken();
    expect(token).toMatch(/^[0-9a-f]{12}$/);
    expect(newStopToken()).not.toBe(token);
    expect(stopTag("req_0123456789ab", token)).toBe(`/* gatekeeper req_0123456789ab ${token} */`);
  });

  it("leaves out a request id it cannot vouch for", () => {
    expect(stopTag("req_x */ DROP TABLE t; --", "0123456789ab")).toBe(
      "/* gatekeeper 0123456789ab */",
    );
  });

  it("builds a stop statement around nothing but a tag", () => {
    expect(() => stopStatement("postgresql", "/* gatekeeper 0123456789ab */ OR 1=1")).toThrow();
    expect(() => stopStatement("mysql", "x' OR '1'='1")).toThrow();
  });
});

describe("where stopping is available", () => {
  it.each([
    ["postgresql", false, null, null],
    ["postgresql", true, null, null],
    ["mysql", false, "8.0.19", null],
    ["mysql", false, "8.4.2-0ubuntu0.24.04.1", null],
    ["mysql", false, "8.0.18", "This feature is not available on MySQL 8.0.18."],
    ["mysql", false, "5.7.44-log", "This feature is not available on MySQL 5.7.44."],
    ["mysql", false, "10.11.6-MariaDB", "This feature is not available on MariaDB."],
    ["mysql", false, "8.0.11-TiDB-v7.5.0", "This feature is not available on TiDB."],
    ["mysql", false, null, "This feature is not available on this MySQL server."],
    ["mysql", true, "8.4.0", "This feature is not available on read-only MySQL connections."],
    ["sqlite", false, null, "This feature is not available on SQLite."],
  ])("%s, read-only %s, version %s", (type, readOnly, version, expected) => {
    expect(stopUnavailable(type, "SQLite", readOnly, version)).toBe(expected);
  });

  it("reads the server version and fails closed", async () => {
    expect(await serverVersion(async () => rows({ version: "8.0.36" }))).toBe("8.0.36");
    expect(
      await serverVersion(async () => ({ results: [], error: "denied" }) as RunQueryResult),
    ).toBeNull();
    expect(
      await serverVersion(async () => {
        throw new Error("host down");
      }),
    ).toBeNull();
  });
});

describe("stop statement", () => {
  const tag = stopTag("req_0123456789ab", "a1b2c3d4e5f6");

  it("PostgreSQL: one statement that signals only a single active session of this role", () => {
    const sql = stopStatement("postgresql", tag);
    expect(sql).not.toContain(";");
    expect(sql).toContain("CASE WHEN count(*) = 1 THEN pg_cancel_backend(min(pid)) END AS sent");
    expect(sql).toContain("state = 'active' AND usename = current_user");
    expect(sql).toContain("pid <> pg_backend_pid()");
    expect(sql).toContain(`left(query, ${tag.length}) = '${tag}'`);
  });

  it("MySQL: one call that kills the current statement of a single match, never a connection", () => {
    const sql = stopStatement("mysql", tag);
    expect(sql).toContain(`LEFT(INFO, ${tag.length}) = '${tag}'`);
    expect(sql).toContain("ID <> CONNECTION_ID() AND USER = SUBSTRING_INDEX(USER(), '@', 1)");
    expect(sql).toContain("IF(@gk_matches = 1, CONCAT('KILL QUERY ', @gk_target), 'DO 0')");
    expect(sql).not.toMatch(/KILL (CONNECTION|\d)/);
    expect(sql).toMatch(/SET @gk_matches := NULL, @gk_target := NULL, @gk_stop := NULL$/);
  });
});

describe("reading the answer", () => {
  it.each([
    ["postgresql", rows({ sent: true, matches: "1" }), { kind: "sent" }],
    ["postgresql", rows({ sent: null, matches: "0" }), { kind: "notFound" }],
    [
      "postgresql",
      rows({ sent: null, matches: "2" }),
      { kind: "error", message: "2 running queries matched" },
    ],
    [
      "postgresql",
      rows({ sent: false, matches: "1" }),
      { kind: "error", message: "pg_cancel_backend returned false" },
    ],
    [
      "postgresql",
      { results: [], error: { message: "permission denied to cancel query" } },
      { kind: "error", message: "permission denied to cancel query" },
    ],
    ["postgresql", rows(), { kind: "error", message: "Unexpected answer to the stop request" }],
    [
      "mysql",
      {
        results: [
          { rows: [], fields: [] },
          { rows: [{ matches: 1 }], fields: [] },
        ],
      },
      { kind: "sent" },
    ],
    [
      "mysql",
      {
        results: [
          { rows: [], fields: [] },
          { rows: [{ matches: 0 }], fields: [] },
        ],
      },
      { kind: "notFound" },
    ],
  ] as const)("%s %j", (engine, result, outcome) => {
    expect(readStop(engine, result as unknown as RunQueryResult)).toEqual(outcome);
  });
});

describe("what the agent and the history receive", () => {
  const run: RunState = { startedAt: 0, limitMs: 300_000, ended: true };
  const stop = { state: "sent", inFlight: false, attempts: 1 } as const;

  it("passes the database error through when nobody asked for a stop", () => {
    expect(stopNote(run, "relation does not exist")).toBe("relation does not exist");
  });

  it("states who asked and when, then the database's own words", () => {
    expect(
      stopNote(
        { ...run, stop: { ...stop, by: "operator", atMs: 118_000 } },
        "canceling statement due to user request",
      ),
    ).toBe(
      "Stop requested by the operator after 1m 58s. The query then ended with: canceling statement due to user request",
    );
    expect(stopNote({ ...run, stop: { ...stop, by: "operator", atMs: 47_000 } }, "x")).toBe(
      "Stop requested by the operator after 47s. The query then ended with: x",
    );
    expect(stopNote({ ...run, stop: { ...stop, by: "limit", atMs: 300_000 } }, "x")).toBe(
      "Stop requested by auto-stop at the 5 min limit set on this connection. The query then ended with: x",
    );
  });
});
