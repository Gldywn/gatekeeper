import { clipboard, log, requestFileSave } from "@beekeeperstudio/plugin";
import type { TabulatorFull } from "tabulator-tables";
import type { SchemaAnnotator } from "../annotate";
import { dayKey, sessionDisplayName } from "../html";
import { checkIcon, copyIcon } from "../icons";
import { takeOver } from "../modal";
import { detailHtml, detailResultHtml, resultsDialogHtml } from "../render/detail";
import { mountResultGrid } from "../render/grid";
import { accessMatrix, paintLegend } from "../render/queue";
import { resultCsv, resultJson, resultMarkdown } from "../render/resultexport";
import type { HistResult } from "../result";
import { classifyQuery } from "../sql/classify";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import { textSchema } from "../sql/inspect";
import type { HistItem } from "../types";

// The grid's own header, pager and the row-count footer under it, so a grid scrolled into
// view fits the pane whole; never smaller than a usable window of rows.
const GRID_CHROME_PX = 150;
const GRID_MIN_PX = 240;

interface DetailViewDeps {
  root: HTMLElement;
  annotator: SchemaAnnotator;
  databaseType: () => string;
  // The kept rows of an approved request, opened; throws when they cannot be shown.
  loadRows: (id: string) => Promise<HistResult>;
  // The app's Copy and Export menus, closed so none is left open in the place the rows leave.
  closeMenus: () => void;
}

// The rows moved into the results dialog, and where they go back.
interface Enlarged {
  overlay: HTMLElement;
  wrapper: HTMLElement;
  parent: HTMLElement;
  next: Node | null;
  release: (restoreFocus?: boolean) => void;
}

// Owns the decided request shown in the Inbox's right pane (#detail), from Recently
// resolved or the Audit Trail. Reads the host-side schema annotator so a reopened row shows
// the same reads/PII annotation as the pending card did.
export class DetailView {
  // The item on screen, so a late schema fetch only paints a detail still shown.
  private detailItem: HistItem | null = null;
  // Destroyed on close and reopen so its virtual-DOM listeners and detached nodes never
  // outlive the detail.
  private grid: TabulatorFull | null = null;
  private enlarged: Enlarged | null = null;
  // Requests waiting for a decision, shown in the dialog while it covers the Queue.
  private pending = 0;
  private readonly root: HTMLElement;
  private readonly annotator: SchemaAnnotator;
  private readonly databaseType: () => string;
  private readonly loadRows: (id: string) => Promise<HistResult>;
  // The one result held in memory: the open item's rows, so reopening it never fetches again.
  private opened: { id: string; result: HistResult } | null = null;
  private readonly closeMenus: () => void;

  constructor(deps: DetailViewDeps) {
    this.root = deps.root;
    this.annotator = deps.annotator;
    this.databaseType = deps.databaseType;
    this.loadRows = deps.loadRows;
    this.closeMenus = deps.closeMenus;
  }

  // The item whose request is open: closed again whenever another item opens.
  private requestOpen: string | null = null;

  showing(): string | null {
    return this.detailItem?.id ?? null;
  }

  open(listed: HistItem, annotate: "live" | "text" = "live"): void {
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (!panel) {
      return;
    }
    this.shrink(false);
    const item =
      !listed.result?.rows.length && this.opened?.id === listed.id
        ? { ...listed, result: this.opened.result }
        : listed;
    this.opened = item.result?.rows.length ? { id: item.id, result: item.result } : null;
    // A count of zero has no rows to fetch; a failed read is never remembered, so reopening retries.
    const loading =
      item.status === "approved" &&
      item.kept === true &&
      !item.result?.rows.length &&
      item.result?.rowCount !== 0;
    this.detailItem = item;
    if (this.requestOpen !== item.id) this.requestOpen = null;
    panel.innerHTML = detailHtml(
      item,
      annotate === "text" ? "audit" : "hist",
      this.databaseType(),
      this.requestOpen === item.id,
      loading,
    );
    panel.hidden = false;
    this.mountGrid(panel, item);
    void this.annotateDetail(item, annotate);
    if (loading) void this.fetchRows(panel, item);
  }

