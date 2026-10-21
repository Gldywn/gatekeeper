import { clipboard, log, requestFileSave } from "@beekeeperstudio/plugin";
import type { TabulatorFull } from "tabulator-tables";
import type { SchemaAnnotator } from "../annotate";
import { dayKey, sessionDisplayName } from "../html";
import { checkIcon, copyIcon } from "../icons";
import { detailHtml } from "../render/detail";
import { mountResultGrid } from "../render/grid";
import { accessMatrix, paintLegend } from "../render/queue";
import { resultCsv, resultJson, resultMarkdown } from "../render/resultexport";
import { classifyQuery } from "../sql/classify";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import { textSchema } from "../sql/schema";
import type { HistItem } from "../types";

// The grid's own header, pager and the row-count footer under it, so a grid scrolled into
// view fits the pane whole; never smaller than a usable window of rows.
const GRID_CHROME_PX = 150;
const GRID_MIN_PX = 240;

interface DetailViewDeps {
  root: HTMLElement;
  annotator: SchemaAnnotator;
  dialect: () => string;
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
  private readonly root: HTMLElement;
  private readonly annotator: SchemaAnnotator;
  private readonly dialect: () => string;

  constructor(deps: DetailViewDeps) {
    this.root = deps.root;
    this.annotator = deps.annotator;
    this.dialect = deps.dialect;
  }

  // The item whose request is open: closed again whenever another item opens.
  private requestOpen: string | null = null;

  showing(): string | null {
    return this.detailItem?.id ?? null;
  }

  open(item: HistItem, annotate: "live" | "text" = "live"): void {
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (!panel) {
      return;
    }
    this.detailItem = item;
    if (this.requestOpen !== item.id) this.requestOpen = null;
    panel.innerHTML = detailHtml(
      item,
      annotate === "text" ? "audit" : "hist",
      this.dialect(),
      this.requestOpen === item.id,
    );
    panel.hidden = false;
    this.mountGrid(panel, item);
    void this.annotateDetail(item, annotate);
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
        : textSchema(item.sql, this.dialect());
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
      const dialect = this.dialect();
      cm.innerHTML = accessMatrix(
        item.sql,
        dialect,
        classifyQuery(item.sql, dialect).class,
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

  // Save the held rows through the host's file dialog as CSV or JSON. A no-op once the
  // result has been purged (retention or the byte budget) after the detail opened.
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

  // Quick copy of the held rows to the clipboard as Markdown, flashing a check on the
  // trigger's icon (like copySql). A no-op if the result was purged.
  async copyResult(_fmt: "md"): Promise<void> {
    const result = this.detailItem?.result;
    if (!result) {
      return;
    }
    await clipboard.writeText(resultMarkdown(result));
    const ico = this.root.querySelector<HTMLElement>("#detail [data-flyout-ico]");
    if (ico) {
      ico.innerHTML = checkIcon;
      window.setTimeout(() => {
        ico.innerHTML = copyIcon;
      }, 1200);
    }
  }

  close(): void {
    this.detailItem = null;
    this.requestOpen = null;
    this.destroyGrid();
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }
}
