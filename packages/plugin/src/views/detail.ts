import { clipboard, log, requestFileSave } from "@beekeeperstudio/plugin";
import type { TabulatorFull } from "tabulator-tables";
import type { SchemaAnnotator } from "../annotate";
import { dayKey, sessionDisplayName } from "../html";
import { checkIcon, copyIcon } from "../icons";
import { detailHtml } from "../render/detail";
import { mountResultGrid } from "../render/grid";
import { schemaInner } from "../render/queue";
import { resultCsv, resultJson, resultMarkdown } from "../render/resultexport";
import { filterSchema, type Settings } from "../settings";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import type { HistItem } from "../types";

interface DetailViewDeps {
  root: HTMLElement;
  annotator: SchemaAnnotator;
  settings: () => Settings;
}

// Owns the resolved-history detail overlay (#detail): its open item and DOM subtree.
// Reads the host-side schema annotator so a reopened row shows the same reads/PII
// annotation as the pending card did.
export class DetailView {
  // The history item whose detail overlay is open, so a late schema fetch only paints
  // a detail still on screen.
  private detailItem: HistItem | null = null;
  // The live Tabulator instance for the open item's result, destroyed on close/reopen so
  // its virtual-DOM listeners and detached nodes never outlive the overlay.
  private grid: TabulatorFull | null = null;
  private readonly root: HTMLElement;
  private readonly annotator: SchemaAnnotator;
  private readonly settings: () => Settings;

  constructor(deps: DetailViewDeps) {
    this.root = deps.root;
    this.annotator = deps.annotator;
    this.settings = deps.settings;
  }

  open(item: HistItem): void {
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (!panel) {
      return;
    }
    this.detailItem = item;
    panel.innerHTML = detailHtml(item);
    panel.hidden = false;
    this.mountGrid(panel, item);
    void this.annotateDetail(item);
  }

  // Instantiate Tabulator over the held rows once the overlay markup is in the DOM and
  // visible (the host must be laid out for the virtual renderer to size its viewport).
  // Only the approved-with-rows outcome renders the .gk-grid host.
  private mountGrid(panel: HTMLElement, item: HistItem): void {
    this.destroyGrid();
    const host = panel.querySelector<HTMLElement>(".gk-grid");
    if (host && item.result && item.result.rows.length > 0) {
      this.grid = mountResultGrid(host, item.result);
    }
  }

  private destroyGrid(): void {
    if (this.grid) {
      this.grid.destroy();
      this.grid = null;
    }
  }

  // Match the pending card: once the schema resolves, show the same reads/PII/client
  // annotation under the detail SQL and light the sensitive columns in the query text.
  private async annotateDetail(item: HistItem): Promise<void> {
    const settings = this.settings();
    const raw = settings.schemaAnnotation ? await this.annotator.schemaFor(item.sql) : null;
    if (this.detailItem?.id !== item.id) {
      return;
    }
    const schema = filterSchema(raw ?? null, settings);
    const cs = this.root.querySelector<HTMLElement>("#detail-cs");
    if (cs) {
      cs.innerHTML = schemaInner(schema);
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
  // result has been purged (retention or the byte budget) after the overlay opened.
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
    this.destroyGrid();
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }
}
