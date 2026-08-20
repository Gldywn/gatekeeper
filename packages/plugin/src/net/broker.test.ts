import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerClient } from "./broker";
import { connectionScopeKey } from "./scope";

// The encrypted store and the plaintext store the mocked appStorage keeps apart,
// so the legacy-migration path can be exercised without the real host bridge.
const { encStore, plainStore } = vi.hoisted(() => ({
  encStore: new Map<string, string>(),
  plainStore: new Map<string, string>(),
}));

vi.mock("@beekeeperstudio/plugin", () => ({
  appStorage: {
    getItem: async (key: string, opts?: { encrypted?: boolean }) =>
      (opts?.encrypted ? encStore : plainStore).get(key) ?? null,
    setItem: async (key: string, value: string, opts?: { encrypted?: boolean }) => {
      (opts?.encrypted ? encStore : plainStore).set(key, value);
    },
  },
}));

const KEY = "gatekeeper.token";
const URL = "http://localhost:9999";
const fetchMock = vi.fn();

function client(): BrokerClient {
  return new BrokerClient({ baseUrl: URL, tokenKey: KEY });
}

beforeEach(() => {
  encStore.clear();
  plainStore.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token storage", () => {
  it("stores the token encrypted and loads it back on a fresh client", async () => {
    await client().setToken("t0ken");
    expect(encStore.get(KEY)).toBe("t0ken");
    expect(await client().loadToken()).toBe("t0ken");
  });

  it("clears the token so the next load is null", async () => {
    const c = client();
    await c.setToken("t0ken");
    await c.clearToken();
    expect(encStore.get(KEY)).toBe("");
    expect(await c.loadToken()).toBeNull();
  });

  it("migrates a legacy plaintext token into the encrypted store", async () => {
    plainStore.set(KEY, "legacy");
    expect(await client().loadToken()).toBe("legacy");
    expect(encStore.get(KEY)).toBe("legacy");
    expect(plainStore.get(KEY)).toBe("");
  });
});

describe("probe", () => {
  it("reports a live broker without sending the bearer header", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    expect(await client().probe()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`${URL}/pair/status`);
  });

  it("reports no broker when nothing answers", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await client().probe()).toBe(false);
  });
});

describe("exchanging a pairing code", () => {
  it("stores the token it gets back, encrypted, like a pasted one", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "cap-tok" }),
    });
    expect(await client().exchange("418302")).toEqual({ ok: true });
    expect(encStore.get(KEY)).toBe("cap-tok");
    expect(fetchMock).toHaveBeenCalledWith(`${URL}/pair/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "418302" }),
    });
  });

  it("surfaces the broker's refusal and keeps no token", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "wrong code" }),
    });
    expect(await client().exchange("000000")).toEqual({ ok: false, error: "wrong code" });
    expect(encStore.get(KEY)).toBeUndefined();
  });

  it("turns a throttled attempt into a wait the human can act on", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "too many attempts, wait a moment", retryAfterMs: 24_000 }),
    });
    expect(await client().exchange("000000")).toEqual({
      ok: false,
      error: "Too many attempts. Try again in 24s.",
    });
  });

  it("reports a broker that stopped answering rather than throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const outcome = await client().exchange("418302");
    expect(outcome.ok).toBe(false);
  });
});

describe("endpoint requests", () => {
  it("renew posts the lease id with the bearer header and returns the new expiry", async () => {
    const c = client();
    await c.setToken("secret");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ leaseExpiresAt: 4242 }),
    });
    expect(await c.renew("req-1", "lease-9")).toEqual({ ok: true, leaseExpiresAt: 4242 });
    expect(fetchMock).toHaveBeenCalledWith(`${URL}/lease/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify({ id: "req-1", leaseId: "lease-9" }),
    });
  });

  it("renew reports a refused lease without throwing", async () => {
    const c = client();
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
    expect(await c.renew("req-1", "lease-9")).toEqual({ ok: false });
  });

  it("renew carries the settled state, so a dead proposal is told apart from a re-offered one", async () => {
    const c = client();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "gone", code: "LEASE_CONFLICT", state: "cancelled" }),
    });
    expect(await c.renew("req-1", "lease-9")).toEqual({ ok: false, state: "cancelled" });
  });

  // An older broker, a 401, a truncated body: no state, and the caller stays conservative.
  it("renew survives a refusal whose body cannot be read", async () => {
    const c = client();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => {
        throw new Error("not json");
      },
    });
    expect(await c.renew("req-1", "lease-9")).toEqual({ ok: false });
  });

  it("sessions sends the connection header and unwraps the payload", async () => {
    const c = client();
    await c.setToken("secret");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sessions: [{ sessionId: "s1" }] }),
    });
    expect(await c.sessions("main-db")).toEqual([{ sessionId: "s1" }]);
    expect(fetchMock).toHaveBeenCalledWith(`${URL}/sessions`, {
      headers: { "X-Gatekeeper-Connection": "main-db", Authorization: "Bearer secret" },
    });
  });

  it("omits the connection header when no connection name is given", async () => {
    const c = client();
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    expect(await c.sessions()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(`${URL}/sessions`, {
      headers: { Authorization: "Bearer null" },
    });
  });

  it("percent-encodes the composite scope key in the connection header", async () => {
    const c = client();
    await c.setToken("secret");
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ inflight: [] }) });
    // The key holds a control-char separator; Node rejects a raw control char in a header
    // value, so the plugin percent-encodes it and the server decodes it back.
    const scope = connectionScopeKey({
      connectionName: "gatekeeper_test",
      databaseType: "mysql",
      databaseName: "gatekeeper_test",
    });
    await c.inflight(scope);
    expect(fetchMock).toHaveBeenCalledWith(`${URL}/inflight`, {
      headers: {
        "X-Gatekeeper-Connection": encodeURIComponent(scope),
        Authorization: "Bearer secret",
      },
    });
    expect(decodeURIComponent(encodeURIComponent(scope))).toBe(scope);
  });
});
