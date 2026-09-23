import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentEvaluation,
  AUTO_MODEL as PLUGIN_MODEL,
  AUTO_POLICY as PLUGIN_POLICY,
  AUTO_THRESHOLDS as PLUGIN_THRESHOLDS,
} from "../../plugin/src/sql/auto";
import { planRead } from "../../plugin/src/sql/read-analysis";
import {
  analyzeSql,
  looksLikeClientData,
  looksLikePii,
  sensitiveLiterals,
} from "../../plugin/src/sql/schema";
import {
  AUTO_MODEL,
  AUTO_POLICY,
  AUTO_THRESHOLDS,
  evaluate,
  evaluationQuestions,
} from "../src/evaluator.js";
import {
  type Case,
  corpusSchema,
  digest,
  localInput,
  prepare,
  runLive,
  summarize,
  validateReport,
} from "./auto";

const allCases = corpusSchema.parse(
  JSON.parse(await readFile(new URL("auto-cases.json", import.meta.url), "utf8")),
);
const freshCases = corpusSchema.parse(
  JSON.parse(await readFile(new URL("auto-fresh-cases.json", import.meta.url), "utf8")),
);
const aliasCases = corpusSchema.parse(
  JSON.parse(await readFile(new URL("auto-alias-cases.json", import.meta.url), "utf8")),
);
const sourceValidationCases = corpusSchema.parse(
  JSON.parse(await readFile(new URL("auto-source-validation-cases.json", import.meta.url), "utf8")),
);
const confirmationCases = corpusSchema.parse(
  JSON.parse(await readFile(new URL("auto-confirmation-cases.json", import.meta.url), "utf8")),
);
const corpus = allCases.filter((c) => c.domain === "baseline");
const sharedConfirmationCases = corpusSchema.parse(
  JSON.parse(
    await readFile(new URL("auto-shared-confirmation-cases.json", import.meta.url), "utf8"),
  ),
);
const sharedCases = corpusSchema.parse(
  JSON.parse(await readFile(new URL("auto-shared-cases.json", import.meta.url), "utf8")),
);
const sharedFinalCases = corpusSchema.parse(
  JSON.parse(await readFile(new URL("auto-shared-final-cases.json", import.meta.url), "utf8")),
);
const questions = JSON.parse(
  await readFile(new URL("auto-identity-questions.json", import.meta.url), "utf8"),
);
const projectionQuestions = JSON.parse(
  await readFile(new URL("auto-projection-questions.json", import.meta.url), "utf8"),
);
const sharedQuestions = JSON.parse(
  await readFile(new URL("auto-shared-inference-questions.json", import.meta.url), "utf8"),
);
const sourceQuestions = JSON.parse(
  await readFile(new URL("auto-source-questions.json", import.meta.url), "utf8"),
);
const sourceThresholds = JSON.parse(
  await readFile(new URL("auto-source-thresholds.json", import.meta.url), "utf8"),
);
const selected = (id: string): Case => corpus.find((c) => c.id === id)!;
const currentQuestions = JSON.parse(
  await readFile(new URL("auto-beta-6-questions.json", import.meta.url), "utf8"),
);
const beta5Questions = JSON.parse(
  await readFile(new URL("auto-beta-5-questions.json", import.meta.url), "utf8"),
);
const productionThresholds = JSON.parse(
  await readFile(new URL("auto-beta-6-thresholds.json", import.meta.url), "utf8"),
);
const probabilities = Object.fromEntries(
  Object.keys(questions).map((id) => [id, id === "read_only" ? 0.99 : 0.01]),
);
const answer = () =>
  new Response(
    JSON.stringify({
      model: AUTO_MODEL,
      answers: Object.fromEntries(
        Object.entries(probabilities).map(([id, p]) => [id, { type: "noul", noul: p }]),
      ),
    }),
  );
afterEach(() => vi.unstubAllGlobals());

