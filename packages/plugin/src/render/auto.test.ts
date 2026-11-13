import type { ApprovalAttribution } from "@gatekeeper/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, settingsFor } from "../evaluator";
import { AUTO_POLICY, AUTO_THRESHOLDS } from "../sql/auto";
import { activityEntryHtml } from "./activity";
import { approvalHtml, autoPopHtml, autoSettingsHtml, evaluatorPageHtml } from "./auto";
import { modeDropdown } from "./controls";
import { detailHtml } from "./detail";
import { auditItem, recentRowHtml } from "./inbox";
import { AUTO_EVALUATING, cardHtml } from "./queue";

describe("Auto mode surfaces", () => {
  it("discloses provider sharing before either activation entry point", () => {
    const pop = autoPopHtml(DEFAULT_SETTINGS);
    const off = pop.slice(pop.indexOf("sa-off"), pop.indexOf("sa-on"));
    expect(off).toContain("<span data-auto-recipient>TypeSafe</span> receives the SQL structure");
    expect(off).toContain("never result rows");
    expect(off).toContain("Enable Auto mode");
    expect(pop).not.toContain('type="password"');
    // Read as a human sees it, emphasis stripped: it stays as short as Sharper queries,
    // says reads run on their own, and says writes never do.
    const disclosure = (off.match(/<p>(.+?)<\/p>/s)?.[1] ?? "").replace(/<[^>]+>/g, "");
    expect(disclosure).toContain("run automatically");
    expect(disclosure).toContain("Write and Destructive always need your approval");
    expect(disclosure.split(/\s+/).length).toBeLessThanOrEqual(40);
    expect(pop.slice(pop.indexOf("sa-on"))).toContain("Disable Auto mode");
    const settings = autoSettingsHtml(false, DEFAULT_SETTINGS);
    expect(settings).toContain(
      "<span data-auto-recipient>TypeSafe</span> sees the SQL structure and the schema names and types",
    );
    expect(settings).toContain("never result rows");
    expect(settings).toContain("PostgreSQL only.");
    expect(pop + settings).not.toMatch(/beta/i);
    // The key lives on the evaluator page now; the box names the evaluator and opens it.
    expect(settings).not.toContain('type="password"');
    expect(settings).toContain("data-evaluator-open");
    expect(autoSettingsHtml(true, DEFAULT_SETTINGS)).toContain('aria-label="Auto mode" checked');
    expect(pop + settings).not.toContain("Pause");
  });
  it.each([
    [DEFAULT_SETTINGS, "jev-1.13.0", "TypeSafe", "Built-in cutoffs", false],
    [
      {
        ...settingsFor("custom", "kev-4b"),
        baseUrl: "http://127.0.0.1:8080",
        cutoffs: { ...AUTO_THRESHOLDS },
      },
      "kev-4b",
      "Custom server",
      "Your cutoffs",
      false,
    ],
    [settingsFor("custom", "kev-4b"), "kev-4b", "Custom server", "Setup needed", true],
    [
      { ...settingsFor("custom", "kev-4b"), baseUrl: "http://127.0.0.1:8080" },
      "kev-4b",
      "Custom server",
      "Cutoffs needed",
      true,
    ],
  ])(
    "names the evaluator and the state of its cutoffs in one line",
    (s, model, where, state, need) => {
      const html = autoSettingsHtml(false, s);
      expect(html).toContain(`<span class="ev-model">${model}</span> on ${where}</span>`);
      expect(html).toContain(`<span class="ev-state${need ? " need" : ""}">${state}</span>`);
      expect(html).toContain('<span class="dsep" aria-hidden="true"></span>');
    },
  );
  it("names a Custom server by its address, escaped, and a damaged choice as none", () => {
    const s = { ...settingsFor("custom", "<kev>"), baseUrl: "https://kev.example.test/tenant" };
    expect(autoPopHtml(s)).toContain("Custom server at kev.example.test");
    expect(autoSettingsHtml(false, s)).toContain("&lt;kev&gt;");
    expect(autoSettingsHtml(false, undefined)).toContain("No evaluator chosen");
  });
  it("offers the built-in cutoffs only for jev-1.13.0, and a prompt otherwise", () => {
    const builtIn = evaluatorPageHtml(DEFAULT_SETTINGS, true);
    expect(builtIn).toContain("Use the built-in cutoffs");
    expect(builtIn).toContain('id="evCut-personal_disclosure"');
    expect(builtIn).toMatch(/data-ev-cut="personal_disclosure" value="0.2" disabled/);
    expect(builtIn).not.toContain("data-copy-prompt");
    expect(builtIn).not.toContain("data-key-remove");
    const custom = evaluatorPageHtml(
      { ...settingsFor("custom", "kev-4b"), baseUrl: "http://127.0.0.1:8080" },
      true,
    );
    expect(custom).toContain("No built-in cutoffs for this model.");
    expect(custom).toMatch(/data-ev-cut="personal_disclosure" value=""(?! disabled)/);
    expect(custom).toContain("data-copy-prompt");
    // Only a Custom server goes keyless, so only it offers to remove its key.
    expect(custom).toContain("data-key-remove");
    expect(custom).toContain("Plain http is accepted for 127.0.0.1 only.");
  });
  it.each([false, true])(
    "offers a confirmed switch out of Auto mode in the compact=%s menu",
    (compact) => {
      const html = modeDropdown("read", compact, true);
      expect(html).not.toContain("aria-disabled");
      // The menu keeps its ordinary labels; what a switch costs is explained in the
      // popover and in the arm confirm, not repeated under every option.
      expect(html).toContain('adds <code class="kw">INSERT</code>, <code class="kw">UPDATE</code>');
      expect(html).not.toContain("Auto mode");
      expect(html).toContain('data-mode-opt="write"');
      expect(html).toContain('data-mode-opt="destructive"');
      expect(autoPopHtml(DEFAULT_SETTINGS)).toContain(
        "confirming Write or Destructive turns off Auto mode",
      );
      expect(autoPopHtml(DEFAULT_SETTINGS)).not.toContain("stay unavailable");
    },
  );
  it("keeps manual actions during evaluation and says only where a read was held", () => {
    const card = {
      id: "r1",
      sql: "SELECT quantity FROM public.products",
      state: "ready" as const,
      createdAt: 1,
      expiresAt: Date.now() + 60000,
      leaseExpiresAt: Date.now() + 60000,
      leaseId: "l1",
      sessionId: "s1",
      session: null,
    };
    const evaluating = cardHtml(
      { ...card, autoStatus: AUTO_EVALUATING, autoModel: "jev-1.13.0" },
      "postgresql",
      new Map(),
    );
    // The evaluation speaks from the decision bar, as what blocks Approve, and the SQL wears the ring.
    expect(evaluating).toContain('<div class="nb-msg auto" id="gate-r1" role="status">');
    expect(evaluating).toContain("Auto mode is evaluating this read with jev-1.13.0.");
    expect(evaluating).toContain('<div class="sql-ring">');
    expect(evaluating).toContain('data-approve="r1"');
    expect(evaluating).toContain('data-reject="r1"');
    // A hold says where it happened and why, cut before any source its reason may name.
    const local = cardHtml(
      { ...card, autoStatus: "Needs review: Sensitive source or alias: <email>" },
      "postgresql",
      new Map(),
    );
    expect(local).toContain(
      'Held on this machine before evaluation: Sensitive source or alias. Waiting for your review. <b class="auto-strong">Nothing was sent to the evaluator.</b>',
    );
    expect(local).not.toContain("email");
    // A read that left and got no verdict is never told it was refused.
    const sent = (extra: object) =>
      cardHtml(
        {
          ...card,
          autoStatus: "Needs review: Evaluator or metadata unavailable. Approve manually",
          autoSent: true,
          autoModel: "kev-<4b>",
          ...extra,
        },
        "postgresql",
        new Map(),
      );
    for (const [failure, text] of [
      [{ stage: "timeout" }, "kev-&lt;4b&gt; did not answer in time."],
      [{ stage: "network" }, "kev-&lt;4b&gt; could not be reached."],
      [{ stage: "http", status: 401 }, "kev-&lt;4b&gt; answered with an error (HTTP 401)."],
      [{ stage: "http" }, "kev-&lt;4b&gt; answered with an error."],
      [{ stage: "response" }, "kev-&lt;4b&gt; returned an invalid answer."],
      [{ stage: "cancelled" }, "The evaluation did not finish."],
    ] as const) {
      const html = sent({ autoFailure: failure });
      expect(html).toContain(`${text} Waiting for your review.`);
      expect(html).not.toContain("did not clear");
      expect(html).not.toContain("API key");
      expect(html).not.toContain("Nothing was sent");
    }
    expect(sent({})).toContain(
      "The evaluation did not finish: Evaluator or metadata unavailable. Waiting for your review.",
    );
    // An answer on record names the model that gave it, escaped like any recorded text.
    const refused = cardHtml(
      {
        ...card,
        autoStatus: "Needs review: Potential personal disclosure",
        autoSent: true,
        evaluation: {
          provider: "typesafe",
          model: "jev-<1>",
          policy: AUTO_POLICY,
          evaluatedAt: 1,
          sqlDigest: "a".repeat(64),
          eligible: false,
          reasons: ["Potential personal disclosure"],
          probabilities: { personal_disclosure: 0.9 },
        },
      },
      "postgresql",
      new Map(),
    );
    expect(refused).toContain("jev-&lt;1&gt; did not clear this read. Waiting for your review.");
    // With cutoffs it can grade by, the card says which questions went over, in words.
    const graded = (probabilities: Record<string, number>) =>
      cardHtml(
        {
          ...card,
          autoStatus: "Needs review: Potential personal disclosure",
          autoSent: true,
          evaluation: {
            provider: "typesafe",
            model: "jev-1.13.0",
            policy: AUTO_POLICY,
            evaluatedAt: 1,
            sqlDigest: "a".repeat(64),
            eligible: false,
            reasons: ["Potential personal disclosure"],
            probabilities,
          },
        },
        "postgresql",
        new Map(),
      );
    const axes = { organization_disclosure: 0.06, secret_disclosure: 0.01 };
    expect(graded({ ...axes, personal_disclosure: 0.91, insufficient_context: 0.3 })).toContain(
      "jev-1.13.0 did not clear this read: it may reveal personal data. Waiting",
    );
    expect(graded({ ...axes, personal_disclosure: 0.91, insufficient_context: 0.68 })).toContain(
      "jev-1.13.0 did not clear this read: it may reveal personal data and the meaning of a returned value is unclear. Waiting",
    );
    // A probability at its cutoff passes, as in the decision itself.
    expect(graded({ ...axes, personal_disclosure: 0.2, insufficient_context: 0.68 })).toContain(
      "did not clear this read: the meaning of a returned value is unclear.",
    );
    // A read cleared, then held for another reason, says both.
    const later = cardHtml(
      {
        ...card,
        autoStatus: "Needs review: Connection or approval authority changed",
        autoSent: true,
        evaluation: {
          provider: "typesafe",
          model: "jev-1.13.0",
          policy: AUTO_POLICY,
          evaluatedAt: 1,
          sqlDigest: "a".repeat(64),
          eligible: true,
          reasons: [],
          probabilities: { personal_disclosure: 0.01 },
        },
      },
      "postgresql",
      new Map(),
    );
    expect(later).toContain(
      "jev-1.13.0 cleared this read, then it was held: Connection or approval authority changed. Waiting",
    );
  });
  it("distinguishes human and automatic history and includes durable details", () => {
    const approval: ApprovalAttribution = {
      source: "automatic",
      evaluation: {
        provider: "typesafe",
        model: "jev-1.13.0",
        policy: "auto-beta-1",
        evaluatedAt: 1,
        sqlDigest: "a".repeat(64),
        eligible: true,
        reasons: [],
        probabilities: { read_only: 0.999 },
      },
    };
    const item = {
      id: "r1",
      status: "approved" as const,
      note: "2 rows",
      sql: "SELECT quantity FROM public.products",
      resolvedAt: 1,
      connection: "test",
      session: null,
      approval,
    };
    expect(recentRowHtml(item, false)).toContain("Approved automatically");
    expect(recentRowHtml({ ...item, approval: { source: "human" } }, false)).not.toContain(
      "Approved automatically",
    );
    expect(approvalHtml(approval)).toContain("jev-1.13.0");
    expect(approvalHtml(approval)).toContain("auto-beta-1");
    expect(approvalHtml(approval)).toContain("read_only 0.999");
    const entry = {
      id: "r1",
      createdAt: 1,
      decidedAt: 2,
      sessionId: "s1",
      harness: null,
      project: null,
      sessionLabel: null,
      sql: item.sql,
      intent: null,
      state: "approved" as const,
      reason: null,
      error: null,
      rowCount: 2,
      affectedRows: null,
      approval,
    };
    // The row says who decided; the evaluation's details open with it on the right.
    expect(activityEntryHtml(entry, true, "postgresql")).toContain("Approved automatically");
    expect(detailHtml(auditItem(entry, null), "audit", "postgresql")).toContain("auto-beta-1");
  });
});

