import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_MODEL,
  AUTO_POLICY,
  AUTO_THRESHOLDS,
  approvalAttribution,
  autoHoldRecord,
  canonicalBaseUrl,
  checkEvaluator,
  checkKey,
  DEFAULT_EVALUATOR,
  decide,
  type EvaluatorConfig,
  endpointOf,
  evaluate,
  evaluatorConfig,
} from "./evaluator.js";

const input = {
  dialect: "postgresql" as const,
  sql: 'SELECT "quantity" FROM "public"."products"',
  dependencies: [
    { schema: "public", table: "products", column: "quantity", type: "int4", usage: "output" },
  ],
};
const ids = [
  "personal_disclosure",
  "organization_disclosure",
  "secret_disclosure",
  "insufficient_context",
];
const response = () => ({
  model: AUTO_MODEL,
  answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.001 }])),
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
  ["Needs review: Heavy query", "Heavy query"],
  ["Provider error with private@example.test", "Automatic review required"],
  // A family the plugin's analysis reaches today, its dynamic name stripped.
  ["Function effects need manual review: public.audit_user", "Function effects need manual review"],
  ["Unresolved JSON path", "Unresolved JSON path"],
])("bounds persisted hold reason %s without storing source values", (reason, expected) => {
  expect(autoHoldRecord.parse({ sent: false, reason })).toEqual({ sent: false, reason: expected });
});

