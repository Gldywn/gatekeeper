import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_MODEL,
  AUTO_POLICY,
  AUTO_THRESHOLDS,
  autoHoldRecord,
  checkKey,
  evaluate,
} from "./evaluator.js";

const input = {
  dialect: "postgresql" as const,
  sql: 'SELECT "quantity" FROM "public"."products"',
  dependencies: [
    { schema: "public", table: "products", column: "quantity", type: "int4", usage: "output" },
  ],
};
const ids = [
  "read_only",
  "personal_disclosure",
  "organization_disclosure",
  "secret_disclosure",
  "insufficient_context",
];
const response = () => ({
  model: AUTO_MODEL,
  answers: Object.fromEntries(
    ids.map((id) => [id, { type: "noul", noul: id === "read_only" ? 0.999 : 0.001 }]),
  ),
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["Metadata unavailable", "Metadata unavailable"],
  [
    "PostgreSQL catalog must come first in the search path",
    "PostgreSQL catalog must come first in the search path",
  ],
  [
    "Custom operators, functions or casts need manual review",
    "Custom operators, functions or casts need manual review",
  ],
  ["Auto mode disabled while evaluating", "Auto mode disabled while evaluating"],
  ["Needs review: Unsupported automatic SQL clause: where", "Unsupported automatic SQL clause"],
  ["Sensitive source or alias: 'private@example.test'", "Sensitive source or alias"],
  ["Provider error with private@example.test", "Automatic review required"],
])("bounds persisted hold reason %s without storing source values", (reason, expected) => {
  expect(autoHoldRecord.parse({ sent: false, reason })).toEqual({ sent: false, reason: expected });
});

describe("native Jev contract (mocked, not calibration)", () => {
  it("batches independent questions and never sends result rows or agent prose", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(response())));
    vi.stubGlobal("fetch", fetch);
    const result = await evaluate(
      input,
      "synthetic-key",
      new AbortController().signal,
      "a".repeat(64),
    );
    expect(result.eligible).toBe(true);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(options.redirect).toBe("error");
    const body = JSON.parse(options.body as string);
    expect(body.model).toBe(AUTO_MODEL);
    expect(Object.keys(body.questions)).toEqual(ids);
    expect(body.state).toEqual(input);
    for (const id of ids) {
      expect(body.questions[id]).toEqual({
        type: "noul",
        instructions: expect.stringContaining("state.sql"),
        criteria: { true: expect.any(String), false: expect.any(String) },
      });
    }
    expect(result.policy).toBe(AUTO_POLICY);
    expect(result).not.toHaveProperty("confidence");
  });
  it("preserves the five probabilities and their polarity at the experimental cutoffs", async () => {
    const body = response();
    for (const [id, cutoff] of Object.entries(AUTO_THRESHOLDS)) body.answers[id].noul = cutoff;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body)));
    const accepted = await evaluate(
      input,
      "synthetic-key",
      new AbortController().signal,
      "a".repeat(64),
    );
    expect(accepted.eligible).toBe(true);
    expect(accepted.probabilities).toEqual(AUTO_THRESHOLDS);
    for (const [id, cutoff] of Object.entries(AUTO_THRESHOLDS))
      body.answers[id].noul = cutoff + (id === "read_only" ? -0.001 : 0.001);
    const held = await evaluate(
      input,
      "synthetic-key",
      new AbortController().signal,
      "a".repeat(64),
    );
    expect(held.eligible).toBe(false);
    expect(held.reasons).toHaveLength(5);
    expect(held.probabilities.read_only).toBeCloseTo(0.949);
    expect(held.probabilities.personal_disclosure).toBeCloseTo(0.201);
  });
  it.each(ids)("a concern on %s cannot be averaged away", async (id) => {
    const body = response();
    body.answers[id].noul = 0.5;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body)));
    const result = await evaluate(
      input,
      "synthetic-key",
      new AbortController().signal,
      "a".repeat(64),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toHaveLength(1);
  });
  it.each([
    {},
    { ...response(), model: "jev-latest" },
    { ...response(), answers: {} },
    { ...response(), answers: { ...response().answers, read_only: { type: "choice", noul: 1 } } },
    { ...response(), answers: { ...response().answers, read_only: { type: "noul", noul: 2 } } },
    { ...response(), answers: { ...response().answers, read_only: { type: "noul", noul: "1" } } },
  ])("rejects malformed or missing answers", async (body) => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body)));
    await expect(
      evaluate(input, "synthetic-key", new AbortController().signal, "a".repeat(64)),
    ).rejects.toThrow();
  });
  it("fails closed on provider failure and cancellation without echoing bodies", async () => {
    vi.stubGlobal("fetch", async () => new Response("private provider body", { status: 401 }));
    await expect(
      evaluate(input, "synthetic-key", new AbortController().signal, "a".repeat(64)),
    ).rejects.toThrow("Evaluator unavailable");
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response())));
    await expect(
      evaluate(input, "synthetic-key", controller.signal, "a".repeat(64)),
    ).rejects.toThrow("cancelled");
  });
  it.each([401, 403, 422, 429, 500])(
    "reports HTTP %s without reading the provider error body",
    async (status) => {
      const cancel = vi.fn(async () => {});
      const getReader = vi.fn(() => {
        throw new Error("body must not be read");
      });
      vi.stubGlobal("fetch", async () => ({ ok: false, status, body: { cancel, getReader } }));
      await expect(
        evaluate(input, "synthetic-key", new AbortController().signal, "a".repeat(64)),
      ).rejects.toMatchObject({ stage: "http", status, message: "Evaluator unavailable" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(getReader).not.toHaveBeenCalled();
    },
  );
  it("distinguishes network, response and cancellation without relaying exceptions", async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic-key in network exception"))
      .mockResolvedValueOnce(new Response("synthetic-key in malformed body"))
      .mockRejectedValueOnce(new Error("synthetic-key in cancellation"));
    vi.stubGlobal("fetch", fetch);
    for (const stage of ["network", "response", "cancelled"]) {
      if (stage === "cancelled") controller.abort();
      await expect(
        evaluate(input, "synthetic-key", controller.signal, "a".repeat(64)),
      ).rejects.toMatchObject({
        stage,
        message: stage === "cancelled" ? "Evaluation cancelled" : "Evaluator unavailable",
      });
    }
  });
});

describe("API key check (mocked)", () => {
  it("asks the account's model list and maps only 401/403 to a refused key", async () => {
    const signal = new AbortController().signal;
    for (const [status, verdict] of [
      [200, "valid"],
      [401, "invalid"],
      [403, "invalid"],
      [500, "unavailable"],
      [429, "unavailable"],
    ] as const) {
      const fetch = vi.fn(async () => new Response("{}", { status }));
      vi.stubGlobal("fetch", fetch);
      expect(await checkKey("synthetic-key", signal)).toBe(verdict);
      expect(fetch).toHaveBeenCalledWith(
        "https://api.typesafe.ai/v1/models",
        expect.objectContaining({ headers: { Authorization: "Bearer synthetic-key" } }),
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await checkKey("synthetic-key", signal)).toBe("unavailable");
  });
});
