import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBroker } from "./broker.js";
import { NOTIFY_COOLDOWN_MS, PAIRING_CODE_TTL_MS, PAIRING_IDLE_MS } from "./config.js";
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
const notifyAuto = vi.fn();
const notifier = { active: true, autoActive: true, probe: () => {}, notify: () => {}, notifyAuto };

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
  notifyAuto.mockReset();
  notifier.autoActive = true;
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
      store.claimAlert(NOTIFY_COOLDOWN_MS);
      await call("POST", "/result", {
        token: TOKEN,
        body: { id: body.id, leaseId: body.leaseId, status: "approved", rows: [], fields: [] },
      });
      expect(store.listActivity(body.scope)[0].approval).toEqual({ source: "human", evaluation });
      // A human approval that kept its evaluation is still a human one.
      expect(notifyAuto).not.toHaveBeenCalled();
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

describe("the Auto mode sound", () => {
  // Attribution is set at the store level: what the broker accepts on /executing is
  // covered above, this block only covers what /result does with it.
  function executing(source: "automatic" | "human", sql = "SELECT 1") {
    const { request } = store.submitNew({ sessionId: "s1", sql });
    const lease = store.claimNext("plug_test", 30_000)!;
    expect(lease.id).toBe(request.id);
    store.markExecuting(lease.id, lease.leaseId!, { source });
    return { id: lease.id, leaseId: lease.leaseId! };
  }
  function finish(held: { id: string; leaseId: string }, extra: Record<string, unknown> = {}) {
    return call("POST", "/result", {
      token: TOKEN,
      body: { ...held, status: "approved", rows: [], fields: [], ...extra },
    });
  }

  // Every case starts the way production does: the submission alert claimed the window.
  const rang = () => expect(store.claimAlert(NOTIFY_COOLDOWN_MS)).toBe(true);

  it("answers the submission alert once the Auto approval has run", async () => {
    rang();
    expect((await finish(executing("automatic"))).status).toBe(200);
    expect(notifyAuto).toHaveBeenCalledOnce();
  });

  // Right after "handled", a proposal swallowed by the burst window would wait unseen.
  it("reopens the submission window, so the next proposal rings at once", async () => {
    rang();
    await finish(executing("automatic"));
    expect(store.claimAlert(NOTIFY_COOLDOWN_MS)).toBe(true);
    await finish(executing("automatic", "SELECT 2"));
    expect(notifyAuto).toHaveBeenCalledTimes(2);
  });

  it("stays silent when no submission alert rang since it last played", async () => {
    rang();
    await finish(executing("automatic"));
    await finish(executing("automatic", "SELECT 2"));
    expect(notifyAuto).toHaveBeenCalledOnce();
  });

  it("stays silent for a human approval and for an Auto query that failed", async () => {
    rang();
    const human = executing("human");
    const failed = executing("automatic", "SELECT 2");
    expect((await finish(human)).status).toBe(200);
    expect((await finish(failed, { error: "relation does not exist" })).status).toBe(200);
    expect(store.get(human.id)?.state).toBe("approved");
    expect(store.get(failed.id)?.state).toBe("failed");
    expect(notifyAuto).not.toHaveBeenCalled();
    expect(store.claimAlert(NOTIFY_COOLDOWN_MS)).toBe(false);
  });

  // Next to a proposal still awaiting approval, the Auto sound would read as an all-clear.
  it("stays silent while another proposal awaits approval, keeping the window", async () => {
    rang();
    const auto = executing("automatic");
    store.submit({ sessionId: "s1", sql: "SELECT 2" });
    expect((await finish(auto)).status).toBe(200);
    expect(notifyAuto).not.toHaveBeenCalled();
    expect(store.claimAlert(NOTIFY_COOLDOWN_MS)).toBe(false);
  });

  it("plays once for a burst, after the last one has run", async () => {
    rang();
    const first = executing("automatic");
    const second = executing("automatic", "SELECT 2");
    expect((await finish(first)).status).toBe(200);
    expect(notifyAuto).not.toHaveBeenCalled();
    expect((await finish(second)).status).toBe(200);
    expect(notifyAuto).toHaveBeenCalledOnce();
  });

  // A reservation the plugin withdraws goes back to human review with no new alert.
  it("waits for an automatic execution, which can still be withdrawn", async () => {
    rang();
    const done = executing("automatic");
    const reserved = executing("automatic", "SELECT 2");
    expect((await finish(done)).status).toBe(200);
    const withdrawn = await call("POST", "/execution/withdraw", { token: TOKEN, body: reserved });
    expect(withdrawn.status).toBe(200);
    expect(store.get(reserved.id)?.state).toBe("leased");
    expect(notifyAuto).not.toHaveBeenCalled();
    expect(store.claimAlert(NOTIFY_COOLDOWN_MS)).toBe(false);
  });

  it("does not wait for a query a human approved, still running", async () => {
    rang();
    executing("human");
    expect((await finish(executing("automatic", "SELECT 2"))).status).toBe(200);
    expect(notifyAuto).toHaveBeenCalledOnce();
  });

  it("leaves the window alone in modes that never play it", async () => {
    notifier.autoActive = false;
    rang();
    await finish(executing("automatic"));
    expect(notifyAuto).not.toHaveBeenCalled();
    expect(store.claimAlert(NOTIFY_COOLDOWN_MS)).toBe(false);
  });

  it("still accepts the result when the sound fails", async () => {
    notifyAuto.mockImplementation(() => {
      throw new Error("boom");
    });
    rang();
    const held = executing("automatic");
    expect((await finish(held)).status).toBe(200);
    expect(store.get(held.id)?.state).toBe("approved");
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

describe("kept results", () => {
  const sealed = Buffer.alloc(64, 7).toString("base64");
  const conn = (name: string) => ({
    connectionName: name,
    databaseType: "postgresql",
    databaseName: name,
    schema: "public",
    readOnly: false,
    mode: "read",
  });

  function claimed(name = "alpha") {
    store.setConnection(conn(name));
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    return store.claimNext("plug_test", 30000, connectionScopeKey(conn(name)))!;
  }

  async function approve(archive?: unknown) {
    const c = claimed();
    const reply = await call("POST", "/result", {
      token: TOKEN,
      body: {
        id: c.id,
        leaseId: c.leaseId,
        status: "approved",
        rows: [{ a: 1 }],
        fields: [{ name: "a" }],
        archive,
      },
    });
    return { id: c.id, reply };
  }

  it("stores the sealed rows with the decision and serves them back still sealed", async () => {
    const { id, reply } = await approve(sealed);
    expect(reply.status).toBe(200);
    const page = JSON.parse((await call("GET", "/activity", { token: TOKEN })).body);
    expect(page.activity[0]).toMatchObject({ id, kept: true });
    const read = await call("GET", `/results/${id}`, { token: TOKEN });
    expect(read.status).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(read.body)).toEqual({ payload: sealed });
  });

  it.each([
    ["not base64", "not base64!"],
    ["too short", Buffer.alloc(8).toString("base64")],
    ["not a string", 42],
  ])("records the decision without rows when the archive is %s", async (_, archive) => {
    const { id, reply } = await approve(archive);
    expect(reply.status).toBe(200);
    expect(store.get(id)?.state).toBe("approved");
    expect((await call("GET", `/results/${id}`, { token: TOKEN })).status).toBe(404);
  });

  it("accepts an archive of exactly 9 MiB and drops one byte more, delivering both", async () => {
    const limit = 9 * 1024 * 1024;
    const fits = await approve(Buffer.alloc(limit, 1).toString("base64"));
    const over = await approve(Buffer.alloc(limit + 1, 1).toString("base64"));
    expect([fits.reply.status, over.reply.status]).toEqual([200, 200]);
    expect(store.get(over.id)?.state).toBe("approved");
    const page = JSON.parse((await call("GET", "/activity", { token: TOKEN })).body);
    const kept = Object.fromEntries(
      page.activity.map((e: { id: string; kept: boolean }) => [e.id, e.kept]),
    );
    expect(kept).toEqual({ [fits.id]: true, [over.id]: false });
  });

  it("answers 401 without the token and the same 404 out of scope, unknown or malformed", async () => {
    const { id } = await approve(sealed);
    expect((await call("GET", `/results/${id}`)).status).toBe(401);
    store.setConnection(conn("beta"));
    expect((await call("GET", `/results/${id}`, { token: TOKEN })).status).toBe(404);
    expect((await call("GET", "/results/req_000000000000", { token: TOKEN })).status).toBe(404);
    expect((await call("GET", "/results/req_zz", { token: TOKEN })).status).toBe(404);
  });

  it("records who declined, and drops an author it does not know", async () => {
    const human = claimed();
    await call("POST", "/result", {
      token: TOKEN,
      body: {
        id: human.id,
        leaseId: human.leaseId,
        status: "rejected",
        reason: "no",
        declinedBy: "human",
      },
    });
    const unknown = claimed();
    await call("POST", "/result", {
      token: TOKEN,
      body: { id: unknown.id, leaseId: unknown.leaseId, status: "rejected", declinedBy: "someone" },
    });
    expect(store.get(human.id)?.policy).toMatchObject({ declinedBy: "human" });
    expect(JSON.stringify(store.get(unknown.id)?.policy ?? null)).not.toContain("declinedBy");
  });
});

describe("GET /activity limit", () => {
  function decide(n: number): void {
    for (let i = 0; i < n; i++) {
      store.submit({ sessionId: "s1", sql: `SELECT ${i}` });
      const claimed = store.claimNext("plug_test", 30000)!;
      store.resolve(claimed.id, claimed.leaseId!, { status: "rejected", reason: "no" });
    }
  }

  it.each([
    ["3", 3, true],
    ["0", 1, true],
    ["500", 5, false],
  ])("serves ?limit=%s as %i entries", async (limit, length, more) => {
    decide(5);
    const page = JSON.parse((await call("GET", `/activity?limit=${limit}`, { token: TOKEN })).body);
    expect(page.activity).toHaveLength(length);
    expect(page.more).toBe(more);
  });

  it.each(["?limit=", "?limit=abc", "?limit=1.5", "?limit=-1", "?limit=1&limit=2"])(
    "rejects the malformed limit %s",
    async (query) => {
      expect((await call("GET", `/activity${query}`, { token: TOKEN })).status).toBe(400);
    },
  );
});
