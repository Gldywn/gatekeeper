import type { ApprovalAttribution } from "@gatekeeper/shared";
import { describe, expect, it } from "vitest";
import { activityEntryHtml } from "./activity";
import { approvalHtml, autoPopHtml, autoSettingsHtml } from "./auto";
import { modeDropdown } from "./controls";
import { detailHtml } from "./detail";
import { auditItem, recentRowHtml } from "./inbox";
import { cardHtml } from "./queue";

describe("Auto mode surfaces", () => {
  it("discloses provider sharing before either activation entry point", () => {
    const pop = autoPopHtml();
    const off = pop.slice(pop.indexOf("sa-off"), pop.indexOf("sa-on"));
    expect(off).toContain("TypeSafe receives the SQL structure");
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
    const settings = autoSettingsHtml(false);
    expect(settings).toContain("TypeSafe receives SQL structure");
    expect(settings).toContain("No result rows are sent");
    expect(settings).toContain('type="password"');
    // The key stays replaceable while Auto mode runs.
    expect(autoSettingsHtml(true)).toContain('type="password"');
    expect(autoSettingsHtml(true)).toContain('aria-label="Auto mode" checked');
    expect(pop + settings).not.toContain("Pause");
  });
  it.each([false, true])(
    "offers a confirmed switch out of Auto mode in the compact=%s menu",
    (compact) => {
      const html = modeDropdown("read", compact, true);
      expect(html).not.toContain("aria-disabled");
      // The menu keeps its ordinary labels; what a switch costs is explained in the
      // popover and in Settings, not repeated under every option.
      expect(html).toContain('adds <code class="kw">INSERT</code>, <code class="kw">UPDATE</code>');
      expect(html).not.toContain("Auto mode");
      expect(html).toContain('data-mode-opt="write"');
      expect(html).toContain('data-mode-opt="destructive"');
      expect(autoSettingsHtml(true)).toContain(
        "Confirming Write or Destructive turns off Auto mode",
      );
      expect(autoPopHtml()).not.toContain("stay unavailable");
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
      { ...card, autoStatus: "Evaluating with Jev" },
      "postgresql",
      new Map(),
    );
    // The evaluation speaks from the decision bar, as what blocks Approve, and the SQL wears the ring.
    expect(evaluating).toContain('<div class="nb-msg auto" id="gate-r1" role="status">');
    expect(evaluating).toContain("Auto mode is evaluating this read with Jev.");
    expect(evaluating).toContain('<div class="sql-ring">');
    expect(evaluating).toContain('data-approve="r1"');
    expect(evaluating).toContain('data-reject="r1"');
    // A hold says only where it happened: never its stored reason, which may name a source.
    const local = cardHtml(
      { ...card, autoStatus: "Needs review: Sensitive source or alias: <email>" },
      "postgresql",
      new Map(),
    );
    expect(local).toContain(
      'Held on this machine before evaluation. Waiting for your review. <b class="auto-strong">Nothing was sent to TypeSafe.</b>',
    );
    expect(local).not.toContain("email");
    const sent = cardHtml(
      {
        ...card,
        autoStatus: "Needs review: Evaluation timed out. Approve manually",
        autoSent: true,
      },
      "postgresql",
      new Map(),
    );
    expect(sent).toContain("Jev did not clear this read. Waiting for your review.");
    expect(sent).not.toContain("Nothing was sent");
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

  it("says Jev did not clear a refused read, without the evaluator's labels", () => {
    const html = approvalHtml({ source: "human", evaluation: refusal(["A <brand> new label"]) });
    expect(html).toContain("Jev did not clear this read.");
    expect(html).not.toContain("brand");
  });

  it("says where a hold happened, and lets a cleared evaluation speak for itself", () => {
    expect(
      approvalHtml(undefined, undefined, { sent: false, reason: "Unsupported projection" }),
    ).toContain(
      'Held on this machine before evaluation. <b class="auto-strong">Nothing was sent to TypeSafe.</b>',
    );
    expect(
      approvalHtml(undefined, undefined, {
        sent: true,
        reason: "Evaluation timed out. Approve manually",
      }),
    ).toContain("Jev did not clear this read.");
    const both = approvalHtml(
      { source: "human", evaluation: { ...refusal([]), eligible: true } },
      undefined,
      { sent: true, reason: "Execution stopped before SQL ran. Approval authority changed" },
    );
    expect(both).toContain("The evaluation cleared this read.");
    expect(both).not.toContain("did not clear");
  });
});
