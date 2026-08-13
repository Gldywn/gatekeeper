import { describe, expect, it } from "vitest";
import { connectionScopeKey, SCOPE_SEP } from "./scope";

describe("connectionScopeKey", () => {
  it("joins name, engine, and database into one debuggable, non-hashed key", () => {
    const key = connectionScopeKey({
      connectionName: "gatekeeper_test",
      databaseType: "postgresql",
      databaseName: "app",
    });
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
    // The separator is U+001F, a control char; the header must percent-encode the key to
    // printable ASCII and decode it back unchanged (Node rejects a raw control char).
    expect(SCOPE_SEP).toHaveLength(1);
    expect(SCOPE_SEP.charCodeAt(0)).toBe(0x1f);
    const key = connectionScopeKey({
      connectionName: "prod",
      databaseType: "postgresql",
      databaseName: "app",
    });
    const header = encodeURIComponent(key);
    expect([...header].every((c) => c.charCodeAt(0) >= 0x20)).toBe(true);
    expect(decodeURIComponent(header)).toBe(key);
  });
});
