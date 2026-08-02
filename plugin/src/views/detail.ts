import type { SchemaAnnotator } from "../annotate";
import { detailHtml, gridHtml } from "../render/detail";
import { schemaInner } from "../render/queue";
import { HIST_PAGE_SIZE } from "../result";
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
  // a detail still on screen, and the pager can re-slice its held rows.
  private detailItem: HistItem | null = null;
  // Which page of the held result rows the grid shows; reset whenever a new item
  // opens so a reopened row always starts at the first page.
  private pageIndex = 0;
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
    this.pageIndex = 0;
    panel.innerHTML = detailHtml(item);
    panel.hidden = false;
    void this.annotateDetail(item);
  }

  // Step the held-rows pager and repaint only the table slice + footer, so the rest
  // of the overlay (head, SQL, annotation) stays put. Pages in memory, never a
  // re-query; clamped to the valid range.
  page(delta: number): void {
    const result = this.detailItem?.result;
    if (!result || result.rows.length === 0) {
      return;
    }
    const pageCount = Math.max(1, Math.ceil(result.rows.length / HIST_PAGE_SIZE));
    const next = Math.min(Math.max(0, this.pageIndex + delta), pageCount - 1);
    if (next === this.pageIndex) {
      return;
    }
    this.pageIndex = next;
    const grid = this.root.querySelector<HTMLElement>("#detail-grid");
    if (grid) {
      grid.innerHTML = gridHtml(result, this.pageIndex);
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

  close(): void {
    this.detailItem = null;
    this.pageIndex = 0;
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }
}