// The plugin writes the hold reasons, this server keeps only the ones it lists: an unlisted
// one is stored as "Automatic review required" and its cause is lost. Read every call shape
// that can set an Auto hold in the plugin sources and require each reason to survive.
it("keeps every hold reason the plugin can record", () => {
  const src = new URL("../../plugin/src/", import.meta.url);
  const files = [
    ...readdirSync(new URL("sql/", src), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => `sql/${f}`),
    "annotate.ts",
    "app.ts",
  ];
  const shapes = [
    /\b(?:hold|resetAuto)\(\s*["`]([^"`]+)/g,
    /\breviewCard\(\s*card,\s*["`]([^"`]+)/g,
    /\bimplAllowed\([^,]+,\s*["`]([^"`]+)/g,
    /\breasons: \[\s*["`]([^"`]+)/g,
  ];
  const reasons = new Set<string>();
  for (const file of files) {
    const text = readFileSync(new URL(file, src), "utf8");
    const found = [
      ...shapes,
      ...(file === "sql/read-analysis.ts" ? [/\breturn ["`]([^"`]+)/g] : []),
    ]
      .flatMap((shape) => [...text.matchAll(shape)])
      .map((m) => m[1].split(/:|\$\{/)[0].trim());
    for (const reason of found) reasons.add(reason);
  }
  // Each extraction branch must still find something, or a broken pattern would pass empty.
  for (const reason of [
    "Custom cast needs manual review",
    "Custom operator needs manual review",
    "A parsed single read is required",
    "Metadata query failed",
    "Evaluation timed out. Approve manually",
    "Tab ownership changed",
  ])
    expect(reasons).toContain(reason);
  expect(reasons.size).toBeGreaterThan(40);
  for (const reason of reasons)
    expect(autoHoldRecord.parse({ sent: false, reason }).reason, reason).toBe(reason);
});

describe("decide", () => {
  const passing = { ...AUTO_THRESHOLDS };
  it("passes at every cutoff and names each axis over it", () => {
    expect(decide(passing, AUTO_THRESHOLDS)).toEqual({ eligible: true, reasons: [] });
    expect(decide({ ...passing, secret_disclosure: 0.16 }, AUTO_THRESHOLDS)).toEqual({
      eligible: false,
      reasons: ["Potential access secret disclosure"],
    });
  });
  it("keeps the axis order of today's reasons", () => {
    expect(
      decide({ ...passing, insufficient_context: 0.9, personal_disclosure: 0.9 }, AUTO_THRESHOLDS),
    ).toEqual({
      eligible: false,
      reasons: ["Potential personal disclosure", "Insufficient evaluation context"],
    });
  });
  const invalid = {
    eligible: false,
    reasons: ["Invalid evaluator response or stale policy/model"],
  };
  it.each([
    { personal_disclosure: undefined },
    { organization_disclosure: Number.NaN },
    { secret_disclosure: -0.1 },
    { insufficient_context: 1.5 },
    { read_only: 0.01 },
  ])("never reads a missing, extra or invalid probability as a pass: %o", (bad) => {
    const probabilities = { ...passing, ...bad } as Record<string, number>;
    if ("personal_disclosure" in bad) delete probabilities.personal_disclosure;
    expect(decide(probabilities, AUTO_THRESHOLDS)).toEqual(invalid);
  });
  it.each([
    {},
    { ...AUTO_THRESHOLDS, insufficient_context: Number.POSITIVE_INFINITY },
    { ...AUTO_THRESHOLDS, read_only: 1 },
  ])("never decides against empty, extra or invalid cutoffs: %o", (cutoffs) => {
    expect(decide(passing, cutoffs as typeof AUTO_THRESHOLDS)).toEqual(invalid);
  });
});

describe("recorded cutoffs", () => {
  const evaluation = {
    provider: "typesafe",
    model: AUTO_MODEL,
    policy: AUTO_POLICY,
    evaluatedAt: 1,
    sqlDigest: "a".repeat(64),
    eligible: true,
    reasons: [],
    probabilities: { ...AUTO_THRESHOLDS },
  };
  const parse = (thresholds?: unknown) =>
    approvalAttribution.safeParse({
      source: "automatic",
      evaluation: { ...evaluation, thresholds },
    }).success;
  it("accepts a record with exactly the four axes, or none from before they were kept", () => {
    expect(parse({ ...AUTO_THRESHOLDS })).toBe(true);
    expect(parse(undefined)).toBe(true);
  });
  it.each([
    { personal_disclosure: 0.2, organization_disclosure: 0.15, secret_disclosure: 0.15 },
    { ...AUTO_THRESHOLDS, read_only: 0.5 },
    { ...AUTO_THRESHOLDS, insufficient_context: 1.5 },
    { ...AUTO_THRESHOLDS, insufficient_context: "0.45" },
  ])("refuses cutoffs that leave out, add or bend an axis: %o", (thresholds) => {
    expect(parse(thresholds)).toBe(false);
  });
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
  it("preserves the four probabilities at the experimental cutoffs", async () => {
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
    expect(accepted.thresholds).toEqual(AUTO_THRESHOLDS);
    for (const [id, cutoff] of Object.entries(AUTO_THRESHOLDS))
      body.answers[id].noul = cutoff + 0.001;
    const held = await evaluate(
      input,
      "synthetic-key",
      new AbortController().signal,
      "a".repeat(64),
    );
    expect(held.eligible).toBe(false);
    expect(held.reasons).toHaveLength(4);
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
    // A stale answer set that still carries read_only is not the current questionnaire.
    { ...response(), answers: { ...response().answers, read_only: { type: "noul", noul: 1 } } },
    {
      ...response(),
      answers: { ...response().answers, personal_disclosure: { type: "choice", noul: 1 } },
    },
    {
      ...response(),
      answers: { ...response().answers, personal_disclosure: { type: "noul", noul: 2 } },
    },
    {
      ...response(),
      answers: { ...response().answers, personal_disclosure: { type: "noul", noul: "1" } },
    },
  ])("rejects malformed, missing or extra answers", async (body) => {
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

describe("evaluator choice", () => {
  const signal = () => new AbortController().signal;
  const custom = (baseUrl: string): EvaluatorConfig => ({
    provider: "custom",
    model: "kev-4b",
    baseUrl,
  });

  it.each([
    ["https://kev.example.test/api/", "https://kev.example.test/api"],
    ["https://KEV.example.test:443", "https://kev.example.test"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://127.1:8080/", "http://127.0.0.1:8080"],
    ["http://[::1]:8080/v", "http://[::1]:8080/v"],
  ])("keeps %s as %s", (raw, canonical) => {
    expect(canonicalBaseUrl(raw)).toBe(canonical);
  });

  it.each([
    "http://localhost:8080",
    "http://192.168.1.10:8080",
    "http://kev.example.test",
    "https://user:secret@kev.example.test",
    "https://kev.example.test/?token=1",
    "https://kev.example.test/#x",
    "ftp://kev.example.test",
    "not a url",
  ])("refuses %s", (raw) => {
    expect(canonicalBaseUrl(raw)).toBeUndefined();
  });

  it("asks each provider at its own address, keeping a Custom server's path", () => {
    expect(endpointOf(custom("https://kev.example.test/api"))).toEqual({
      infer: "https://kev.example.test/api/v1/systemone",
      check: "https://kev.example.test/api/v1/models",
    });
    expect(endpointOf(custom("https://kev.example.test/api/"))).toBeUndefined();
  });

  it("refuses a model name that is not one word, and Cloudflare", () => {
    expect(
      evaluatorConfig.safeParse({ provider: "cloudflare", model: "clef-flash", accountId: "a" })
        .success,
    ).toBe(false);
    expect(
      evaluatorConfig.safeParse({ ...custom("http://127.0.0.1:8080"), model: "a b" }).success,
    ).toBe(false);
  });

  it("asks a Custom server without a key and records only its origin", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ ...response(), model: "kev-4b" })),
    );
    vi.stubGlobal("fetch", fetch);
    const cutoffs = { ...AUTO_THRESHOLDS, personal_disclosure: 0.1 };
    const result = await evaluate(input, "", signal(), "a".repeat(64), {
      evaluator: custom("https://kev.example.test/tenant-7"),
      cutoffs,
      builtIn: false,
    });
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://kev.example.test/tenant-7/v1/systemone");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(options.body as string).model).toBe("kev-4b");
    expect(result).toMatchObject({
      provider: "custom",
      model: "kev-4b",
      policy: AUTO_POLICY,
      thresholds: cutoffs,
      builtIn: false,
      endpoint: "https://kev.example.test",
      eligible: true,
    });
  });

  describe("connection test", () => {
    it("keeps TypeSafe's meaning: any 2xx", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("not json")),
      );
      expect(await checkEvaluator(DEFAULT_EVALUATOR, "key", signal())).toBe("valid");
    });

    it.each([
      [200, { models: [{ name: "kev-4b" }, { name: "kev-9b" }] }, "valid"],
      [200, { models: [{ name: "kev-9b" }] }, "model-missing"],
      [200, { data: [] }, "unavailable"],
      [401, {}, "invalid"],
      [403, {}, "invalid"],
      [503, {}, "unavailable"],
    ])("reads a Custom server's model list: %s %o is %s", async (status, body, verdict) => {
      const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
      vi.stubGlobal("fetch", fetch);
      expect(await checkEvaluator(custom("http://127.0.0.1:8080"), "", signal())).toBe(verdict);
      expect(fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8080/v1/models",
        expect.objectContaining({ headers: {}, redirect: "error" }),
      );
    });

    it("never reads an unbounded model list", async () => {
      const huge = JSON.stringify({ models: [{ name: "x".repeat(40_000) }] });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(huge)),
      );
      expect(await checkEvaluator(custom("http://127.0.0.1:8080"), "", signal())).toBe(
        "unavailable",
      );
    });
  });

  it("records which evaluator decided, and refuses an unknown one", () => {
    const evaluation = {
      provider: "custom",
      model: "kev-4b",
      policy: AUTO_POLICY,
      evaluatedAt: 1,
      sqlDigest: "a".repeat(64),
      eligible: true,
      reasons: [],
      probabilities: { ...AUTO_THRESHOLDS },
      thresholds: { ...AUTO_THRESHOLDS },
      builtIn: false,
      endpoint: "https://kev.example.test",
    };
    const parse = (e: object) =>
      approvalAttribution.safeParse({ source: "automatic", evaluation: e }).success;
    expect(parse(evaluation)).toBe(true);
    expect(parse({ ...evaluation, provider: "openai" })).toBe(false);
    expect(parse({ ...evaluation, model: "kev 4b" })).toBe(false);
  });
});
