import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SingleInstance, type SingleInstanceWire } from "./singleinstance";

const NS = "gk-single-instance/v1";

function makeBus() {
  const subs: Array<(m: SingleInstanceWire) => void> = [];
  return {
    post(m: SingleInstanceWire) {
      for (const s of subs) s(m);
    },
    subscribe(h: (m: SingleInstanceWire) => void) {
      subs.push(h);
    },
    // Deliver a message from a peer that is not a real instance.
    inject(m: SingleInstanceWire) {
      for (const s of subs) s(m);
    },
  };
}

function makeInstance(bus: ReturnType<typeof makeBus>, id: string) {
  const roles: string[] = [];
  const inst = new SingleInstance(
    {
      post: (m) => bus.post(m),
      subscribe: (h) => bus.subscribe(h),
      now: () => Date.now(),
      onActive: () => roles.push("active"),
      onStandby: () => roles.push("standby"),
    },
    id,
  );
  return { inst, roles };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SingleInstance", () => {
  it("a lone tab becomes active after the claim window", () => {
    const bus = makeBus();
    const a = makeInstance(bus, "a");
    a.inst.join();
    expect(a.roles).toEqual([]); // still pending inside the window
    vi.advanceTimersByTime(400);
    expect(a.roles).toEqual(["active"]);
  });

  it("a second tab joining an active one goes standby; the active stays active", () => {
    const bus = makeBus();
    const a = makeInstance(bus, "a");
    a.inst.join();
    vi.advanceTimersByTime(400);
    const b = makeInstance(bus, "b");
    b.inst.join(); // a answers the claim, so b stands down at once
    expect(b.roles).toEqual(["standby"]);
    vi.advanceTimersByTime(400);
    expect(b.roles).toEqual(["standby"]); // never promotes while a holds it
    expect(a.roles).toEqual(["active"]);
  });

  it("promotes a standby when the active yields (tab closed)", () => {
    const bus = makeBus();
    const a = makeInstance(bus, "a");
    a.inst.join();
    vi.advanceTimersByTime(400);
    const b = makeInstance(bus, "b");
    b.inst.join();
    expect(b.roles).toEqual(["standby"]);
    a.inst.dispose(); // sends 'yield'
    vi.advanceTimersByTime(400); // b re-claims, nobody answers -> promotes
    expect(b.roles).toEqual(["standby", "active"]);
  });

  it("promotes a standby when the active goes silent (crash, no heartbeat)", () => {
    const bus = makeBus();
    const b = makeInstance(bus, "b");
    b.inst.join();
    bus.inject({ ns: NS, k: "active", id: "ghost" }); // an active appears then vanishes
    expect(b.roles).toEqual(["standby"]);
    vi.advanceTimersByTime(11_000); // no further heartbeats -> watchdog re-claims -> active
    expect(b.roles).toEqual(["standby", "active"]);
  });

  it("takeover flips the two tabs", () => {
    const bus = makeBus();
    const a = makeInstance(bus, "a");
    a.inst.join();
    vi.advanceTimersByTime(400);
    const b = makeInstance(bus, "b");
    b.inst.join();
    expect(a.roles).toEqual(["active"]);
    expect(b.roles).toEqual(["standby"]);
    b.inst.takeOver();
    vi.advanceTimersByTime(400);
    expect(a.roles).toEqual(["active", "standby"]);
    expect(b.roles).toEqual(["standby", "active"]);
  });

  it("on two actives, the lower id keeps the slot", () => {
    const bus = makeBus();
    const b = makeInstance(bus, "b");
    b.inst.join();
    vi.advanceTimersByTime(400);
    expect(b.roles).toEqual(["active"]);
    bus.inject({ ns: NS, k: "active", id: "z" }); // higher id -> b keeps it
    expect(b.roles).toEqual(["active"]);
    bus.inject({ ns: NS, k: "active", id: "a" }); // lower id -> b stands down
    expect(b.roles).toEqual(["active", "standby"]);
  });

  it("ignores foreign namespaces and its own echo", () => {
    const bus = makeBus();
    const a = makeInstance(bus, "a");
    a.inst.join();
    vi.advanceTimersByTime(400);
    bus.inject({ ns: "other", k: "active", id: "x" }); // foreign
    bus.inject({ ns: NS, k: "active", id: "a" }); // own id echoed back
    expect(a.roles).toEqual(["active"]); // unaffected
  });
});
