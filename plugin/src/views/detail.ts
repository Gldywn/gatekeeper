import type { SchemaAnnotator } from "../annotate";
import { detailHtml } from "../render/detail";
import { schemaInner } from "../render/queue";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import type { HistItem } from "../types";

interface DetailViewDeps {
  root: HTMLElement;
  annotator: SchemaAnnotator;
}

// Owns the resolved-history detail overlay (#detail): its open item and DOM subtree.
// Reads the host-side schema annotator so a reopened row shows the same reads/PII
// annotation as the pending card did.
export class DetailView {
  // The history item whose detail overlay is open, so a late schema fetch only paints
  // a detail still on screen.
  private detailItemId: string | null = null;
  private readonly root: HTMLElement;
  private readonly annotator: SchemaAnnotator;

  constructor(deps: DetailViewDeps) {
    this.root = deps.root;
    this.annotator = deps.annotator;
  }

  open(item: HistItem): void {
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (!panel) {
      return;
    }
    this.detailItemId = item.id;
    panel.innerHTML = detailHtml(item);
    panel.hidden = false;
    void this.annotateDetail(item);
  }

  // Match the pending card: once the schema resolves, show the same reads/PII/client
  // annotation under the detail SQL and light the sensitive columns in the query text.
  private async annotateDetail(item: HistItem): Promise<void> {
    const schema = (await this.annotator.schemaFor(item.sql)) ?? null;
    if (this.detailItemId !== item.id) {
      return;
    }
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
    this.detailItemId = null;
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }
}
