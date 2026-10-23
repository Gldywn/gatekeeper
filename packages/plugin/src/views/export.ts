import { log, requestFileSave } from "@beekeeperstudio/plugin";
import {
  type DayPick,
  ExportFeed,
  type ExportFormat,
  type ExportPeriod,
  emptyPick,
  exportFileName,
  exportFlags,
  exportMonths,
  isTicked,
  monthStart,
  monthState,
  type PeriodBounds,
  periodBounds,
  scopeOf,
  tickDay,
  tickMonth,
  totals,
} from "../export";
import { dayKey } from "../html";
import { takeOver } from "../modal";
import type { BrokerClient } from "../net/broker";
import { activityCsv, activityJson, activityMarkdownDays } from "../render/activity";
import {
  type ExportStatus,
  exportDaysHtml,
  exportDialogHtml,
  exportFailedRowHtml,
  exportGoLabel,
  exportLegacyHtml,
  exportReadingRowHtml,
  exportStatusHtml,
} from "../render/export";

interface ExportDialogDeps {
  root: HTMLElement;
  broker: Pick<BrokerClient, "activity">;
  // The broker's scope key, the connection's display name and its dialect, captured on open so a
  // connection switch mid-export cannot mix two connections in one file.
  scope: () => string | undefined;
  connectionName: () => string;
  dialect: () => string;
}

const FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  md: { name: "Markdown", extensions: ["md"] },
  csv: { name: "CSV", extensions: ["csv"] },
  json: { name: "JSON", extensions: ["json"] },
};

const shortDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// Owns the #export overlay: the whole Audit Trail as one file, for a period or chosen days. It
// reads the trail with its own cursor, only as far as the chosen scope needs, and saves through
// the host's dialog. No result rows are ever in it, only their counts.
export class ExportDialog {
  private readonly deps: ExportDialogDeps;
  private open_ = false;
  // Bumped on every open and close, so a page or a save that outlives its dialog does nothing.
  private gen = 0;
  private release: (() => void) | undefined;
  private feed: ExportFeed | null = null;
  private bounds: PeriodBounds = periodBounds(new Date());
  private connection = "";
  private dialect = "";
  private period: ExportPeriod = "last7";
  private format: ExportFormat = "md";
  private pick: DayPick = emptyPick();
  private flipped = new Set<string>();
  private anchor: string | null = null;
  private shift = false;
  private preparing: { done: number; total: number } | null = null;
  private saveError: string | undefined;
  private shown = { days: "", status: "" };

