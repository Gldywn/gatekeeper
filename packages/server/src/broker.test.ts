import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBroker } from "./broker.js";
import { PAIRING_CODE_TTL_MS, PAIRING_IDLE_MS } from "./config.js";
import { connectionScopeKey } from "./connection.js";
import { EvaluationError } from "./evaluator.js";
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
const evaluator = vi.fn();
const keyChecker = vi.fn();
const notify = vi.fn();
const notifier = { active: true, sounds: true, probe: () => {}, notify, remind: vi.fn() };

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
  evaluator.mockReset();
  keyChecker.mockReset();
  notify.mockReset();
  server = createBroker(store, "plug_test", TOKEN, evaluator, keyChecker, notifier);
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

describe("plugin-only automatic evaluation", () => {
  function payload() {
    const conn = {
      connectionName: "test",
      databaseType: "postgresql",
      databaseName: "test",
      schema: "public",
      readOnly: false,
      mode: "read",
    };
    store.setConnection(conn);
    store.submit({ sessionId: "s1", sql: "SELECT quantity FROM public.products LIMIT 10" });
    const proposal = store.claimNext("plug_test", 30000, connectionScopeKey(conn))!;
    return {
      id: proposal.id,
      leaseId: proposal.leaseId,
      scope: connectionScopeKey(conn),
      key: "synthetic-key",
      model: "jev-1.13.0",
      policy: "auto-beta-8",
      input: {
        dialect: "postgresql",
        sql: "SELECT quantity FROM public.products LIMIT 10",
        dependencies: [
          {
            schema: "public",
            table: "products",
            column: "quantity",
            type: "int4",
            usage: "output",
          },
        ],
      },
    };
  }
  function answer(digest: string) {
    return {
      provider: "typesafe",
      model: "jev-1.13.0",
      policy: "auto-beta-8",
      sqlDigest: digest,
      evaluatedAt: Date.now(),
      eligible: true,
      reasons: [],
      probabilities: {
        personal_disclosure: 0,
        secret_disclosure: 0,
        organization_disclosure: 0,
        insufficient_context: 0,
      },
    };
  }
  it("requires authentication and a matching live lease before inference", async () => {
    const body = payload();
    expect((await call("POST", "/evaluate", { body })).status).toBe(401);
    expect(
      (await call("POST", "/evaluate", { token: TOKEN, body: { ...body, leaseId: "wrong" } }))
        .status,
    ).toBe(409);
    expect(
      (await call("POST", "/evaluate", { token: TOKEN, body: { ...body, scope: "other" } })).status,
    ).toBe(409);
    expect(
      (await call("POST", "/evaluate", { token: TOKEN, body: { ...body, model: "jev-latest" } }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", "/evaluate", { token: TOKEN, body: { ...body, policy: "auto-beta-7" } }))
        .status,
    ).toBe(400);
    expect(evaluator).not.toHaveBeenCalled();
  });
  it("uses only issued decisions and stores attribution through result purging", async () => {
    const body = payload();
    evaluator.mockImplementation(async (_input, _key, _signal, digest) => answer(digest));
    const evaluated = await call("POST", "/evaluate", { token: TOKEN, body });
    expect(evaluated.status).toBe(200);
    const approval = { source: "automatic", evaluation: JSON.parse(evaluated.body) };
    const forged = {
      ...approval,
      evaluation: { ...approval.evaluation, evaluatedAt: Date.now() + 500 },
    };
    expect(
      (
        await call("POST", "/executing", {
          token: TOKEN,
          body: { id: body.id, leaseId: body.leaseId, approval: forged },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("POST", "/executing", {
          token: TOKEN,
          body: { id: body.id, leaseId: body.leaseId, approval },
        })
      ).status,
    ).toBe(200);
    await call("POST", "/result", {
      token: TOKEN,
      body: { id: body.id, leaseId: body.leaseId, status: "approved", rows: [], fields: [] },
    });
    expect(store.listActivity(body.scope)[0].approval).toEqual(approval);
    expect(JSON.stringify(store.get(body.id))).not.toContain("synthetic-key");
  });
  it.each(["auto-beta-1", "auto-beta-2", "auto-beta-3"])(
    "preserves %s attribution for human approval without granting automatic authority",
    async (policy) => {
      const body = payload();
      const evaluation = { ...answer("a".repeat(64)), policy };
      for (const source of ["automatic", "human"]) {
        const result = await call("POST", "/executing", {
          token: TOKEN,
          body: { id: body.id, leaseId: body.leaseId, approval: { source, evaluation } },
        });
        expect(result.status).toBe(source === "human" ? 200 : 409);
      }
      await call("POST", "/result", {
        token: TOKEN,
        body: { id: body.id, leaseId: body.leaseId, status: "approved", rows: [], fields: [] },
      });
      // A human approval that kept its evaluation is still a human one.
      expect(store.listActivity(body.scope)[0].approval).toEqual({ source: "human", evaluation });
    },
  );
  it.each([false, true])(
    "persists a plugin-reported hold with sent=%s outside result data",
    async (sent) => {
      const body = payload();
      const autoHold = { sent, reason: "Sensitive source or alias: email" };
      const reply = await call("POST", "/result", {
        token: TOKEN,
        body: { id: body.id, leaseId: body.leaseId, status: "rejected", autoHold },
      });
      expect(reply.status).toBe(200);
      const saved = { sent, reason: "Sensitive source or alias" };
      expect(store.get(body.id)?.policy).toMatchObject({ autoHold: saved });
      expect(store.get(body.id)?.result).not.toHaveProperty("autoHold");
      const activity = await call("GET", "/activity", { token: TOKEN });
      expect(JSON.parse(activity.body).activity[0].autoHold).toEqual(saved);
      expect(evaluator).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { sent: "false", reason: "Metadata unavailable" },
    { sent: false, reason: "" },
    { sent: false, reason: "x".repeat(201) },
    { sent: false, reason: "Metadata unavailable", rows: ["private value"] },
  ])("rejects invalid hold metadata without resolving the request", async (autoHold) => {
    const body = payload();
    const reply = await call("POST", "/result", {
      token: TOKEN,
      body: { id: body.id, leaseId: body.leaseId, status: "rejected", autoHold },
    });
    expect(reply.status).toBe(400);
    expect(reply.body).not.toContain("private value");
    expect(store.get(body.id)?.state).toBe("leased");
    expect(store.get(body.id)?.policy).toBeNull();
  });
  it("does not record a hold from a stale lease", async () => {
    const body = payload();
    const reply = await call("POST", "/result", {
      token: TOKEN,
      body: {
        id: body.id,
        leaseId: "wrong",
        status: "rejected",
        autoHold: { sent: false, reason: "Metadata unavailable" },
      },
    });
    expect(reply.status).toBe(409);
    expect(store.get(body.id)?.state).toBe("leased");
    expect(store.get(body.id)?.policy).toBeNull();
  });
  it("discards answers after agent cancellation and limits concurrent evaluation", async () => {
    const body = payload();
    let resolve!: (v: unknown) => void;
    evaluator.mockImplementation(
      (_input, _key, _signal, digest) =>
        new Promise((r) => {
          resolve = () => r(answer(digest));
        }),
    );
    const pending = call("POST", "/evaluate", { token: TOKEN, body });
    await vi.waitFor(() => expect(evaluator).toHaveBeenCalledOnce());
    expect((await call("POST", "/evaluate", { token: TOKEN, body })).status).toBe(409);
    store.cancel(body.id, "s1");
    resolve(null);
    expect((await pending).status).toBe(409);
  });
  it("sanitizes provider failures and never changes a manual request into rejection", async () => {
    const body = payload();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [error, diagnostic] of [
        [new Error("synthetic-key echoed by provider"), { stage: "internal" }],
        [new EvaluationError("http", 422), { stage: "http", status: 422 }],
        [new EvaluationError("response"), { stage: "response" }],
      ] as const) {
        evaluator.mockRejectedValue(error);
        const result = await call("POST", "/evaluate", { token: TOKEN, body });
        expect(result.status).toBe(503);
        expect(JSON.parse(result.body).diagnostic).toEqual(diagnostic);
        expect(result.body).not.toContain("synthetic-key");
        expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-key");
        expect(store.get(body.id)?.state).toBe("leased");
      }
    } finally {
      log.mockRestore();
    }
  });

  it("keeps a model concern in durable history after human rejection", async () => {
    const body = payload();
    evaluator.mockImplementation(async (_input, _key, _signal, digest) => ({
      ...answer(digest),
      eligible: false,
      reasons: ["Potential personal disclosure"],
      probabilities: { ...answer(digest).probabilities, personal_disclosure: 0.5 },
    }));
    expect((await call("POST", "/evaluate", { token: TOKEN, body })).status).toBe(200);
    expect(store.get(body.id)?.state).toBe("leased");
    await call("POST", "/result", {
      token: TOKEN,
      body: { id: body.id, leaseId: body.leaseId, status: "rejected", reason: "Not needed" },
    });
    expect(store.listActivity(body.scope)[0].evaluation?.reasons).toEqual([
      "Potential personal disclosure",
    ]);
  });
  it("withdraws a reservation without executing or settling the request", async () => {
    const body = payload();
    await call("POST", "/executing", {
      token: TOKEN,
      body: { id: body.id, leaseId: body.leaseId },
    });
    expect(
      (
        await call("POST", "/execution/withdraw", {
          token: TOKEN,
          body: { id: body.id, leaseId: body.leaseId },
        })
      ).status,
    ).toBe(200);
    expect(store.get(body.id)?.state).toBe("leased");
  });
});

describe("the poll's Auto mode report", () => {
  const conn = {
    connectionName: "test",
    databaseType: "postgresql",
    databaseName: "test",
    schema: "public",
    readOnly: false,
    mode: "read",
  };
  const read = () =>
    store.submitNew({ sessionId: "s1", sql: "SELECT 1", autoEligible: true }).deferred;
  const poll = (query = "", opts: { token?: string } = { token: TOKEN }) =>
    call("GET", `/pending${query}`, opts);

  beforeEach(() => {
    store.setConnection(conn);
  });

  it("lets any query wait while heavy ones are auto-denied, and only reads for Auto mode", async () => {
    const write = () =>
      store.submitNew({ sessionId: "s1", sql: "DELETE FROM t", autoEligible: false }).deferred;
    await poll("?heavy=1");
    expect(write()).toBe(true);
    await poll("?auto=1");
    expect(write()).toBe(false);
    expect(read()).toBe(true);
  });

  it("lets a read submitted while Auto mode is on wait for it, until it is switched off", async () => {
    expect(read()).toBe(false);
    expect((await poll("?auto=1")).status).toBe(200);
    expect(read()).toBe(true);
    await poll();
    expect(read()).toBe(false);
  });

  it("takes no report from a poll that is not authenticated", async () => {
    expect((await poll("?auto=1", {})).status).toBe(401);
    expect(read()).toBe(false);
  });

  it("rings once for the requests handed to a human, however often they are reported", async () => {
    await poll("?auto=1");
    const { request } = store.submitNew({ sessionId: "s1", sql: "SELECT 2", autoEligible: true });
    await poll(`?auto=1&attention=${request.id}`);
    await poll(`?auto=1&attention=${request.id}`);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("takes a hand-off with Auto mode already off, the moment it was switched off", async () => {
    await poll("?auto=1");
    const { request } = store.submitNew({ sessionId: "s1", sql: "SELECT 2", autoEligible: true });
    await poll(`?attention=${request.id}`);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("stays silent for a request that was alerted at submission", async () => {
    const { request } = store.submitNew({ sessionId: "s1", sql: "SELECT 2", autoEligible: true });
    await poll(`?auto=1&attention=${request.id}`);
    expect(notify).not.toHaveBeenCalled();
  });

  // The list is advice about alerts: whatever another version puts there, the claim goes on.
  it("takes what it can from an odd attention list and still claims", async () => {
    await poll("?auto=1");
    const many = Array.from({ length: 300 }, (_, i) => `req_${i.toString(16).padStart(12, "0")}`);
    for (const query of ["?attention=", "?attention=nope", `?attention=${many.join(",")}`]) {
      expect((await poll(`${query}&auto=1`)).status).toBe(204);
    }
    expect(notify).not.toHaveBeenCalled();
    const { request } = store.submitNew({ sessionId: "s1", sql: "SELECT 2", autoEligible: true });
    expect(
      (await poll(`?auto=1&attention=nope,${request.id}&attention=${request.id}`)).status,
    ).toBe(200);
    expect(notify).toHaveBeenCalledOnce();
    expect(store.get(request.id)?.state).toBe("leased");
  });
});

// A refused renewal used to say only "no". The plugin cannot act on that: a proposal put
// back in the pool and one killed for good both refuse, and only the second deserves a
// line in the human's resolved list.
describe("API key check", () => {
  it("answers only the paired plugin, with the provider's verdict and nothing else", async () => {
    keyChecker.mockResolvedValue("invalid");
    expect((await call("POST", "/evaluate/key", { body: { key: "k" } })).status).toBe(401);
    expect(
      (await call("POST", "/evaluate/key", { token: TOKEN, body: { key: "bad key" } })).status,
    ).toBe(400);
    const reply = await call("POST", "/evaluate/key", { token: TOKEN, body: { key: "k" } });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ status: "invalid" });
    expect(keyChecker).toHaveBeenCalledOnce();
  });
});

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

describe("GET /activity paging", () => {
  function decide(n: number): void {
    for (let i = 0; i < n; i++) {
      store.submit({ sessionId: "s1", sql: `SELECT ${i}` });
      const claimed = store.claimNext("plug_test", 30000)!;
      store.resolve(claimed.id, claimed.leaseId!, { status: "rejected", reason: "no" });
    }
  }

  it("serves the newest 200, says older ones exist, and continues from a cursor", async () => {
    decide(201);
    const first = JSON.parse((await call("GET", "/activity", { token: TOKEN })).body);
    expect(first.activity).toHaveLength(200);
    expect(first.more).toBe(true);
    const last = first.activity[199];
    const next = JSON.parse(
      (
        await call("GET", `/activity?before=${last.decidedAt}&beforeId=${last.id}`, {
          token: TOKEN,
        })
      ).body,
    );
    expect(next).toMatchObject({ more: false });
    expect(next.activity).toHaveLength(1);
    const ids = [...first.activity, ...next.activity].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(201);
  });

  it.each([
    "?before=1",
    "?beforeId=req_000000000000",
    "?before=&beforeId=req_000000000000",
    "?before=1.5&beforeId=req_000000000000",
    "?before=-1&beforeId=req_000000000000",
    "?before=99999999999999999&beforeId=req_000000000000",
    "?before=1&beforeId=req_00000000000",
    "?before=1&before=2&beforeId=req_000000000000",
  ])("rejects the malformed cursor %s", async (query) => {
    expect((await call("GET", `/activity${query}`, { token: TOKEN })).status).toBe(400);
  });
});

describe("sensitivity record on decisions", () => {
  function claimed() {
    store.submit({ sessionId: "s1", sql: "SELECT email FROM users" });
    return store.claimNext("plug_test", 30000)!;
  }

  it("stores a well-formed record and serves it back in the audit trail", async () => {
    const c = claimed();
    const sensitivity = { pii: true, value: false, client: false };
    const reply = await call("POST", "/executing", {
      token: TOKEN,
      body: { id: c.id, leaseId: c.leaseId, sensitivity },
    });
    expect(reply.status).toBe(200);
    await call("POST", "/result", {
      token: TOKEN,
      body: { id: c.id, leaseId: c.leaseId, status: "approved", rows: [], fields: [] },
    });
    const page = JSON.parse((await call("GET", "/activity", { token: TOKEN })).body);
    expect(page.activity[0].sensitivity).toEqual(sensitivity);
  });

  it.each(["/executing", "/result"])(
    "still records the decision on %s when the record is unreadable",
    async (path) => {
      const c = claimed();
      const reply = await call("POST", path, {
        token: TOKEN,
        body: { id: c.id, leaseId: c.leaseId, status: "rejected", sensitivity: { pii: "yes" } },
      });
      expect(reply.status).toBe(200);
      expect(store.get(c.id)?.state).toBe(path === "/executing" ? "executing" : "rejected");
      expect(JSON.stringify(store.get(c.id)?.policy ?? null)).not.toContain("sensitivity");
    },
  );

  it("keeps only the three flags from a newer, richer record", async () => {
    const c = claimed();
    await call("POST", "/result", {
      token: TOKEN,
      body: {
        id: c.id,
        leaseId: c.leaseId,
        status: "rejected",
        sensitivity: { pii: true, value: false, client: false, columns: ["email"] },
      },
    });
    expect(store.get(c.id)?.policy).toEqual({
      sensitivity: { pii: true, value: false, client: false },
    });
  });
});

describe("the server identity header", () => {
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const identity = (res: Reply) =>
    JSON.parse(decodeURIComponent(String(res.headers["x-gatekeeper-server"])));

  it("names the build on authenticated answers, with or without a body", async () => {
    const roster = await call("GET", "/sessions", { token: TOKEN });
    const empty = await call("GET", "/pending", { token: TOKEN });
    expect(roster.status).toBe(200);
    expect(empty.status).toBe(204);
    for (const res of [roster, empty]) {
      expect(identity(res).version).toBe(version);
      expect(res.headers["access-control-expose-headers"]).toBe("X-Gatekeeper-Server");
    }
  });

  it("stays on an authenticated failure", async () => {
    const res = await call("GET", "/no-such-route", { token: TOKEN });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(identity(res).version).toBe(version);
  });

  it("is never sent before the bearer check", async () => {
    const unauthenticated = [
      await call("GET", "/sessions"),
      await call("GET", "/pair/status"),
      await call("OPTIONS", "/pending"),
      await call("GET", "/pair"),
      await call("POST", "/pair/exchange", { body: { code: "000000" } }),
    ];
    for (const res of unauthenticated) {
      expect(res.headers["x-gatekeeper-server"]).toBeUndefined();
    }
  });
});