describe("the resolved Auto trace", () => {
  const refusal = (reasons: string[]) => ({
    provider: "typesafe",
    model: "jev-1.13.0",
    policy: "auto-beta-7",
    evaluatedAt: 1,
    sqlDigest: "a".repeat(64),
    eligible: false,
    reasons,
    probabilities: { personal_disclosure: 0.9 },
  });
  const cutoffs = (over: Record<string, number>) => ({
    personal_disclosure: 0.2,
    organization_disclosure: 0.15,
    secret_disclosure: 0.15,
    insufficient_context: 0.45,
    ...over,
  });

  it("grades only the current policy and keeps an older record's numbers as stored", () => {
    const current = { ...refusal([]), policy: AUTO_POLICY };
    expect(approvalHtml({ source: "human", evaluation: current })).toContain("metric over");
    const older = approvalHtml({
      source: "human",
      evaluation: { ...current, policy: "auto-beta-8" },
    });
    expect(older).toContain("policy auto-beta-8");
    expect(older).toContain(">Personal data 0.9<");
    expect(older).not.toContain("metric over");
  });

  it("grades by the cutoffs the record carries, even when they differ from today's", () => {
    const own = {
      ...refusal([]),
      policy: AUTO_POLICY,
      thresholds: cutoffs({ personal_disclosure: 0.95 }),
    };
    expect(approvalHtml({ source: "human", evaluation: own })).not.toContain("metric over");
    const tighter = { ...own, thresholds: cutoffs({ personal_disclosure: 0.5 }) };
    expect(approvalHtml({ source: "human", evaluation: tighter })).toContain("metric over");
  });

  it.each([
    null,
    [],
    { personal_disclosure: 0.5 },
    { ...cutoffs({}), read_only: 0.5 },
    cutoffs({ personal_disclosure: Number.NaN }),
    cutoffs({ personal_disclosure: "0.5" as unknown as number }),
  ])("leaves malformed recorded cutoffs ungraded, never today's: %o", (thresholds) => {
    const html = approvalHtml({
      source: "human",
      evaluation: { ...refusal([]), policy: AUTO_POLICY, thresholds } as never,
    });
    expect(html).toContain(">Personal data 0.9<");
    expect(html).not.toContain("metric over");
  });

  it("names the model that refused and the evaluator, without the evaluator's labels", () => {
    const html = approvalHtml({ source: "human", evaluation: refusal(["A <brand> new label"]) });
    expect(html).toContain("jev-1.13.0 did not clear this read.");
    expect(html).toContain('<span class="auto-who">Evaluated by jev-1.13.0 on TypeSafe.</span>');
    expect(html).not.toContain("brand");
    // Facts sit apart by position, never chained with dots.
    expect(html).toContain("<span>policy auto-beta-7</span>");
    expect(html).not.toContain("&middot;");
  });

  it("labels each question and grades it against its own cutoff", () => {
    const html = approvalHtml({
      source: "human",
      evaluation: {
        ...refusal([]),
        policy: AUTO_POLICY,
        eligible: false,
        probabilities: {
          personal_disclosure: 0.91,
          organization_disclosure: 0.15,
          secret_disclosure: 0.01,
          insufficient_context: 0.68,
        },
      },
    });
    expect(html).toContain(
      "jev-1.13.0 did not clear this read: it may reveal personal data and the meaning of a returned value is unclear.",
    );
    expect(html).toContain(
      '<span class="auto-reason metric over">Personal data 0.91 &gt; 0.2</span>',
    );
    expect(html).toContain('<span class="auto-reason metric">Company identity 0.15 ≤ 0.15</span>');
    expect(html).toContain(
      '<span class="auto-reason metric over">Unclear meaning 0.68 &gt; 0.45</span>',
    );
  });

  it("says where a hold happened and why, and keeps a later hold beside a cleared evaluation", () => {
    expect(
      approvalHtml(undefined, undefined, { sent: false, reason: "Unsupported projection" }),
    ).toContain(
      'Held on this machine before evaluation: Unsupported projection. <b class="auto-strong">Nothing was sent to the evaluator.</b>',
    );
    // An older record has no diagnosis: it is never read as a refusal or a timeout.
    const unfinished = approvalHtml(undefined, undefined, {
      sent: true,
      reason: "Evaluation timed out. Approve manually",
    });
    expect(unfinished).toContain("The evaluation did not finish: Evaluation timed out.");
    expect(unfinished).not.toContain("did not clear");
    expect(
      approvalHtml(undefined, undefined, {
        sent: true,
        reason: "Evaluation timed out. Approve manually",
        failure: { stage: "timeout" },
        model: "kev-latest",
      }),
    ).toContain("kev-latest did not answer in time.");
    const both = approvalHtml(
      { source: "human", evaluation: { ...refusal([]), eligible: true } },
      undefined,
      { sent: true, reason: "Execution stopped before SQL ran. Approval authority changed" },
    );
    expect(both).toContain(
      "jev-1.13.0 cleared this read, then it was held: Execution stopped before SQL ran.",
    );
    expect(both).not.toContain("did not clear");
    // An answer this plugin refused is an invalid answer, not the verdict the broker kept.
    const refusedHere = approvalHtml(
      undefined,
      { ...refusal([]), eligible: true },
      {
        sent: true,
        reason: "Invalid evaluator response or stale policy/model",
        failure: { stage: "response" },
        model: "jev-1.13.0",
      },
    );
    expect(refusedHere).toContain("jev-1.13.0 returned an invalid answer.");
    expect(refusedHere).not.toContain("cleared");
    // The final hold outranks an automatic approval an earlier, withdrawn attempt left behind.
    const stale = approvalHtml(
      { source: "automatic", evaluation: { ...refusal([]), eligible: true } },
      undefined,
      { sent: true, reason: "Evaluator or metadata unavailable", failure: { stage: "network" } },
    );
    expect(stale).toContain("jev-1.13.0 could not be reached.");
    expect(stale).not.toContain("approved automatically");
  });
});
