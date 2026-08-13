import { describe, expect, it } from "vitest";
import { readOnlyView } from "./readonly";

describe("render/readonly", () => {
  // Today Gatekeeper is locked read-only, so a protecting layer is always present and
  // the chip is read-only whatever Beekeeper's mode or the endpoint say.
  it("stays read-only when Gatekeeper protects, even with a writer endpoint", () => {
    const v = readOnlyView(true, false, { replica: false, sessionReadOnly: false }, true);
    expect(v.chip).toEqual({ kind: "ok", label: "read-only" });
    expect(v.gatekeeper).toEqual({ label: "read-only", state: "ok" });
    expect(v.beekeeper).toEqual({ label: "writable", state: "warn" });
    expect(v.endpoint).toEqual({ label: "writable", state: "warn" });
  });

  it("labels an unprobed endpoint unknown, and stays read-only overall", () => {
    const v = readOnlyView(true, false, null, false);
    expect(v.chip).toEqual({ kind: "ok", label: "read-only" });
    expect(v.endpoint).toEqual({ label: "unknown", state: "mut" });
  });

  it("reads a replica or a read-only session as read-only", () => {
    expect(
      readOnlyView(true, false, { replica: true, sessionReadOnly: false }, true).endpoint,
    ).toEqual({
      label: "read-only",
      state: "ok",
    });
    expect(
      readOnlyView(true, false, { replica: false, sessionReadOnly: true }, true).endpoint,
    ).toEqual({
      label: "read-only",
      state: "ok",
    });
  });

  it("shows Beekeeper read-only mode as read-only", () => {
    expect(readOnlyView(true, true, null, false).beekeeper).toEqual({
      label: "read-only",
      state: "ok",
    });
  });

  // Future: once the Gatekeeper mode is switchable, the aggregate rides the lower layers.
  it("is writable only when every layer would accept a write", () => {
    const v = readOnlyView(false, false, { replica: false, sessionReadOnly: false }, true);
    expect(v.chip).toEqual({ kind: "warn", label: "writable" });
  });

  it("is unknown when nothing is confirmed read-only and a layer could not be read", () => {
    const v = readOnlyView(false, false, null, false);
    expect(v.chip).toEqual({ kind: "mut", label: "unknown" });
  });

  it("one read-only layer protects the whole, even with Gatekeeper in write mode", () => {
    expect(readOnlyView(false, true, null, false).chip).toEqual({ kind: "ok", label: "read-only" });
    expect(
      readOnlyView(false, false, { replica: true, sessionReadOnly: false }, true).chip,
    ).toEqual({ kind: "ok", label: "read-only" });
  });
});