describe("Auto evaluation bench (synthetic, no calibration)", () => {
  it("freezes final confirmation labels and checks local coverage before inference", () => {
    corpusSchema.parse([...sharedCases, ...sharedConfirmationCases, ...sharedFinalCases]);
    expect(sharedFinalCases).toHaveLength(22);
    for (const c of sharedFinalCases) {
      expect(typeof localInput(c), c.id).toBe(c.expected === "local" ? "string" : "object");
    }
  });
  it("checks the widened shapes and local failures before any live evaluation", async () => {
    expect(sharedCases).toHaveLength(128);
    for (const c of sharedCases) {
      expect(typeof localInput(c), c.id).toBe(c.expected === "local" ? "string" : "object");
    }
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    for (const split of ["development", "validation"] as const) {
      const report = prepare(sharedCases, questions, split, sourceThresholds);
      await runLive(report, "synthetic-key", new AbortController().signal, async () => {});
      expect(report.results.filter((r) => r.probabilities)).toHaveLength(48);
      expect(report.results.filter((r) => r.localReason)).toHaveLength(16);
    }
    expect(fetch).toHaveBeenCalledTimes(96);
  });
  it("withholds literal values and covers membership disclosures in the reserved confirmation set", () => {
    corpusSchema.parse([...sharedCases, ...sharedConfirmationCases]);
    expect(sharedConfirmationCases).toHaveLength(32);
    for (const c of sharedConfirmationCases) {
      const input = localInput(c);
      expect(typeof input, c.id).toBe(c.expected === "local" ? "string" : "object");
      if (typeof input !== "string") {
        expect(JSON.stringify(input)).not.toContain("Synthetic Person");
        expect(JSON.stringify(input)).not.toContain("Synthetic Business");
        if (c.id.includes("membership")) expect(input.withheldLiterals).toBe(true);
      }
    }
  });
  it.each([
    ...allCases,
    ...freshCases,
    ...aliasCases,
    ...sourceValidationCases.filter((c) => c.expected !== "local"),
    ...confirmationCases,
  ])("$id: enforces its expected local/provider boundary", (c) => {
    const input = localInput(c);
    expect(typeof input).toBe(c.expected === "local" ? "string" : "object");
    const parsed = analyzeSql(c.sql, "postgresql");
    const names = parsed ? [...parsed.columns, ...parsed.aliases, ...parsed.jsonKeys] : [];
    if (
      names.some((name) => looksLikePii(name) || looksLikeClientData(name)) ||
      sensitiveLiterals(c.sql, "postgresql").length
    )
      expect(typeof planRead(c.sql, "postgresql")).toBe("string");
    if (c.category === "metadata") {
      expect(typeof planRead(c.sql, "postgresql")).toBe("object");
      expect(typeof input).toBe("string");
    }
  });

  it("has over 200 evaluator inputs across business families, separate from local checks", () => {
    expect(allCases).toHaveLength(272);
    expect(allCases.filter((c) => c.expected === "allow")).toHaveLength(123);
    expect(allCases.filter((c) => c.expected === "review")).toHaveLength(116);
    expect(allCases.filter((c) => c.expected === "local")).toHaveLength(33);
    expect(new Set(allCases.map((c) => c.domain)).size).toBe(22);
    for (const split of ["development", "validation"] as const) {
      const report = prepare(allCases, questions, split);
      expect(report.results.filter((r) => r.input).length).toBeGreaterThanOrEqual(100);
      for (const category of ["pii", "client", "sensitive-value", "context"])
        expect(
          allCases.filter(
            (c) => c.split === split && c.expected === "review" && c.category === category,
          ).length,
        ).toBeGreaterThanOrEqual(10);
    }
  });

  it("keeps fresh cases separate from observed SQL and runs only their eligible inputs", async () => {
    const observedSql = new Set(allCases.map((c) => c.sql.trim().replace(/\s+/g, " ")));
    const observedFamilies = new Set(allCases.map((c) => c.family));
    for (const c of freshCases) {
      expect(observedSql.has(c.sql.trim().replace(/\s+/g, " ")), c.id).toBe(false);
      expect(observedFamilies.has(c.family), c.id).toBe(false);
      expect(c.split).toBe("validation");
    }
    expect(freshCases.filter((c) => c.expected === "allow")).toHaveLength(53);
    expect(freshCases.filter((c) => c.expected === "review")).toHaveLength(51);
    expect(freshCases.filter((c) => c.expected === "local")).toHaveLength(16);
    const report = prepare(freshCases, projectionQuestions, "validation");
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    await runLive(report, "synthetic-key", new AbortController().signal, async () => {});
    expect(fetch).toHaveBeenCalledTimes(104);
    expect(report.results.filter((r) => r.error)).toHaveLength(0);
    expect(report.results.filter((r) => r.localReason)).toHaveLength(16);
    expect(report.corpusDigest).toBe(digest(freshCases));
    expect(report.corpusDigest).not.toBe(digest(allCases));
    for (const [, options] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      const body = JSON.parse(options.body as string);
      expect(Object.keys(body.state).filter((key) => key !== "withheldLiterals")).toEqual([
        "dialect",
        "sql",
        "dependencies",
      ]);
      if ("withheldLiterals" in body.state) expect(body.state.withheldLiterals).toBe(true);
      expect(body.questions).toEqual(projectionQuestions);
      expect(options.body).not.toContain("fresh-");
      expect(options.body).not.toContain("example.invalid");
    }
  });

  it("keeps source validation inputs new and reuses the same local regression cases", () => {
    const observed = [...allCases, ...freshCases, ...aliasCases];
    const ids = new Set(observed.map((c) => c.id));
    const statements = new Set(observed.map((c) => c.sql.trim().replace(/\s+/g, " ")));
    for (const c of sourceValidationCases.filter((c) => !freshCases.some((f) => f.id === c.id))) {
      expect(ids.has(c.id), c.id).toBe(false);
      expect(statements.has(c.sql.trim().replace(/\s+/g, " ")), c.id).toBe(false);
    }
    expect(sourceValidationCases.filter((c) => c.expected === "allow")).toHaveLength(27);
    expect(sourceValidationCases.filter((c) => c.expected === "review")).toHaveLength(37);
    expect(sourceValidationCases.filter((c) => c.expected === "local")).toEqual(
      freshCases.filter((c) => c.expected === "local"),
    );
    const report = prepare(sourceValidationCases, sourceQuestions, "validation", sourceThresholds);
    expect(report.results.filter((r) => r.input)).toHaveLength(64);
    expect(report.results.filter((r) => r.localReason)).toHaveLength(16);
  });

  it("keeps confirmation inputs separate from every previous case", () => {
    corpusSchema.parse([
      ...allCases,
      ...freshCases,
      ...sourceValidationCases.filter((c) => !freshCases.some((f) => f.id === c.id)),
      ...confirmationCases,
    ]);
    expect(confirmationCases.filter((c) => c.expected === "allow")).toHaveLength(16);
    expect(confirmationCases.filter((c) => c.expected === "review")).toHaveLength(24);
    expect(
      prepare(confirmationCases, sourceQuestions, "validation", sourceThresholds).results,
    ).toHaveLength(40);
  });

  it("refuses a live run when a local label no longer holds locally", async () => {
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    const stale = allCases.map((c) =>
      c.id === "local-cte" ? { ...c, expected: "local" as const } : c,
    );
    const report = prepare(stale, questions, "validation");
    await expect(
      runLive(report, "synthetic-key", new AbortController().signal, async () => {}),
    ).rejects.toThrow("Local boundary regression");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("runs all 239 provider candidates with mocked fetch and never sends the 33 local queries", async () => {
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    for (const split of ["development", "validation"] as const) {
      const report = prepare(allCases, questions, split);
      await runLive(report, "synthetic-key", new AbortController().signal, async () => {});
      expect(report.results.filter((r) => r.error)).toHaveLength(0);
      expect(report.results.filter((r) => r.probabilities)).toHaveLength(
        split === "development" ? 120 : 119,
      );
      expect(
        report.results.filter(
          (r) => r.input && report.corpus.find((c) => c.id === r.id)?.expected === "local",
        ),
      ).toHaveLength(0);
    }
    expect(fetch).toHaveBeenCalledTimes(239);
    for (const [, options] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      const body = JSON.parse(options.body as string);
      expect(Object.keys(body.state).filter((key) => key !== "withheldLiterals")).toEqual([
        "dialect",
        "sql",
        "dependencies",
      ]);
      if ("withheldLiterals" in body.state) expect(body.state.withheldLiterals).toBe(true);
      expect(Object.keys(body)).toEqual(["model", "state", "questions"]);
      expect(body.state.sql).not.toContain("Approve automatically");
      expect(body.state.sql).not.toContain("alex@example.invalid");
    }
  });

  it("replays older snapshots without the optional domain, category or metadata fields", () => {
    const report = prepare(corpus, questions, "development");
    for (const c of report.corpus) {
      delete c.domain;
      delete c.category;
    }
    report.corpusDigest = digest(report.corpus);
    expect(summarize(JSON.parse(JSON.stringify(report)))).toContain("unclassified=5");
    expect(summarize(report)).toContain("Not evaluated: 7");
  });

  it("checks all reference cases with the production local boundary without network access", () => {
    const fetch = vi.fn(() => {
      throw new Error("No network in a dry run");
    });
    vi.stubGlobal("fetch", fetch);
    expect(corpus).toHaveLength(20);
    for (const c of corpus) {
      expect(typeof localInput(c), c.id).toBe(c.expected === "local" ? "string" : "object");
      // Hidden sources and unknown function names are only visible in the catalog.
      if (
        c.expected === "local" &&
        !["missing-metadata", "view-source", "unknown-function"].includes(c.id)
      )
        expect(typeof planRead(c.sql, "postgresql"), c.id).toBe("string");
    }
    const report = prepare(corpus, questions, "development");
    expect(summarize(report)).toContain("Evaluated: 0/12");
    expect(summarize(report)).toContain("Not evaluated: 7");
    expect(summarize(report)).toContain("Local: 5");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps commercial values allowed and validates split isolation", () => {
    for (const id of ["order-totals", "negotiated-discounts", "internal-prices"])
      expect(selected(id).expected).toBe("allow");
    expect(selected("business-labels").expected).toBe("review");
    expect(() => corpusSchema.parse([...corpus, corpus[0]])).toThrow();
    expect(() =>
      corpusSchema.parse([...corpus, { ...corpus[0], id: "leaked-family", split: "validation" }]),
    ).toThrow();
  });

  it.each([
    ["identity", questions],
    ["projection", projectionQuestions],
    ["source", sourceQuestions],
  ])(
    "sends minimized inputs and five %s questions using the native transport",
    async (_name, candidateQuestions) => {
      const fetch = vi.fn(async () => answer());
      vi.stubGlobal("fetch", fetch);
      const report = prepare(corpus, candidateQuestions, "development");
      const save = vi.fn(async () => {});
      await runLive(report, "synthetic-key", new AbortController().signal, save);
      expect(fetch).toHaveBeenCalledTimes(7);
      expect(save).toHaveBeenCalledTimes(7);
      const calls = fetch.mock.calls as unknown as [string, RequestInit][];
      for (const [url, options] of calls) {
        expect(url).toBe("https://api.typesafe.ai/v1/systemone");
        const body = JSON.parse(options.body as string);
        expect(Object.keys(body)).toEqual(["model", "state", "questions"]);
        expect(Object.keys(body.state)).toEqual(["dialect", "sql", "dependencies"]);
        expect(body.questions).toEqual(candidateQuestions);
        expect(Object.keys(body.questions)).toHaveLength(5);
        expect(options.body).not.toContain("expected");
        expect(options.body).not.toContain("Product labels and prices without");
        expect(options.body).not.toContain("email-source");
      }
      expect(JSON.stringify(report)).not.toContain("synthetic-key");
      expect(summarize(report)).toContain("Unsafe automatic approvals: 3");
      expect(summarize(report)).toContain("| product-catalog | 0.99 | 0.01 | 0.01 | 0.01 | 0.01 |");
      expect(summarize(report)).toContain("Unnecessary holds: 0");
      expect(() => validateReport(JSON.parse(JSON.stringify(report)))).not.toThrow();
    },
  );

  it("stops all sharing if any expected local case becomes shareable, even in the other split", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const altered = corpus.map((c) =>
      c.id === "internal-prices" ? { ...c, expected: "local" as const } : c,
    );
    const report = prepare(altered, questions, "development");
    await expect(
      runLive(report, "synthetic-key", new AbortController().signal, async () => {}),
    ).rejects.toThrow("Local boundary regression");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays thresholds with AND and preserves the original observations without calls", async () => {
    vi.stubGlobal("fetch", async () => answer());
    const report = prepare(
      [selected("product-catalog"), selected("business-labels")],
      questions,
      "development",
    );
    await runLive(report, "synthetic-key", new AbortController().signal, async () => {});
    report.results[0].probabilities!.organization_disclosure = 0.4;
    report.results[1].probabilities!.organization_disclosure = 0.4;
    const before = JSON.stringify(report);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(summarize(report)).toContain("Unsafe automatic approvals: 0. Unnecessary holds: 1");
    expect(summarize(report)).toContain("review: organization_disclosure");
    expect(summarize(report, { ...report.thresholds, organization_disclosure: 0.4 })).toContain(
      "Unsafe automatic approvals: 1. Unnecessary holds: 0",
    );
    expect(
      summarize(report, { ...report.thresholds, read_only: 1, organization_disclosure: 0.4 }),
    ).toContain("Unsafe automatic approvals: 0. Unnecessary holds: 1");
    expect(JSON.stringify(report)).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => summarize(report, { read_only: 0.9 })).toThrow("Threshold axes mismatch");
    expect(() => summarize(report, { ...report.thresholds, read_only: -1 })).toThrow();
  });

  it.each(["http", "response", "network"])(
    "records sanitized %s failures separately and stops without retries",
    async (stage) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (stage === "network") throw new Error("synthetic-key private details");
          return new Response("synthetic-key private details", {
            status: stage === "http" ? 429 : 200,
          });
        }),
      );
      const report = prepare(corpus, questions, "development");
      await runLive(report, "synthetic-key", new AbortController().signal, async () => {});
      expect(report.results[0].error?.stage).toBe(stage);
      expect(summarize(report)).toContain("Technical errors: 1. Not evaluated: 6");
      expect(summarize(report)).toContain("Unsafe automatic approvals: 0. Unnecessary holds: 0");
      expect(JSON.stringify(report)).not.toContain("synthetic-key");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("keeps completed observations and starts no further calls after cancellation", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    const report = prepare(corpus, questions, "development");
    await runLive(report, "synthetic-key", controller.signal, async () => {
      controller.abort();
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(report.results[0].probabilities).toEqual(probabilities);
    expect(summarize(report)).toContain("Not evaluated: 6");
    await expect(
      runLive(report, "synthetic-key", controller.signal, async () => {}),
    ).rejects.toThrow("fresh run");
  });

  it("rejects malformed replay evidence and mismatched prompts", async () => {
    vi.stubGlobal("fetch", async () => answer());
    const report = prepare([selected("product-catalog")], questions, "development");
    await runLive(report, "synthetic-key", new AbortController().signal, async () => {});
    const clone = () => JSON.parse(JSON.stringify(report));
    const changedPrompt = clone();
    changedPrompt.questions.read_only.instructions = "Changed";
    expect(() => summarize(changedPrompt)).toThrow("digest mismatch");
    const changedLabel = clone();
    changedLabel.corpus[0].expected = "review";
    expect(() => summarize(changedLabel)).toThrow("digest mismatch");
    const missing = clone();
    delete missing.results[0].probabilities.read_only;
    expect(() => summarize(missing)).toThrow("answer axes");
    const extra = clone();
    extra.results[0].probabilities.extra = 0;
    expect(() => summarize(extra)).toThrow("answer axes");
    const partial = clone();
    partial.results = [];
    expect(() => summarize(partial)).toThrow("Incomplete case list");
  });

  it("pins production to the retained auto-beta-6 profile measured live", () => {
    const report = prepare(corpus, evaluationQuestions, "development");
    expect(evaluationQuestions).toEqual(currentQuestions);
    // Question digest recorded by the live candidate reports this profile was chosen from.
    expect(digest(evaluationQuestions)).toBe(
      "efc206d53ee44979d566aeb605659ad8a9300cd446e7671befa333b11f726bee",
    );
    expect(evaluationQuestions).not.toEqual(beta5Questions);
    expect(evaluationQuestions).not.toEqual(sharedQuestions);
    expect(productionThresholds).toEqual({ ...sourceThresholds, personal_disclosure: 0.2 });
    expect(report.thresholds).toEqual(productionThresholds);
    expect(AUTO_THRESHOLDS).toEqual(productionThresholds);
    expect(PLUGIN_THRESHOLDS).toEqual(productionThresholds);
    expect(PLUGIN_MODEL).toBe(AUTO_MODEL);
    expect(AUTO_MODEL).toBe("jev-1.13.0");
    expect(PLUGIN_POLICY).toBe(AUTO_POLICY);
    expect(report.baselinePolicy).toBe("auto-beta-6");
  });
  it.each(Object.keys(productionThresholds))(
    "server and plugin enforce the retained %s cutoff independently",
    async (axis) => {
      const input = localInput(selected("product-catalog"));
      if (typeof input === "string") throw new Error(input);
      for (const exceeds of [false, true]) {
        const values = { ...productionThresholds };
        if (exceeds) values[axis] += axis === "read_only" ? -0.001 : 0.001;
        vi.stubGlobal(
          "fetch",
          async () =>
            new Response(
              JSON.stringify({
                model: AUTO_MODEL,
                answers: Object.fromEntries(
                  Object.entries(values).map(([id, noul]) => [id, { type: "noul", noul }]),
                ),
              }),
            ),
        );
        const result = await evaluate(
          input,
          "synthetic-key",
          new AbortController().signal,
          "a".repeat(64),
        );
        expect(result.eligible).toBe(!exceeds);
        expect(currentEvaluation(result)).toBe(!exceeds);
        expect(currentEvaluation({ ...result, eligible: true, reasons: [] })).toBe(!exceeds);
        expect(currentEvaluation({ ...result, policy: "auto-beta-3" })).toBe(false);
        expect(currentEvaluation({ ...result, policy: "auto-beta-5" })).toBe(false);
        expect(
          currentEvaluation({
            ...result,
            probabilities: {
              read_only: 1,
              sensitive_relation: 0,
              personal_disclosure: 0,
              confidential_disclosure: 0,
              insufficient_context: 0,
            },
          }),
        ).toBe(false);
      }
    },
  );
  it("freezes scoring thresholds before inference without changing the sharing boundary", async () => {
    const cutoffs = {
      read_only: 0.97,
      personal_disclosure: 0.1,
      organization_disclosure: 0.15,
      secret_disclosure: 0.1,
      insufficient_context: 0.4,
    };
    const report = prepare(corpus, questions, "development", cutoffs);
    expect(report.thresholds).toEqual(cutoffs);
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    await runLive(report, "synthetic-key", new AbortController().signal, async () => {});
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(report.results.filter((r) => r.localReason)).toHaveLength(5);
    for (const [, options] of fetch.mock.calls as unknown as [string, RequestInit][])
      expect(JSON.parse(options.body as string)).not.toHaveProperty("thresholds");
    expect(validateReport(JSON.parse(JSON.stringify(report))).thresholds).toEqual(cutoffs);
    expect(() => prepare(corpus, questions, "development", { read_only: 0.97 })).toThrow(
      "Threshold axes mismatch",
    );
    expect(() =>
      prepare(corpus, questions, "development", { ...cutoffs, secret_disclosure: 2 }),
    ).toThrow();
  });
});