  constructor(deps: ExportDialogDeps) {
    this.deps = deps;
    const root = deps.root;
    // Delegated off the root: the overlay node is rebuilt with the shell on re-pair.
    root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const panel = target.closest<HTMLElement>("#export");
      if (!panel || !this.open_) return;
      this.shift = e.shiftKey;
      if (target === panel || target.closest("[data-export-close]")) {
        this.close();
      } else if (target.closest("[data-export-go]")) {
        void this.save();
      } else if (target.closest("[data-export-clear]")) {
        this.pick = emptyPick();
        this.anchor = null;
        this.refresh();
      } else if (target.closest("[data-act-retry]")) {
        this.feed?.retry();
        this.read(true);
      } else {
        const fold = target.closest<HTMLElement>("[data-export-fold]");
        if (fold) {
          const month = fold.dataset.exportFold!;
          if (this.flipped.has(month)) this.flipped.delete(month);
          else this.flipped.add(month);
          this.refresh();
        }
      }
    });
    root.addEventListener("change", (e) => {
      const el = e.target as HTMLInputElement;
      if (!this.open_ || !el.closest("#export")) return;
      if (el.name === "exPeriod") {
        this.period = el.value as ExportPeriod;
        this.saveError = undefined;
        this.read();
      } else if (el.name === "exFormat") {
        this.format = el.value as ExportFormat;
        this.saveError = undefined;
        this.refresh();
      } else if (el.dataset.exportMonth) {
        const month = el.dataset.exportMonth;
        tickMonth(this.pick, month, this.monthTick(month));
        this.refresh();
      } else if (el.dataset.exportDay) {
        this.tickDays(el.dataset.exportDay, el.checked);
        this.refresh();
      }
    });
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    const panel = this.panel();
    if (!panel || this.open_) return;
    this.gen++;
    this.open_ = true;
    this.connection = this.deps.connectionName();
    this.dialect = this.deps.dialect();
    this.feed = new ExportFeed(this.deps.broker, this.deps.scope());
    this.bounds = periodBounds(new Date());
    this.period = "last7";
    this.format = "md";
    this.pick = emptyPick();
    this.flipped = new Set();
    this.anchor = null;
    this.preparing = null;
    this.saveError = undefined;
    this.shown = { days: "", status: "" };
    // Back to the trigger on close, or to the Audit Trail tab when the trigger is gone.
    this.release = takeOver(panel, () => this.deps.root.querySelector<HTMLElement>("#tabAudit"));
    panel.innerHTML = exportDialogHtml(this.period, this.format, this.whenLabels());
    panel.hidden = false;
    panel.querySelector<HTMLElement>('input[name="exPeriod"]:checked')?.focus();
    this.read();
  }

  // Returns whether it was open, so the app's Escape chain stops at this layer.
  close(): boolean {
    if (!this.open_) return false;
    this.open_ = false;
    this.gen++;
    this.feed?.stop();
    this.feed = null;
    const panel = this.panel();
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
    this.release?.();
    this.release = undefined;
    return true;
  }

  private panel(): HTMLElement | null {
    return this.deps.root.querySelector<HTMLElement>("#export");
  }

  // A recent period stops at the page that reaches past its first day; the rest read to the end.
  private read(retry = false): void {
    const feed = this.feed;
    if (!feed) return;
    const p = this.period;
    const period =
      p === "today" || p === "last7" || p === "month"
        ? () => feed.covers(this.bounds[p])
        : () => false;
    // A Retry fetches the failed page even when the period is already whole: older days wait on it.
    const read = feed.entries.length;
    const target = retry ? () => (feed.entries.length > read || feed.ended) && period() : period;
    void feed.read(target, () => this.refresh());
    this.refresh();
  }

  private monthTick(month: string) {
    const feed = this.feed!;
    const listed = exportMonths(feed, this.pick)
      .find((m) => m.key === month)
      ?.days.map((d) => d.key);
    return monthState(this.pick, month, listed ?? [], feed.covers(monthStart(month)));
  }

  // A shift-click ticks the run of listed days from the last one ticked to this one.
  private tickDays(day: string, on: boolean): void {
    const order = this.feed
      ? exportMonths(this.feed, this.pick).flatMap((m) => m.days.map((d) => d.key))
      : [];
    const from = this.shift && this.anchor ? order.indexOf(this.anchor) : -1;
    const to = order.indexOf(day);
    if (from >= 0 && to >= 0) {
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++)
        tickDay(this.pick, order[i], on);
    } else {
      tickDay(this.pick, day, on);
    }
    this.anchor = day;
  }

  private whenLabels(): Partial<Record<ExportPeriod, string>> {
    const b = this.bounds;
    const weekday = new Date(b.today).toLocaleDateString(undefined, { weekday: "short" });
    const labels: Partial<Record<ExportPeriod, string>> = {
      today: `${weekday}, ${shortDate(b.today)}`,
      last7: `${shortDate(b.last7)} to ${shortDate(b.today)}`,
      month: `${shortDate(b.month)} to ${shortDate(b.today)}`,
    };
    const feed = this.feed;
    const newest = feed?.entries[0];
    const oldest = feed?.oldestRead();
    if (feed?.ended && newest && oldest != null) {
      labels.all = `${shortDate(oldest)} to ${shortDate(newest.decidedAt ?? newest.createdAt)}`;
    }
    return labels;
  }

  private status(): ExportStatus {
    const feed = this.feed!;
    if (this.preparing) return { kind: "preparing", ...this.preparing };
    const scope = scopeOf(feed, this.period, this.bounds, this.pick);
    if (!scope.complete) {
      if (feed.failed) return { kind: "blocked", all: this.period === "all" };
      const oldest = feed.oldestRead();
      return { kind: "reading", back: oldest == null ? null : shortDate(oldest) };
    }
    if (this.period === "pick" && !this.pick.days.size && !this.pick.months.size) {
      return { kind: "none-ticked" };
    }
    if (!scope.entries.length) return { kind: "empty" };
    return { kind: "scope", ...totals(scope.entries) };
  }

  // Partial updates only, so a tick or a page never moves the focus or the list's scroll.
  private refresh(): void {
    const panel = this.panel();
    const feed = this.feed;
    if (!panel || !feed || !this.open_) return;
    if (feed.legacy) {
      if (!panel.querySelector("[data-export-legacy]")) {
        panel.innerHTML = exportLegacyHtml();
        panel.querySelector<HTMLElement>("[data-export-close]")?.focus();
      }
      return;
    }
    const doc = panel.ownerDocument;
    const focused = doc?.activeElement ?? null;
    const hadFocus = focused !== null && panel.contains(focused);
    const all = panel.querySelector<HTMLElement>('[data-export-when="all"]');
    if (all) all.textContent = this.whenLabels().all ?? "";
    const form = panel.querySelector<HTMLFieldSetElement>("#exForm");
    if (form) form.disabled = this.preparing !== null;
    const reading = feed.busy && !feed.ended;
    const failed = feed.failed
      ? exportFailedRowHtml(feed.failed.first, feed.failed.unreachable)
      : "";
    const above = panel.querySelector<HTMLElement>("#exFeed");
    if (above) {
      // Outside Choose days a failed page still keeps its Retry in view.
      const html = this.period === "pick" ? "" : failed;
      if (above.innerHTML !== html) above.innerHTML = html;
    }
    this.renderDays(panel, failed || (reading ? exportReadingRowHtml() : ""));
    const status = this.status();
    const html = exportStatusHtml(status, this.saveError);
    const host = panel.querySelector<HTMLElement>("#exStatus");
    if (host && html !== this.shown.status) {
      host.innerHTML = html;
      this.shown.status = html;
    }
    const go = panel.querySelector<HTMLButtonElement>("[data-export-go]");
    if (go) {
      go.disabled = status.kind !== "scope";
      go.textContent = exportGoLabel(status);
    }
    // A control that held the focus can go with an update (Retry once it is answered); the focus
    // stays in the modal, on the chosen period, or on the close button while the form is frozen.
    if (hadFocus && !panel.contains(doc?.activeElement ?? null)) {
      const radio = panel.querySelector<HTMLInputElement>('input[name="exPeriod"]:checked');
      (radio && !radio.disabled && !form?.disabled
        ? radio
        : panel.querySelector<HTMLElement>("[data-export-close]")
      )?.focus({ preventScroll: true });
    }
  }

  // The list is rebuilt only when its markup changes, then the focus goes back to the same
  // control and the scroll to where it was.
  private renderDays(panel: HTMLElement, tail: string): void {
    const well = panel.querySelector<HTMLElement>("#exDays");
    const feed = this.feed;
    if (!well || !feed) return;
    well.hidden = this.period !== "pick";
    if (well.hidden) return;
    // The current month starts open and the others folded; a click flips one from that default.
    const current = dayKey(this.bounds.today).slice(0, 7);
    const months = exportMonths(feed, this.pick).map((m) => ({
      ...m,
      open: (m.key === current) !== this.flipped.has(m.key),
    }));
    const html = exportDaysHtml(months, (d) => isTicked(this.pick, d), tail);
    if (html === this.shown.days) return;
    const focused = panel.ownerDocument?.activeElement ?? null;
    const active = focused && well.contains(focused) ? (focused as HTMLElement) : null;
    const focusKey = active ? focusSelector(active) : null;
    const scroll = well.scrollTop;
    well.innerHTML = html;
    this.shown.days = html;
    for (const box of well.querySelectorAll<HTMLInputElement>("[data-mixed]"))
      box.indeterminate = true;
    if (focusKey) well.querySelector<HTMLElement>(focusKey)?.focus({ preventScroll: true });
    well.scrollTop = scroll;
  }

  private async save(): Promise<void> {
    const feed = this.feed;
    if (!feed || this.preparing) return;
    const scope = scopeOf(feed, this.period, this.bounds, this.pick);
    if (!scope.complete || !scope.entries.length) return;
    const gen = this.gen;
    // Frozen here: what is saved is what the button named, whatever arrives or changes later.
    const entries = scope.entries;
    const format = this.format;
    const connection = this.connection;
    this.preparing = { done: 0, total: entries.length };
    this.saveError = undefined;
    this.refresh();
    try {
      const flags = await exportFlags(
        entries,
        this.dialect,
        (done) => {
          if (gen !== this.gen) return;
          this.preparing = { done, total: entries.length };
          this.refresh();
        },
        () => gen === this.gen,
      );
      if (!flags || gen !== this.gen) return;
      const data =
        format === "csv"
          ? activityCsv(entries, flags)
          : format === "json"
            ? activityJson(entries, flags)
            : activityMarkdownDays(entries, connection, flags);
      await requestFileSave({
        data,
        fileName: exportFileName(connection, entries, format),
        encoding: "utf8",
        filters: [FILTERS[format]],
      });
      // The host does not say whether the file was written or the save dialog was cancelled.
      if (gen === this.gen) this.close();
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
      if (gen === this.gen) this.saveError = err instanceof Error ? err.message : String(err);
    } finally {
      if (gen === this.gen) {
        this.preparing = null;
        this.refresh();
      }
    }
  }
}

// The control to focus again once the list is rebuilt, by the data key it carries.
function focusSelector(el: HTMLElement): string | null {
  for (const name of ["exportDay", "exportMonth", "exportFold"] as const) {
    const value = el.dataset[name];
    if (value) {
      const attr = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      return `[data-${attr}="${CSS.escape(value)}"]`;
    }
  }
  if (el.hasAttribute("data-export-clear")) return "[data-export-clear]";
  if (el.hasAttribute("data-act-retry")) return "[data-act-retry]";
  return null;
}
