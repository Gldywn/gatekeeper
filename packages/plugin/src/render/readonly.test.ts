import { describe, expect, it } from "vitest";
import { readOnlyView } from "./readonly";

describe("render/readonly", () => {
  it("shows each layer as read-only or writable", () => {
    const v = readOnlyView(true, false, { replica: false, sessionReadOnly: false });
    expect(v.gatekeeper).toEqual({ label: "read-only", state: "ok" });
    expect(v.beekeeper).toEqual({ label: "writable", state: "warn" });
    expect(v.endpoint).toEqual({ label: "writable", state: "warn" });
  });

  it("flips the Gatekeeper layer to writable once a mode is armed", () => {
    expect(readOnlyView(false, false, null).gatekeeper).toEqual({
      label: "writable",
      state: "warn",
    });
  });

  it("labels an endpoint no check has confirmed as unknown, never writable", () => {
    expect(readOnlyView(true, false, null).endpoint).toEqual({ label: "unknown", state: "mut" });
  });

  it("reads a replica or a read-only session as read-only", () => {
    expect(readOnlyView(true, false, { replica: true, sessionReadOnly: false }).endpoint).toEqual({
      label: "read-only",
      state: "ok",
    });
    expect(readOnlyView(true, false, { replica: false, sessionReadOnly: true }).endpoint).toEqual({
      label: "read-only",
      state: "ok",
    });
  });

  it("shows Beekeeper read-only mode as read-only", () => {
    expect(readOnlyView(true, true, null).beekeeper).toEqual({ label: "read-only", state: "ok" });
  });
});
