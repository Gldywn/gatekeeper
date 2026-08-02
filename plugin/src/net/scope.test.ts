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

  it("uses the header-safe unit separator the server also uses", () => {
    // U+001F is a valid header byte (≤ 0xFF), so the plugin key and the server
    // stamp for the same connection compare equal on the wire.
    expect(SCOPE_SEP).toBe("\u001f");
    const key = connectionScopeKey({
      connectionName: "prod",
      databaseType: "postgresql",
      databaseName: "app",
    });
    expect([...key].every((ch) => ch.charCodeAt(0) <= 0xff)).toBe(true);
  });
});
