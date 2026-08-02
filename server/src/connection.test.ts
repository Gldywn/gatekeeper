import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectionScopeKey, SCOPE_SEP } from "./connection.js";
import { RequestStore } from "./store.js";

describe("connectionScopeKey", () => {
  it("joins name, engine, and database into one debuggable, non-hashed key", () => {
    const key = connectionScopeKey({
      connectionName: "gatekeeper_test",
      databaseType: "postgresql",
      databaseName: "app",
    });
    // Plain and readable: every part survives, joined by the unit separator.
    expect(key).toBe(`gatekeeper_test${SCOPE_SEP}postgresql${SCOPE_SEP}app`);
    expect(key.split(SCOPE_SEP)).toEqual(["gatekeeper_test", "postgresql", "app"]);
  });

  it("distinguishes a shared display name across engines or databases", () => {
    const pg = connectionScopeKey({
      connectionName: "gatekeeper_test",
      databaseType: "postgresql",
      databaseName: "gatekeeper_test",
    });
    const my = connectionScopeKey({
      connectionName: "gatekeeper_test",
      databaseType: "mysql",
      databaseName: "gatekeeper_test",
    });
    const otherDb = connectionScopeKey({
      connectionName: "gatekeeper_test",
      databaseType: "postgresql",
      databaseName: "analytics",
    });
    expect(pg).not.toBe(my);
    expect(pg).not.toBe(otherDb);
  });

  it("percent-encodes to a header-safe value that round-trips", () => {
    const key = connectionScopeKey({
      connectionName: "prod",
      databaseType: "postgresql",
      databaseName: "app",
    });
    const header = encodeURIComponent(key);
    // The separator is a control char that Node rejects raw in a header; encoded, every
    // character is printable ASCII, and it decodes back to the exact key.
    expect([...header].every((c) => c.charCodeAt(0) >= 0x20)).toBe(true);
    expect(decodeURIComponent(header)).toBe(key);
  });
});

describe("connection snapshot", () => {
  it("is null until the plugin reports", () => {
    expect(new RequestStore({ now: () => 1000 }).getConnection()).toBeNull();
  });

  it("captures only the whitelisted fields with a timestamp", () => {
    const store = new RequestStore({ now: () => 1000 });
    store.setConnection({
      connectionName: "prod",
      databaseType: "postgresql",
      databaseName: "app",
      schema: "public",
      readOnly: true,
      // an unexpected field (e.g. a credential) must be dropped
      password: "secret",
    });
    expect(store.getConnection()).toEqual({
      connectionName: "prod",
      databaseType: "postgresql",
      databaseName: "app",
      schema: "public",
      readOnly: true,
      capturedAt: 1000,
    });
  });

  it("coerces missing or wrong-typed fields safely", () => {
    const store = new RequestStore({ now: () => 5 });
    store.setConnection({ databaseType: 123, readOnly: "yes" });
    expect(store.getConnection()).toEqual({
      connectionName: "",
      databaseType: "",
      databaseName: "",
      schema: null,
      readOnly: false,
      capturedAt: 5,
    });
  });

  it("is visible across processes (two connections, one file)", () => {
    const path = join(tmpdir(), `gk-conn-${Math.random().toString(36).slice(2)}.db`);
    const writer = new RequestStore({ path, now: () => 42 });
    const reader = new RequestStore({ path, now: () => 99 });
    try {
      writer.setConnection({ databaseType: "mysql", databaseName: "shop", readOnly: true });
      const seen = reader.getConnection();
      expect(seen?.databaseType).toBe("mysql");
      expect(seen?.databaseName).toBe("shop");
      expect(seen?.capturedAt).toBe(42);
    } finally {
      writer.close();
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });
});