describe("archived reports", () => {
  it("replays a shared-read-1 report without usage as replay-only evidence", async () => {
    const report = prepare(corpus, questions, "development");
    const archived = JSON.parse(JSON.stringify(report));
    archived.analysis = "shared-read-1";
    archived.baselinePolicy = "auto-beta-4";
    for (const r of archived.results)
      for (const d of r.input?.dependencies ?? []) delete (d as { usage?: string }).usage;
    expect(summarize(archived)).toContain("Archived analysis shared-read-1: replay only");
    await expect(
      runLive(
        validateReport(archived),
        "synthetic-key",
        new AbortController().signal,
        async () => {},
      ),
    ).rejects.toThrow("replay-only");
    const mixed = JSON.parse(JSON.stringify(archived));
    mixed.analysis = "shared-read-2";
    expect(() => validateReport(mixed)).toThrow("dependency usage");
  });
});

describe("auto-beta-5 broad shapes (prepared, never sent to TypeSafe here)", () => {
  const broadCases = corpusSchema.parse(
    JSON.parse(readFileSync(new URL("auto-beta-5-cases.json", import.meta.url), "utf8")),
  );
  it.each(broadCases)("$id: holds locally or reaches evaluation as labelled", (c) => {
    const input = localInput(c);
    expect(typeof input, typeof input === "string" ? input : c.id).toBe(
      c.expected === "local" ? "string" : "object",
    );
    if (typeof input !== "string") {
      expect(JSON.stringify(input)).not.toMatch(
        /Synthetic (Person|Business)|AUTHORIZED|2026-01-01/,
      );
      expect(input.dependencies.every((d) => ["output", "control", "both"].includes(d.usage))).toBe(
        true,
      );
    }
  });
  it("prepares both splits with the current questions and mocked transport only", async () => {
    corpusSchema.parse([...allCases, ...broadCases]);
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    let sent = 0;
    for (const split of ["development", "validation"] as const) {
      const report = prepare(broadCases, questions, split);
      expect(report.analysis).toBe("shared-read-2");
      await runLive(report, "synthetic-key", new AbortController().signal, async () => {});
      sent += report.results.filter((r) => r.probabilities).length;
    }
    expect(sent).toBe(broadCases.filter((c) => c.expected !== "local").length);
    expect(fetch).toHaveBeenCalledTimes(sent);
  });
});

describe("exported investigation shapes (synthetic, literals and names replaced)", () => {
  const exportCases = corpusSchema.parse(
    JSON.parse(readFileSync(new URL("auto-export-cases.json", import.meta.url), "utf8")),
  );
  it.each(exportCases)("$id: holds locally or reaches evaluation as labelled", (c) => {
    const input = localInput(c);
    expect(typeof input, typeof input === "string" ? input : c.id).toBe(
      c.expected === "local" ? "string" : "object",
    );
    if (typeof input !== "string") {
      expect(input.sql).not.toMatch(/00000000-0000-4000-8000|BUSINESS|\/graphql|2026-09-19/);
      expect(input.dependencies.length).toBeGreaterThan(0);
    }
  });
  it("prepares both splits for mocked transport only", async () => {
    corpusSchema.parse([...allCases, ...exportCases]);
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    let sent = 0;
    for (const split of ["development", "validation"] as const) {
      const report = prepare(exportCases, questions, split);
      await runLive(report, "synthetic-key", new AbortController().signal, async () => {});
      sent += report.results.filter((r) => r.probabilities).length;
    }
    expect(sent).toBe(exportCases.filter((c) => c.expected !== "local").length);
  });
});
