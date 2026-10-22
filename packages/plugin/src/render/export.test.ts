process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import {
  exportDaysHtml,
  exportDialogHtml,
  exportGoLabel,
  exportLegacyHtml,
  exportStatusHtml,
  exportTriggerHtml,
} from "./export";

describe("render/export", () => {
  it("is one icon-only trigger, named for screen readers", () => {
    const html = exportTriggerHtml();
    expect(html).toContain("data-export-open");
    expect(html).toContain('aria-label="Export the Audit Trail"');
  });

  it("opens as a modal on the chosen period, its choices in one fieldset, the action disabled", () => {
    const html = exportDialogHtml("last7", "md", { last7: "Oct 16 to Oct 22" });
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="exportTitle"');
    expect(html.match(/name="exPeriod"/g)).toHaveLength(5);
    expect(html).toContain('value="last7" checked');
    expect(html).toContain('value="md" checked');
    expect(html).toContain('data-export-when="last7">Oct 16 to Oct 22<');
    expect(html).toContain('<fieldset class="ex-form" id="exForm">');
    // The days only show for Choose days.
    expect(html).toContain('id="exDays" hidden');
    expect(html).toContain('data-export-go aria-describedby="exStatus" disabled>Export<');
    expect(html).toContain("Result rows are never included.");
  });

  it("gives each month a tick and a fold side by side, and marks a mixed month for script", () => {
    const html = exportDaysHtml(
      [
        {
          key: "2026-10",
          label: "October 2026",
          state: "mixed",
          open: true,
          days: [
            { key: "2026-10-22", ts: Date.UTC(2026, 9, 22, 12), queries: 13, sessions: 2 },
            { key: "2026-10-21", ts: Date.UTC(2026, 9, 21, 12), queries: 1, sessions: 1 },
          ],
        },
        { key: "2026-09", label: "September 2026", state: "checked", open: false, days: [] },
      ],
      (d) => d === "2026-10-22",
      "",
    );
    // The checkbox ends before the fold button starts: never an input inside a button.
    expect(html).toContain(
      '<input class="ex-check" type="checkbox" data-export-month="2026-10" aria-label="October 2026" data-mixed><button class="ex-month-toggle"',
    );
    expect(html).toContain('data-export-month="2026-09" aria-label="September 2026" checked>');
    expect(html).toContain('aria-expanded="true" aria-controls="exm-2026-10"');
    expect(html).toContain('id="exm-2026-09" hidden');
    expect(html).toContain('data-export-day="2026-10-22" checked>');
    expect(html).toContain('data-export-day="2026-10-21">');
    expect(html).toContain("13 queries, 2 sessions");
    expect(html).toContain("1 query, 1 session");
    expect(html).toContain("data-export-clear");
  });

  it("states the scope as facts, or how far reading got, or what a failure leaves unmet", () => {
    const scope = { kind: "scope", queries: 1204, days: 7, sessions: 1 } as const;
    expect(exportStatusHtml(scope)).toContain(
      "<b>1,204</b> queries over <b>7</b> days, from <b>1</b> session.",
    );
    expect(exportGoLabel(scope)).toBe("Export 1,204 queries");
    expect(exportStatusHtml({ kind: "reading", back: "Sep 3" })).toContain(
      "Reading older days, back to Sep 3.",
    );
    expect(exportStatusHtml({ kind: "blocked", all: true })).toContain(
      "Every older day must load to export everything.",
    );
    expect(exportStatusHtml({ kind: "empty" })).toContain("No query was decided in this period.");
    const preparing = { kind: "preparing", done: 200, total: 450 } as const;
    expect(exportStatusHtml(preparing)).toContain("Preparing the file, <b>200</b> of <b>450</b>");
    expect(exportGoLabel(preparing)).toBe("Export 450 queries");
    expect(exportGoLabel({ kind: "none-ticked" })).toBe("Export");
    const failed = exportStatusHtml(scope, "EACCES: <denied>");
    expect(failed).toContain("The file could not be saved.");
    expect(failed).toContain('<span class="stop-raw">EACCES: &lt;denied&gt;</span>');
  });

  it("asks for an updated server instead of exporting from one without paging", () => {
    const html = exportLegacyHtml();
    expect(html).toContain("An updated Gatekeeper server is required to export the Audit Trail.");
    expect(html).not.toContain("exPeriod");
    expect(html).not.toContain("data-export-go");
  });
});
