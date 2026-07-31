import { describe, expect, it } from "vitest";
import { readOnlyView } from "./readonly";

// Locks the badge/layer state mapping to the one harmonized vocabulary.
describe("render/readonly", () => {
  it("a confirmed writer endpoint with Beekeeper off reads writable + amber chip", () => {
    const v = readOnlyView(false, { replica: false, sessionReadOnly: false }, true);
    expect(v.chip).toEqual({ kind: "warn", label: "writable", lock: false });
    expect(v.gatekeeper).toEqual({ label: "read-only", state: "ok" });
    expect(v.beekeeper).toEqual({ label: "writable", state: "warn" });
    expect(v.endpoint).toEqual({ label: "writable", state: "warn" });
  });

  it("a read replica earns the green lock even with Beekeeper off", () => {
    const v = readOnlyView(false, { replica: true, sessionReadOnly: false }, true);
    expect(v.chip).toEqual({ kind: "ok", label: "read-only", lock: true });
    expect(v.endpoint).toEqual({ label: "read-only", state: "ok" });
  });

  it("a read-only session confirms read-only", () => {
    const v = readOnlyView(false, { replica: false, sessionReadOnly: true }, true);
    expect(v.chip.kind).toBe("ok");
    expect(v.endpoint).toEqual({ label: "read-only", state: "ok" });
  });

  it("Beekeeper read-only alone earns the green lock; endpoint stays not verified", () => {
    const v = readOnlyView(true, null, false);
    expect(v.chip).toEqual({ kind: "ok", label: "read-only", lock: true });
    expect(v.beekeeper).toEqual({ label: "read-only", state: "ok" });
    expect(v.endpoint).toEqual({ label: "not verified", state: "mut" });
  });

  it("an unprobed / non-Postgres endpoint is unverified, never writable", () => {
    const v = readOnlyView(false, null, false);
    expect(v.chip).toEqual({ kind: "mut", label: "unverified", lock: false });
    expect(v.endpoint).toEqual({ label: "not verified", state: "mut" });
  });
});