  // Only the result block is replaced, so the request fold and its annotation stay as they are.
  private async fetchRows(panel: HTMLElement, item: HistItem): Promise<void> {
    let result: HistResult | null = null;
    try {
      result = await this.loadRows(item.id);
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
    if (this.detailItem !== item) {
      return;
    }
    const shown = result ? { ...item, result } : item;
    this.detailItem = shown;
    if (result?.rows.length) this.opened = { id: item.id, result };
    const block = panel.querySelector(".dt-result");
    if (block) block.outerHTML = detailResultHtml(shown, this.databaseType());
    this.mountGrid(panel, shown);
  }

  // Opens or folds the request in place: the grid above keeps its page and sort, the line its focus.
  toggleRequest(): void {
    const item = this.detailItem;
    const toggle = this.root.querySelector<HTMLElement>("#detail [data-request-toggle]");
    const body = this.root.querySelector<HTMLElement>("#detail-rq");
    if (!item || !toggle || !body) return;
    const open = this.requestOpen !== item.id;
    this.requestOpen = open ? item.id : null;
    toggle.setAttribute("aria-expanded", String(open));
    const label = toggle.querySelector(".rq-label");
    if (label) label.textContent = `${open ? "Hide" : "Show"} request`;
    body.hidden = !open;
  }

  // The same grid moves, so sort, page and column order carry over. CSS sizes it (.results-card):
  // a height call would pin Tabulator to a fixed height for good, and its resize observer waits
  // on a frame and a visibility check, so a plain redraw fits it at once.
  enlarge(): void {
    const item = this.detailItem;
    const overlay = this.root.querySelector<HTMLElement>("#results");
    const wrapper = this.root.querySelector<HTMLElement>("#detail-grid");
    const parent = wrapper?.parentElement;
    if (this.enlarged || !item || !this.grid || !overlay || !wrapper || !parent) return;
    this.closeMenus();
    // Taken while the button holds the focus, so closing hands it back there.
    wrapper.querySelector<HTMLElement>("[data-result-zoom]")?.focus({ preventScroll: true });
    const release = takeOver(overlay, () =>
      this.root.querySelector<HTMLElement>("#detail-grid [data-result-zoom]"),
    );
    this.enlarged = { overlay, wrapper, parent, next: wrapper.nextSibling, release };
    overlay.innerHTML = resultsDialogHtml(item, this.pending);
    overlay.querySelector(".results-card")?.append(wrapper);
    overlay.hidden = false;
    this.grid.redraw();
    wrapper.querySelector<HTMLElement>(".tabulator-tableholder")?.focus({ preventScroll: true });
  }

  // Back into the pane; false when nothing was enlarged. `restoreFocus` false when the detail
  // itself goes (another selection, a reset, the database notice), which then places the focus.
  shrink(restoreFocus = true): boolean {
    const open = this.enlarged;
    if (!open) return false;
    this.enlarged = null;
    this.closeMenus();
    open.parent.insertBefore(
      open.wrapper,
      open.next?.parentNode === open.parent ? open.next : null,
    );
    open.overlay.hidden = true;
    open.overlay.innerHTML = "";
    // Released first: whatever the redraw does, the page never stays inert.
    open.release(restoreFocus);
    this.grid?.redraw();
    return true;
  }

  // The Queue's own count, live in the dialog's head while it hides the Queue.
  setPendingCount(count: number): void {
    this.pending = count;
    const button = this.enlarged?.overlay.querySelector<HTMLElement>("[data-results-queue]");
    if (!button) return;
    if (!count && button.contains(document.activeElement)) {
      this.enlarged?.overlay
        .querySelector<HTMLElement>("[data-results-close]")
        ?.focus({ preventScroll: true });
    }
    button.hidden = !count;
    const n = button.querySelector(".n");
    if (n) n.textContent = String(count);
  }

  // Mounted once the markup is laid out: the virtual renderer sizes its viewport from it.
  private mountGrid(panel: HTMLElement, item: HistItem): void {
    this.destroyGrid();
    const host = panel.querySelector<HTMLElement>(".gk-grid");
    const pager = panel.querySelector<HTMLElement>("[data-grid-pager]");
    const count = panel.querySelector<HTMLElement>("[data-grid-count]");
    if (host && pager && count && item.result && item.result.rows.length > 0) {
      const pane = host.closest<HTMLElement>(".pane-body");
      const room = (pane?.clientHeight ?? window.innerHeight) - GRID_CHROME_PX;
      this.grid = mountResultGrid(host, item.result, Math.max(GRID_MIN_PX, room), {
        pager,
        count,
      });
    }
  }

  private destroyGrid(): void {
    if (this.grid) {
      this.grid.destroy();
      this.grid = null;
    }
  }

  // `live` reads the connection's columns as the pending card did; `text` reads the SQL alone,
  // as the Audit Trail always has, so history never queries the connected database.
  private async annotateDetail(item: HistItem, source: "live" | "text"): Promise<void> {
    const raw =
      source === "live"
        ? await this.annotator.schemaFor(item.sql)
        : textSchema(item.sql, this.databaseType());
    if (this.detailItem?.id !== item.id) {
      return;
    }
    // Every detection, whatever the display toggles say now: they shape the requests still to
    // decide, and a decided one keeps what its row records.
    const schema = raw ?? null;
    // The matrix (a read's tables come from this analysis), the legend and the SQL marks move
    // together, as on the pending card.
    const cm = this.root.querySelector<HTMLElement>("#detail-cm");
    if (cm) {
      const databaseType = this.databaseType();
      cm.innerHTML = accessMatrix(
        item.sql,
        databaseType,
        classifyQuery(item.sql, databaseType).class,
        schema,
      );
    }
    const cs = this.root.querySelector<HTMLElement>("#detail-cs");
    if (cs) {
      paintLegend(cs, schema, "detail");
    }
    const body = this.root.querySelector<HTMLElement>("#detail-sqlbody");
    if (body) {
      body.innerHTML = highlight(
        formatSql(item.sql),
        schema?.pii,
        schema?.client,
        schema?.literals,
      );
    }
  }

  // Save the shown rows through the host's file dialog as CSV or JSON. A no-op while none show.
  async exportResult(fmt: "csv" | "json"): Promise<void> {
    const item = this.detailItem;
    if (!item?.result) {
      return;
    }
    const who = sessionDisplayName(item.session, item.id).toLowerCase();
    const slug = who.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "result";
    const json = fmt === "json";
    try {
      await requestFileSave({
        data: json ? resultJson(item.result) : resultCsv(item.result),
        fileName: `gatekeeper-result-${dayKey(Date.now())}-${slug}.${fmt}`,
        encoding: "utf8",
        filters: [
          json ? { name: "JSON", extensions: ["json"] } : { name: "CSV", extensions: ["csv"] },
        ],
      });
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }

  // Quick copy of the shown rows to the clipboard as Markdown, flashing a check on the
  // trigger's icon (like copySql). A no-op while none show.
  async copyResult(_fmt: "md"): Promise<void> {
    const result = this.detailItem?.result;
    if (!result) {
      return;
    }
    await clipboard.writeText(resultMarkdown(result));
    // In the pane or the dialog, wherever the rows are.
    const ico = this.root.querySelector<HTMLElement>("#detail-grid [data-flyout-ico]");
    if (ico) {
      ico.innerHTML = checkIcon;
      window.setTimeout(() => {
        ico.innerHTML = copyIcon;
      }, 1200);
    }
  }

  close(): void {
    this.shrink(false);
    this.detailItem = null;
    this.opened = null;
    this.requestOpen = null;
    this.destroyGrid();
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }
}
