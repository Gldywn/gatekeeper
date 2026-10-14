import type { ApprovalAttribution } from "@gatekeeper/shared";
import { describe, expect, it } from "vitest";
import { activityEntryHtml } from "./activity";
import { approvalHtml, autoPopHtml, autoSettingsHtml } from "./auto";
import { modeDropdown } from "./controls";
import { historyRow } from "./history";
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
      expect(html).toContain("adds INSERT, UPDATE");
      expect(html).not.toContain("Auto mode");
      expect(html).toContain('data-mode-opt="write"');
      expect(html).toContain('data-mode-opt="destructive"');
      expect(autoSettingsHtml(true)).toContain(
        "Confirming Write or Destructive turns off Auto mode",
      );
      expect(autoPopHtml()).not.toContain("stay unavailable");
    },
  );
  it("keeps manual actions during evaluation and escapes concrete review reasons", () => {
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
    expect(evaluating).toContain("Evaluating with Jev");
    expect(evaluating).toContain('data-approve="r1"');
    expect(evaluating).toContain('data-reject="r1"');
    const review = cardHtml(
      { ...card, autoStatus: "Needs review: Sensitive source <email>" },
      "postgresql",
      new Map(),
    );
    expect(review).toContain("Sensitive source &lt;email&gt;");
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
    expect(historyRow(item)).toContain("Approved automatically");
    expect(historyRow({ ...item, approval: { source: "human" } })).not.toContain(
      "Approved automatically",
    );
    expect(approvalHtml(approval)).toContain("jev-1.13.0");
    expect(approvalHtml(approval)).toContain("auto-beta-1");
    expect(approvalHtml(approval)).toContain("read_only 0.999");
    const activity = activityEntryHtml(
      {
        id: "r1",
        createdAt: 1,
        decidedAt: 2,
        sessionId: "s1",
        harness: null,
        project: null,
        sessionLabel: null,
        sql: item.sql,
        intent: null,
        state: "approved",
        reason: null,
        error: null,
        rowCount: 2,
        approval,
      },
      new Set(["r1"]),
      "postgresql",
    );
    expect(activity).toContain("Approved automatically");
    expect(activity).toContain("auto-beta-1");
  });
});
