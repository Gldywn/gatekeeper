import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBroker } from "./broker.js";
import { PAIRING_CODE_TTL_MS, PAIRING_IDLE_MS } from "./config.js";
import { RequestStore } from "./store.js";

const TOKEN = "test-capability-token";
// The broker only serves loopback Host headers, and it builds the expected pair from
// the configured port; the listener itself takes an ephemeral one so tests never
// collide with a real broker.
const HOST = "127.0.0.1:9999";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let store: RequestStore;
let server: ReturnType<typeof createBroker>;
let port = 0;

function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          Host: HOST,
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

beforeEach(async () => {
  store = new RequestStore();
  server = createBroker(store, "plug_test", TOKEN);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  store.close();
});

function mint(): string {
  const code = store.issuePairingCode(PAIRING_CODE_TTL_MS, PAIRING_IDLE_MS);
  if (!code) {
    throw new Error("expected a code");
  }
  return code.code;
}

// A refused renewal used to say only "no". The plugin cannot act on that: a proposal put
// back in the pool and one killed for good both refuse, and only the second deserves a
// line in the human's resolved list.
describe("a refused renewal reports where the request landed", () => {
  it("names the terminal state when the agent cancelled underneath the plugin", async () => {
    const { request: proposal } = store.submitNew({ sessionId: "s1", sql: "SELECT 1" });
    const leased = store.claimNext("plug_test", 30_000);
    expect(leased?.id).toBe(proposal.id);
    store.cancel(proposal.id, "s1");

    const res = await call("POST", "/lease/renew", {
      token: TOKEN,
      body: { id: proposal.id, leaseId: leased?.leaseId },
    });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).state).toBe("cancelled");
  });

  it("names pending when the proposal is merely back in the pool", async () => {
    const { request: proposal } = store.submitNew({ sessionId: "s1", sql: "SELECT 1" });
    const leased = store.claimNext("plug_test", 30_000);

    // A stale lease id is the shape a re-offered proposal takes: the row lives on, the
    // plugin's hold on it does not.
    const res = await call("POST", "/lease/renew", {
      token: TOKEN,
      body: { id: proposal.id, leaseId: `${leased?.leaseId}-stale` },
    });

    expect(res.status).not.toBe(200);
    expect(JSON.parse(res.body).state).toBe("leased");
  });
});

// The split this whole design rests on: the page must not be readable cross-origin,
// the exchange must be. Re-unifying the two header sets would leak the token to any
// site the human visits.
describe("the CORS split", () => {
  it("serves the pairing page without Access-Control-Allow-Origin", async () => {
    const res = await call("GET", "/pair");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("keeps Access-Control-Allow-Origin on the exchange, which the plugin has to read", async () => {
    const res = await call("POST", "/pair/exchange", { body: { code: mint() } });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(JSON.parse(res.body)).toEqual({ token: TOKEN });
  });
});

describe("the pairing page", () => {
  it("shows the code the exchange accepts", async () => {
    const code = mint();
    const res = await call("GET", "/pair");
    expect(res.body).toContain(code);
  });

  it("hands out nothing once a plugin is authenticating", async () => {
    expect((await call("GET", "/sessions", { token: TOKEN })).status).toBe(200);
    const res = await call("GET", "/pair");
    expect(res.body).toContain("Nothing to pair");
    expect(res.body).not.toMatch(/class="code"/);
  });
});

describe("the exchange", () => {
  it("refuses a wrong code and keeps the token", async () => {
    const code = mint();
    const wrong = code === "000000" ? "111111" : "000000";
    const res = await call("POST", "/pair/exchange", { body: { code: wrong } });
    expect(res.status).toBe(401);
    expect(res.body).not.toContain(TOKEN);
  });

  it("rejects a malformed code before it can cost a guess", async () => {
    const code = mint();
    for (let i = 0; i < 20; i++) {
      expect((await call("POST", "/pair/exchange", { body: { code: "12" } })).status).toBe(400);
    }
    expect((await call("POST", "/pair/exchange", { body: { code } })).status).toBe(200);
  });

  it("throttles a guesser instead of letting it grind", async () => {
    mint();
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      seen.add((await call("POST", "/pair/exchange", { body: { code: "999999" } })).status);
    }
    expect(seen.has(429)).toBe(true);
  });

  // Dropped mid-body rather than buffered: this route is unauthenticated, so it never
  // gets the 32MB budget the result payloads need.
  it("caps the body it will read from an unauthenticated caller", async () => {
    await expect(
      call("POST", "/pair/exchange", { body: { code: "1".repeat(4096) } }),
    ).rejects.toThrow();
  });

  it("spends the code, so a replay is worth nothing", async () => {
    const code = mint();
    expect((await call("POST", "/pair/exchange", { body: { code } })).status).toBe(200);
    const replay = await call("POST", "/pair/exchange", { body: { code } });
    expect(replay.status).toBe(401);
    expect(replay.body).not.toContain(TOKEN);
  });
});

describe("liveness probe", () => {
  it("answers an unauthenticated caller so the plugin can tell a dead broker apart", async () => {
    const res = await call("GET", "/pair/status");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("carries CORS, since the plugin iframe has to read the answer", async () => {
    const res = await call("GET", "/pair/status");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("leaves every other route behind the capability token", async () => {
    expect((await call("GET", "/sessions")).status).toBe(401);
    expect((await call("GET", "/sessions", { token: TOKEN })).status).toBe(200);
  });

  it("refuses a non-loopback Host header", async () => {
    const res = await new Promise<Reply>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          path: "/pair/status",
          headers: { Host: "evil.example" },
        },
        (r) => {
          let body = "";
          r.setEncoding("utf8");
          r.on("data", (c) => {
            body += c;
          });
          r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(421);
  });
});
