import { describe, expect, it, vi } from "vitest";
import type { SchemaAnnotator } from "../annotate";
import type { HistResult } from "../result";
import type { HistItem } from "../types";

vi.mock("@beekeeperstudio/plugin", () => ({
  clipboard: {},
  log: { error: vi.fn() },
  requestFileSave: vi.fn(),
}));

import { DetailView } from "./detail";

const ROWS: HistResult = {
  fields: [{ name: "id" }],
  rows: [{ id: 1 }, { id: 2 }],
  rowCount: 2,
  truncated: false,
};

const kept = (id: string): HistItem => ({
  id,
  status: "approved",
  note: "2 rows returned",
  sql: "SELECT id FROM invoices",
  resolvedAt: 0,
  connection: "test",
  session: null,
  kept: true,
  result: { ...ROWS, rows: [] },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The pane as the view touches it: its markup, and the result block rows replace in place. No
// grid host is found, so no Tabulator mounts; the markup says what would show.
function view(loadRows: (id: string) => Promise<HistResult>) {
  const block = { outerHTML: "" };
  const panel = {
    innerHTML: "",
    hidden: true,
    querySelector: (s: string) => (s === ".dt-result" ? block : null),
  };
  const root = {
    querySelector: (s: string) => (s === "#detail" ? panel : null),
  } as unknown as HTMLElement;
  const detail = new DetailView({
    root,
    annotator: { schemaFor: async () => null } as unknown as SchemaAnnotator,
    dialect: () => "postgresql",
    loadRows,
  });
  return { detail, panel, block };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("DetailView kept rows", () => {
  it("opens in the loading frame, then shows the rows in the result block alone", async () => {
    const load = deferred<HistResult>();
    const { detail, panel, block } = view(() => load.promise);
    detail.open(kept("a"), "text");
    expect(panel.innerHTML).toContain('class="res loading"');
    load.resolve(ROWS);
    await settle();
    expect(block.outerHTML).toContain('<div class="res" id="detail-grid">');
    expect(block.outerHTML).not.toContain("loading");
  });

  it("drops rows that arrive once another entry is open", async () => {
    const first = deferred<HistResult>();
    const { detail, block } = view((id) => (id === "a" ? first.promise : new Promise(() => {})));
    detail.open(kept("a"), "text");
    detail.open(kept("b"), "text");
    first.resolve(ROWS);
    await settle();
    expect(block.outerHTML).toBe("");
    expect(detail.showing()).toBe("b");
  });

  it("says the rows are not available when they cannot be read, and reads again on reopen", async () => {
    const load = vi.fn(async () => {
      throw new Error("Result key not found");
    });
    const { detail, block } = view(load);
    detail.open(kept("a"), "text");
    await settle();
    expect(block.outerHTML).toContain("These rows are not available.");
    detail.open(kept("a"), "text");
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps the open result, so reopening it shows the rows without reading again", async () => {
    const load = vi.fn(async () => ROWS);
    const { detail, panel } = view(load);
    detail.open(kept("a"), "text");
    await settle();
    detail.open(kept("a"), "text");
    expect(load).toHaveBeenCalledOnce();
    expect(panel.innerHTML).toContain('<div class="res" id="detail-grid">');
    // Another entry takes its place: the earlier rows are let go.
    detail.open({ ...kept("b"), kept: false }, "text");
    detail.open(kept("a"), "text");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reads nothing for a kept result known to be empty", () => {
    const load = vi.fn(async () => ROWS);
    const { detail } = view(load);
    detail.open({ ...kept("a"), result: { ...ROWS, rows: [], rowCount: 0 } }, "text");
    expect(load).not.toHaveBeenCalled();
  });
});
