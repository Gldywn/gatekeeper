import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { analyzeWithFixture, type FixtureOptions } from "../../plugin/src/sql/pg/catalog-fixture";
import { loadPgParser } from "../../plugin/src/sql/pg/parse";
import { planRead } from "../../plugin/src/sql/read-analysis";
import {
  AUTO_POLICY,
  AUTO_THRESHOLDS,
  canonicalBaseUrl,
  DEFAULT_EVALUATOR,
  EvaluationError,
  type EvaluatorConfig,
  endpointOf,
  evaluateProbabilities,
  evaluationInput,
  evaluationQuestions,
  evaluatorConfig,
} from "../src/evaluator.js";

const probability = z.number().finite().min(0).max(1);
const identifier = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const questionSchema = z
  .record(
    identifier,
    z
      .object({
        type: z.literal("noul"),
        instructions: z.string().min(1),
        criteria: z.object({ true: z.string().min(1), false: z.string().min(1) }).strict(),
      })
      .strict(),
  )
  .refine((q) => Object.keys(q).length > 0, "At least one question required");
const caseSchema = z
  .object({
    id: identifier,
    family: identifier,
    split: z.enum(["development", "validation"]),
    expected: z.enum(["allow", "review", "local"]),
    domain: z.string().min(1).optional(),
    category: z
      .enum([
        "ordinary",
        "pii",
        "client",
        "sensitive-value",
        "context",
        "read-only",
        "unsupported",
        "metadata",
      ])
      .optional(),
    reason: z.string().min(1),
    sql: z.string().min(1).max(12000),
    columns: z.record(z.string()),
    relations: z.record(z.record(z.string())).optional(),
    relationKind: z.enum(["r", "v", "f"]).optional(),
    metadata: z
      .object({
        relrowsecurity: z.boolean().optional(),
        relhassubclass: z.boolean().optional(),
        attgenerated: z.string().optional(),
        type_schema: z.string().optional(),
        catalog_first: z.boolean().optional(),
        builtin_resolution: z.boolean().optional(),
        collation_schema: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const corpusSchema = z
  .array(caseSchema)
  .min(1)
  .superRefine((cases, ctx) => {
    const ids = new Set<string>();
    const statements = new Set<string>();
    const families = new Map<string, string>();
    for (const c of cases) {
      const statement = c.sql.trim().replace(/\s+/g, " ");
      if (
        ids.has(c.id) ||
        statements.has(statement) ||
        (families.has(c.family) && families.get(c.family) !== c.split)
      ) {
        ctx.addIssue({ code: "custom", message: "Duplicate case, SQL or family crossing splits" });
      }
      ids.add(c.id);
      statements.add(statement);
      families.set(c.family, c.split);
    }
  });
export type Case = z.infer<typeof caseSchema>;
// Archived reports predate dependency usage. They stay readable for replay only.
const legacyInput = evaluationInput.extend({
  dependencies: z
    .array(
      z
        .object({
          schema: z.string().min(1).max(63),
          table: z.string().min(1).max(63),
          column: z.string().min(1).max(63),
          type: z.string().min(1).max(63),
        })
        .strict(),
    )
    .max(64),
});
// shared-read-3: Jev's SQL is rendered from PostgreSQL's own parse tree, no longer by node-sql-parser.
export const ANALYSIS = "shared-read-3";
const resultSchema = z
  .object({
    id: identifier,
    input: z.union([evaluationInput, legacyInput]).optional(),
    localReason: z.string().optional(),
    probabilities: z.record(probability).optional(),
    elapsedMs: z.number().nonnegative().optional(),
    // Clef only: the request's bytes and the tokens it reported, kept from complete answers.
    bodyBytes: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    error: z
      .object({
        stage: z.enum(["input", "network", "http", "response", "cancelled", "internal"]),
        status: z.number().int().min(100).max(599).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const reportSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string().datetime(),
    model: z.string().min(1).max(100),
    // Absent from reports made before the evaluator choice: TypeSafe, jev-1.13.0.
    evaluator: evaluatorConfig.optional(),
    baselinePolicy: z.string().min(1),
    analysis: z.enum(["shared-read-1", "shared-read-2", ANALYSIS]).optional(),
    mode: z.enum(["dry", "live"]),
    split: z.enum(["development", "validation"]),
    corpus: corpusSchema,
    corpusDigest: z.string(),
    questions: questionSchema,
    questionDigest: z.string(),
    thresholds: z.record(probability),
    results: z.array(resultSchema),
  })
  .strict();
export type Report = z.infer<typeof reportSchema>;

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function localInput(c: Case) {
  const plan = planRead(c.sql, "postgresql");
  if (typeof plan === "string") return plan;
  const m = c.metadata ?? {};
  // Legacy case flags map onto the synthetic catalog; none of this is a live catalog.
  const custom = m.type_schema !== undefined && m.type_schema !== "pg_catalog";
  const column = (type: string) => ({
    type: custom ? "legacy_custom" : type,
    generated: m.attgenerated ?? "",
    collationCore: m.collation_schema == null || m.collation_schema === "pg_catalog",
  });
  const relations = Object.fromEntries(
    plan.relations.map((r) => {
      const columns =
        c.relations?.[`${r.schema}.${r.table}`] ?? (plan.relations.length === 1 ? c.columns : {});
      return [
        `${r.schema}.${r.table}`,
        Object.fromEntries(Object.entries(columns).map(([name, type]) => [name, column(type)])),
      ];
    }),
  );
  const options: FixtureOptions = {
    catalogFirst: m.catalog_first ?? true,
    relation: {
      relkind: c.relationKind ?? "r",
      rls: m.relrowsecurity ?? false,
      inherited: m.relhassubclass ?? false,
    },
    types: [{ name: "legacy_custom", ioCore: false }],
    ...(m.builtin_resolution === false
      ? {
          operators: plan.operators.map((name) => ({
            name,
            left: "anyelement",
            right: "anyelement",
            result: "bool",
            code: "legacy_op",
            schema: "public",
          })),
          functions: plan.functions.map((name) => ({
            name,
            args: ["any"],
            variadic: "any",
            result: "text",
            schema: "public",
          })),
        }
      : {}),
  };
  const snapshot = analyzeWithFixture(c.sql, relations, options);
  return snapshot.input ?? snapshot.reasons.join(". ");
}

function sameKeys(a: object, b: object): boolean {
  return Object.keys(a).sort().join(",") === Object.keys(b).sort().join(",");
}

export function validateReport(raw: unknown): Report {
  const report = reportSchema.parse(raw);
  if (
    digest(report.corpus) !== report.corpusDigest ||
    digest(report.questions) !== report.questionDigest
  )
    throw new Error("Corpus or question digest mismatch");
  if (!sameKeys(report.thresholds, report.questions)) throw new Error("Threshold axes mismatch");
  if (report.evaluator && report.evaluator.model !== report.model)
    throw new Error("Report model and evaluator disagree");
  if (
    report.analysis === ANALYSIS &&
    report.results.some((r) => r.input && !evaluationInput.safeParse(r.input).success)
  )
    throw new Error("Current analysis reports need dependency usage");
  const selected = report.corpus.filter((c) => c.split === report.split);
  if (report.results.length !== selected.length) throw new Error("Incomplete case list");
  for (const [index, c] of selected.entries()) {
    const r = report.results[index];
    if (r.id !== c.id || Boolean(r.input) === Boolean(r.localReason))
      throw new Error("Invalid case provenance");
    if (
      (r.probabilities || r.error) &&
      (!r.input || c.expected === "local" || report.mode !== "live")
    )
      throw new Error("A local or dry case cannot have a provider result");
    if (r.probabilities && (r.error || !sameKeys(r.probabilities, report.questions)))
      throw new Error("Invalid answer axes");
  }
  return report;
}

export function prepare(
  corpus: Case[],
  questions: Report["questions"],
  split: Report["split"],
  thresholds?: Record<string, number>,
  evaluator: EvaluatorConfig = DEFAULT_EVALUATOR,
): Report {
  const builtIn =
    evaluator.provider === "typesafe" && digest(questions) === digest(evaluationQuestions);
  return validateReport({
    version: 1,
    createdAt: new Date().toISOString(),
    model: evaluator.model,
    evaluator,
    baselinePolicy: AUTO_POLICY,
    analysis: ANALYSIS,
    mode: "dry",
    split,
    corpus,
    corpusDigest: digest(corpus),
    questions,
    questionDigest: digest(questions),
    // Only jev-1.13.0 has cutoffs to start from; another model starts at zero, which passes only
    // an exact zero, until --propose measures its own, so no inherited number passes for it.
    thresholds:
      thresholds ??
      (builtIn
        ? AUTO_THRESHOLDS
        : Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              id === "read_only" ? 0.99 : evaluator.provider === "typesafe" ? 0.01 : 0,
            ]),
          )),
    results: corpus
      .filter((c) => c.split === split)
      .map((c) => {
        const input = localInput(c);
        return typeof input === "string" ? { id: c.id, localReason: input } : { id: c.id, input };
      }),
  });
}

export async function runLive(
  report: Report,
  key: string,
  signal: AbortSignal,
  save: () => Promise<void>,
) {
  validateReport(report);
  if (report.analysis !== ANALYSIS)
    throw new Error(
      "Archived reports are replay-only. Prepare a fresh report for the current analysis",
    );
  // The local boundary is part of the policy: a report prepared under an older one would pass
  // its results off as evidence for inputs it never decided.
  if (report.baselinePolicy !== AUTO_POLICY)
    throw new Error("Prepared under another policy. Prepare a fresh report for the current one");
  // Check the whole corpus before any sharing, even cases outside this run's split.
  if (report.corpus.some((c) => c.expected === "local" && typeof localInput(c) !== "string"))
    throw new Error("Local boundary regression: no provider calls permitted");
  if (report.mode !== "dry")
    throw new Error("Start a fresh run instead of overwriting observations");
  const config = report.evaluator ?? DEFAULT_EVALUATOR;
  // Clef's runs are also the evidence its input bound waits for, so they measure it.
  const measures = Boolean(endpointOf(config)?.window);
  report.mode = "live";
  for (const r of report.results) {
    if (!r.input || signal.aborted) continue;
    const started = performance.now();
    let observed: { bodyBytes: number; inputTokens: number } | undefined;
    try {
      r.probabilities = await evaluateProbabilities(
        evaluationInput.parse(r.input),
        key,
        AbortSignal.any([signal, AbortSignal.timeout(12000)]),
        report.questions,
        config,
        measures
          ? (bodyBytes, inputTokens) => {
              observed = { bodyBytes, inputTokens };
            }
          : undefined,
      );
      // Kept only once the whole answer passed: a call that failed later is no evidence.
      if (observed) Object.assign(r, observed);
    } catch (error) {
      r.error =
        error instanceof EvaluationError
          ? { stage: error.stage, ...(error.status ? { status: error.status } : {}) }
          : { stage: "internal" };
    }
    r.elapsedMs = Math.round(performance.now() - started);
    await save();
    // A broken transport is not model evidence. Keep completed observations, no retries.
    if (r.error) break;
  }
}

// What --propose writes and --thresholds reads back: the cutoffs with what they were measured on,
// so a validation replay cannot pair them with another evaluator, questionnaire or corpus.
export const proposalSchema = z
  .object({
    cutoffs: z.record(probability),
    evaluator: evaluatorConfig,
    analysis: z.string(),
    questionDigest: z.string(),
    corpusDigest: z.string(),
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;

export interface ProposalResult {
  status: "proposed" | "stalled" | "infeasible" | "no-evidence";
  proposal?: Proposal;
  allowAdmitted: number;
  allowTotal: number;
  reviewTotal: number;
  minHoldingDistance?: number;
}

// Admits safe reads least risky first, raising every cutoff a read needs at once, and only while
// every risky read stays held by one axis with a margin: safe on these cases, not optimal.
export function propose(raw: unknown, margin = 0.02): ProposalResult {
  const report = validateReport(raw);
  if (report.mode !== "live" || report.split !== "development" || report.analysis !== ANALYSIS)
    throw new Error("Propose from a live development report for the current analysis");
  // Cutoffs are for the questions that run, where a higher probability always means review:
  // another questionnaire, or one with an inverted axis such as read_only, proposes nothing.
  if (
    report.baselinePolicy !== AUTO_POLICY ||
    report.questionDigest !== digest(evaluationQuestions)
  )
    throw new Error("Propose only from the production questions and policy");
  if (report.corpus.some((c) => c.expected === "local" && typeof localInput(c) !== "string"))
    throw new Error("Local boundary regression: no proposal");
  const cases = report.corpus.filter((c) => c.split === report.split);
  const observed = report.results.flatMap((r, i) => (r.input ? [{ r, c: cases[i] }] : []));
  if (observed.some(({ r }) => r.error || !r.probabilities))
    throw new Error("Incomplete observations: rerun the split, an interrupted run is no evidence");
  const axes = Object.keys(report.questions);
  const allow = observed.filter(({ c }) => c.expected === "allow").map(({ r }) => r.probabilities!);
  const review = observed
    .filter(({ c }) => c.expected === "review")
    .map(({ r }) => r.probabilities!);
  const result = { allowAdmitted: 0, allowTotal: allow.length, reviewTotal: review.length };
  if (!allow.length || !review.length) return { status: "no-evidence", ...result };
  const zero = Object.fromEntries(axes.map((a) => [a, 0]));
  const held = (c: Record<string, number>, p: Record<string, number>) =>
    axes.some((a) => p[a] > c[a] + margin);
  if (!review.every((p) => held(zero, p))) return { status: "infeasible", ...result };
  const admitted = (c: Record<string, number>) =>
    allow.filter((p) => axes.every((a) => p[a] <= c[a])).length;
  // Cutoffs only grow, so a read skipped once stays out of reach: one pass is enough.
  const worst = (p: Record<string, number>) => Math.max(...axes.map((a) => p[a]));
  const total = (p: Record<string, number>) => axes.reduce((sum, a) => sum + p[a], 0);
  const order = allow
    .map((p, i) => ({ p, i }))
    .sort((x, y) => worst(x.p) - worst(y.p) || total(x.p) - total(y.p) || x.i - y.i);
  let cutoffs = zero;
  for (const { p } of order) {
    const next = Object.fromEntries(axes.map((a) => [a, Math.max(cutoffs[a], p[a])]));
    if (review.every((r) => held(next, r))) cutoffs = next;
  }
  const distances = review.map((p) => Math.max(...axes.map((a) => p[a] - cutoffs[a])));
  return {
    status: admitted(cutoffs) ? "proposed" : "stalled",
    proposal: {
      cutoffs,
      evaluator: report.evaluator ?? DEFAULT_EVALUATOR,
      analysis: ANALYSIS,
      questionDigest: report.questionDigest,
      corpusDigest: report.corpusDigest,
    },
    ...result,
    allowAdmitted: admitted(cutoffs),
    minHoldingDistance: Math.min(...distances),
  };
}

// Plain cutoffs replay as before; a proposal replays only on what it was measured on.
function cutoffsFor(report: Report, thresholds: unknown): Record<string, number> {
  const proposal = proposalSchema.safeParse(thresholds);
  if (!proposal.success) return z.record(probability).parse(thresholds ?? report.thresholds);
  const p = proposal.data;
  const same =
    JSON.stringify(p.evaluator) === JSON.stringify(report.evaluator ?? DEFAULT_EVALUATOR) &&
    p.analysis === report.analysis &&
    p.questionDigest === report.questionDigest &&
    p.corpusDigest === report.corpusDigest;
  if (!same) throw new Error("Proposal measured on another evaluator, questions or corpus");
  return p.cutoffs;
}

export function summarize(raw: unknown, thresholds?: unknown): string {
  const report = validateReport(raw);
  const cutoffs = cutoffsFor(report, thresholds);
  if (!sameKeys(cutoffs, report.questions)) throw new Error("Threshold axes mismatch");
  const cases = report.corpus.filter((c) => c.split === report.split);
  const evaluatedCases = cases.filter((c) =>
    report.results.some((r) => r.id === c.id && r.probabilities),
  );
  const localCases = cases.filter((c) => c.expected === "local");
  const counts = {
    unsafeAuto: 0,
    safeHeld: 0,
    errors: 0,
    unmeasured: 0,
    evaluated: 0,
    local: 0,
    localRegressions: 0,
  };
  const rows = report.results.map((r) => {
    const c = report.corpus.find((c) => c.id === r.id)!;
    let outcome: string;
    if (c.expected === "local" && r.input) {
      counts.localRegressions++;
      outcome = "LOCAL REGRESSION";
    } else if (r.localReason) {
      counts.local++;
      if (c.expected === "allow") counts.safeHeld++;
      outcome = `local: ${r.localReason}`;
    } else if (r.error) {
      counts.errors++;
      outcome = `error: ${r.error.stage}${r.error.status ? ` HTTP ${r.error.status}` : ""}`;
    } else if (!r.probabilities) {
      counts.unmeasured++;
      outcome = "not evaluated";
    } else {
      counts.evaluated++;
      const failed = Object.entries(r.probabilities)
        .filter(([id, p]) => (id === "read_only" ? p < cutoffs[id] : p > cutoffs[id]))
        .map(([id]) => id);
      if (!failed.length && c.expected !== "allow") counts.unsafeAuto++;
      if (failed.length && c.expected === "allow") counts.safeHeld++;
      outcome = failed.length
        ? `review: ${failed.join(", ")}`
        : c.expected === "allow"
          ? "allow"
          : "UNSAFE AUTO";
    }
    return `| ${c.id} | ${c.expected} | ${outcome} |`;
  });
  const evaluator = report.evaluator ?? DEFAULT_EVALUATOR;
  const measured = report.results.flatMap((r) =>
    r.bodyBytes !== undefined && r.inputTokens !== undefined ? [r] : [],
  );
  return [
    `# Auto evaluation (${report.split}, ${report.mode})`,
    "",
    `Evaluator: ${JSON.stringify(evaluator)}. Baseline policy: ${report.baselinePolicy}.`,
    // The evidence CLEF_BOUND_VERIFIED waits for: tokens never above the request's bytes.
    ...(measured.length
      ? [
          `Input bound over ${measured.length} complete answers: largest tokens minus bytes ${Math.max(...measured.map((r) => r.inputTokens! - r.bodyBytes!))}, largest request ${Math.max(...measured.map((r) => r.bodyBytes!))} bytes.`,
        ]
      : []),
    ...(report.analysis === ANALYSIS
      ? []
      : [
          `Archived analysis ${report.analysis ?? "unmarked"}: replay only. These observations are not evidence for analysis ${ANALYSIS} or policy ${AUTO_POLICY}.`,
        ]),
    `Questions: ${report.questionDigest}. Corpus: ${report.corpusDigest}.`,
    "",
    `Unsafe automatic approvals: ${counts.unsafeAuto}. Unnecessary holds: ${counts.safeHeld}.`,
    `Technical errors: ${counts.errors}. Not evaluated: ${counts.unmeasured}.`,
    `Evaluated: ${counts.evaluated}/${report.results.length}. Local: ${counts.local}. Local regressions: ${counts.localRegressions}.`,
    `Evaluated allow references: ${evaluatedCases.filter((c) => c.expected === "allow").length}/${cases.filter((c) => c.expected === "allow").length}. Evaluated review references: ${evaluatedCases.filter((c) => c.expected === "review").length}/${cases.filter((c) => c.expected === "review").length}.`,
    `Local references by primary reason: ${["pii", "client", "sensitive-value", "read-only", "unsupported", "metadata"].map((category) => `${category}=${localCases.filter((c) => c.category === category).length}`).join(", ")}, unclassified=${localCases.filter((c) => !c.category).length}.`,
    `Thresholds: ${JSON.stringify(cutoffs)}. read_only uses >=, all other axes use <=. All must pass.`,
    "",
    "| Case | Expected | Observed |",
    "| :--- | :--- | :--- |",
    ...rows,
    "",
    ...(report.results.some((r) => r.probabilities)
      ? [
          `| Case | ${Object.keys(report.questions).join(" | ")} |`,
          `| :--- | ${Object.keys(report.questions)
            .map(() => "---:")
            .join(" | ")} |`,
          ...report.results
            .filter((r) => r.probabilities)
            .map(
              (r) =>
                `| ${r.id} | ${Object.keys(report.questions)
                  .map((id) => r.probabilities![id])
                  .join(" | ")} |`,
            ),
          "",
        ]
      : []),
    "Synthetic cases are not a privacy guarantee or a calibrated error rate.",
    "Local and unsupported cases do not measure Jev accuracy. Related projections are not independent samples.",
    "Validation families stop being held out once their answers inform tuning.",
    "",
  ].join("\n");
}

// The same evaluator shapes and URL rules as the broker, so the bench measures what runs.
export function evaluatorFromFlags(values: {
  provider?: string;
  model?: string;
  "base-url"?: string;
  "account-id"?: string;
}): EvaluatorConfig {
  const url = values["base-url"];
  const account = values["account-id"];
  // A flag the evaluator does not take is a mistake, and the key meant for one destination must
  // not reach the default: refuse rather than ignore.
  if (!values.provider) {
    if (values.model !== undefined || url !== undefined || account !== undefined)
      throw new Error("Name the evaluator with --provider");
    return DEFAULT_EVALUATOR;
  }
  if (url !== undefined && values.provider !== "custom")
    throw new Error("--base-url is for --provider custom");
  if (account !== undefined && values.provider !== "cloudflare")
    throw new Error("--account-id is for --provider cloudflare");
  const extra =
    values.provider === "custom"
      ? { baseUrl: canonicalBaseUrl(url ?? "") ?? url ?? "" }
      : values.provider === "cloudflare"
        ? { accountId: account ?? "" }
        : {};
  const config = evaluatorConfig.parse({
    provider: values.provider,
    model: values.model,
    ...extra,
  });
  if (!endpointOf(config))
    throw new Error("A Custom server URL is https, or plain http to 127.0.0.1 or [::1]");
  return config;
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const load = async (path: string) => JSON.parse(await readFile(resolve(root, path), "utf8"));

async function main() {
  if (!(await loadPgParser())) throw new Error("PostgreSQL parser failed to load");
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      replay: { type: "string" },
      corpus: { type: "string" },
      questions: { type: "string" },
      thresholds: { type: "string" },
      split: { type: "string", default: "development" },
      out: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "account-id": { type: "string" },
      propose: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      [
        "eval:auto [--live] [--provider typesafe|cloudflare|custom --model <m> [--account-id <id>] [--base-url <url>]] [--corpus <json>] [--questions <json>] [--thresholds <json>] [--split development|validation] [--out <json>]",
        "eval:auto --propose <live development report> [--out <proposal json>]",
        "eval:auto --replay <json> [--thresholds <json or proposal>]",
        "Paths are repository-relative. Live runs read the key from GATEKEEPER_EVALUATOR_KEY (TYPESAFE_API_KEY still works for TypeSafe), provisioned by the operator; a Custom server may go without one.",
      ].join("\n"),
    );
    return;
  }
  if (values.propose) {
    if (values.live || values.replay || values.corpus || values.questions)
      throw new Error("Propose reads one development report and calls no provider");
    const result = propose(await load(values.propose));
    console.log(
      [
        `Proposal: ${result.status}.`,
        `Safe reads let through: ${result.allowAdmitted}/${result.allowTotal}.`,
        // Only a vector that exists holds anything; infeasible means some risky read is not held.
        ...(result.proposal
          ? [`Risky reads held by a margin: ${result.reviewTotal}/${result.reviewTotal}.`]
          : []),
        ...(result.minHoldingDistance !== undefined
          ? [`Smallest margin holding a risky read: ${result.minHoldingDistance.toFixed(3)}.`]
          : []),
        ...(result.proposal ? [`Cutoffs: ${JSON.stringify(result.proposal.cutoffs)}.`] : []),
        "Synthetic development cases: replay validation once with these cutoffs, never retune on it.",
      ].join("\n"),
    );
    if (result.proposal && result.status === "proposed" && values.out) {
      const path = resolve(root, values.out);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(result.proposal, null, 2), { flag: "wx" });
      console.log(`Proposal: ${path}`);
    }
    return;
  }
  if (values.replay) {
    if (values.live || values.corpus || values.questions || values.out)
      throw new Error(
        "Replay cannot change corpus or questions, call the provider or overwrite observations",
      );
    console.log(
      summarize(
        await load(values.replay),
        values.thresholds ? await load(values.thresholds) : undefined,
      ),
    );
    return;
  }
  const corpus = corpusSchema.parse(
    await load(values.corpus ?? "packages/server/evals/auto-cases.json"),
  );
  const questions = questionSchema.parse(
    values.questions ? await load(values.questions) : evaluationQuestions,
  );
  const split = z.enum(["development", "validation"]).parse(values.split);
  const evaluator = evaluatorFromFlags(values);
  const report = prepare(
    corpus,
    questions,
    split,
    values.thresholds ? await load(values.thresholds) : undefined,
    evaluator,
  );
  if (!values.live && !values.out) {
    console.log(summarize(report));
    return;
  }
  const path = resolve(root, values.out ?? `.orch/auto-evals/${Date.now()}-${split}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2), { flag: "wx" });
  const save = () => writeFile(path, JSON.stringify(report, null, 2));
  if (values.live) {
    // Never load .env, plugin storage or broker credentials. Only the operator provisions this process.
    const key =
      process.env.GATEKEEPER_EVALUATOR_KEY ??
      (evaluator.provider === "typesafe" ? process.env.TYPESAFE_API_KEY : undefined) ??
      "";
    if (!key && evaluator.provider !== "custom")
      throw new Error("The operator must provision GATEKEEPER_EVALUATOR_KEY for --live");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      await runLive(report, key, controller.signal, async () => {
        await save();
        console.log(
          `Saved ${report.results.filter((r) => r.probabilities || r.error).length}/${report.results.filter((r) => r.input).length} evaluator observations`,
        );
      });
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    await save();
  }
  console.log(summarize(report));
  console.log(`Report: ${path}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Input validation and filesystem errors can include file contents or environment values.
    console.error(
      "Evaluation bench failed. Check JSON inputs, output path and operator key provisioning. No error body is printed.",
    );
    process.exitCode = 1;
  });
}
