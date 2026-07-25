import { describe, expect, it } from "vitest";
import { ConnectionState } from "./connection.js";

describe("ConnectionState", () => {
  it("is empty until the plugin reports", () => {
    expect(new ConnectionState(() => 1000).get()).toBeNull();
  });

  it("captures only the whitelisted fields with a timestamp", () => {
    const state = new ConnectionState(() => 1000);
    state.set({
      connectionName: "prod",
      databaseType: "postgresql",
      databaseName: "app",
      schema: "public",
      readOnly: true,
      // an unexpected field (e.g. a credential) must be dropped
      password: "secret",
    });
    expect(state.get()).toEqual({
      connectionName: "prod",
      databaseType: "postgresql",
      databaseName: "app",
      schema: "public",
      readOnly: true,
      capturedAt: 1000,
    });
  });

  it("coerces missing or wrong-typed fields safely", () => {
    const state = new ConnectionState(() => 5);
    state.set({ databaseType: 123, readOnly: "yes" });
    expect(state.get()).toEqual({
      connectionName: "",
      databaseType: "",
      databaseName: "",
      schema: null,
      readOnly: false,
      capturedAt: 5,
    });
  });
});
