import { describe, expect, it, vi } from "vitest";

vi.mock("@beekeeperstudio/plugin", () => ({
  clipboard: { writeText: vi.fn() },
  log: { error: vi.fn() },
  requestFileSave: vi.fn(),
}));

import type { HistItem } from "../types";
import { DetailView } from "./detail";

const item = {
  id: "q1",
  status: "approved",
  note: "2 rows returned",
  sql: "SELECT a FROM t",
  resolvedAt: 0,
  intent: "list the rows",
} as HistItem;

// The few nodes enlarging touches, stubbed: the rows' wrapper in its pane, the dialog shell beside
// the Inbox, and a grid that only records its redraws.
function setup() {
  const doc = { activeElement: null as unknown, body: {} };
  const zoom = {
    isConnected: true,
    ownerDocument: doc,
    getClientRects: () => [{}],
    focus: vi.fn(() => {
      doc.activeElement = zoom;
    }),
  };
  // The order the detail touches things in, where it matters.
  const log: string[] = [];
  const holder = { focus: vi.fn() };
  const next = {};
  const parent = { insertBefore: vi.fn() };
  const wrapper = {
    parentElement: parent as unknown,
    nextSibling: next,
    querySelector: (s: string) =>
      s === "[data-result-zoom]" ? zoom : s === ".tabulator-tableholder" ? holder : null,
  };
  // Moving a node changes its siblings, as the DOM does.
  const card = {
    append: vi.fn((node: typeof wrapper) => {
      node.parentElement = card;
      node.nextSibling = null as never;
    }),
  };
  Object.assign(next, { parentNode: parent });
  parent.insertBefore.mockImplementation((node: typeof wrapper, ref: object | null) => {
    log.push("restore");
    node.parentElement = parent;
    node.nextSibling = ref as never;
  });
  const inbox = { inert: false };
  const overlay = {
    hidden: true,
    innerHTML: "",
    ownerDocument: doc,
    parentElement: { children: [] as object[] },
    querySelector: (s: string) => (s === ".results-card" ? card : null),
  };
  overlay.parentElement.children.push(inbox, overlay);
  const panel = {
    hidden: false,
    set innerHTML(_html: string) {
      log.push("replace");
    },
    querySelector: () => null,
  };
  const root = {
    querySelector: (s: string) =>
      ({
        "#results": overlay,
        "#detail-grid": wrapper,
        "#detail-grid [data-result-zoom]": zoom,
        "#detail": panel,
      })[s] ?? null,
  };
  const closeMenus = vi.fn();
  const view = new DetailView({
    root: root as unknown as HTMLElement,
    annotator: {} as never,
    dialect: () => "postgresql",
    closeMenus,
  });
  const grid = { redraw: vi.fn(), destroy: vi.fn(() => log.push("destroy")) };
  Object.assign(view, { detailItem: item, grid });
  return {
    view,
    doc,
    log,
    zoom,
    holder,
    next,
    parent,
    wrapper,
    card,
    inbox,
    overlay,
    grid,
    closeMenus,
  };
}

describe("DetailView enlarge", () => {
  it("moves the same rows into the dialog and back to their place, once each way", () => {
    const { view, zoom, holder, next, parent, wrapper, card, inbox, overlay, grid, closeMenus } =
      setup();
    view.enlarge();
    expect(card.append).toHaveBeenCalledWith(wrapper);
    expect(overlay.hidden).toBe(false);
    expect(overlay.innerHTML).toContain('id="resultsTitle">List the rows</span>');
    expect(inbox.inert).toBe(true);
    // Fitted in place, never a forced rebuild: sort, page and columns are the grid's own.
    expect(grid.redraw).toHaveBeenCalledWith();
    expect(holder.focus).toHaveBeenCalledOnce();
    expect(closeMenus).toHaveBeenCalledOnce();
    view.enlarge();
    expect(card.append).toHaveBeenCalledOnce();

    expect(view.shrink()).toBe(true);
    expect(parent.insertBefore).toHaveBeenCalledWith(wrapper, next);
    expect(overlay.hidden).toBe(true);
    expect(overlay.innerHTML).toBe("");
    expect(inbox.inert).toBe(false);
    expect(grid.redraw).toHaveBeenCalledTimes(2);
    // Once to be the opener the release returns to, once on that return.
    expect(zoom.focus).toHaveBeenCalledTimes(2);
    expect(view.shrink()).toBe(false);
    expect(grid.destroy).not.toHaveBeenCalled();
  });

  it("puts the rows back without taking the focus when the detail itself goes", () => {
    const { view, log, zoom, parent, wrapper, inbox, grid } = setup();
    view.enlarge();
    view.close();
    expect(parent.insertBefore).toHaveBeenCalledWith(wrapper, expect.anything());
    expect(inbox.inert).toBe(false);
    expect(zoom.focus).toHaveBeenCalledOnce();
    expect(grid.destroy).toHaveBeenCalledOnce();
    expect(log).toEqual(["restore", "destroy", "replace"]);
  });

  it("puts the rows back before another request replaces them", () => {
    const { view, log, inbox, overlay } = setup();
    view.enlarge();
    view.open({ ...item, id: "q2" }, "text");
    expect(log).toEqual(["restore", "replace", "destroy"]);
    expect(overlay.hidden).toBe(true);
    expect(inbox.inert).toBe(false);
  });

  it("carries the Queue's count into the dialog, live, and moves the focus off it at zero", () => {
    const { view, overlay, doc } = setup();
    vi.stubGlobal("document", doc);
    view.setPendingCount(2);
    view.enlarge();
    expect(overlay.innerHTML).toContain('data-results-queue>Queue<span class="n">2</span>');
    const n = { textContent: "2" };
    const close = { focus: vi.fn() };
    let focused = false;
    const queue = { hidden: false, contains: () => focused, querySelector: () => n };
    overlay.querySelector = ((s: string) =>
      s === "[data-results-queue]" ? queue : s === "[data-results-close]" ? close : null) as never;
    // A count arriving in the background never moves the focus.
    view.setPendingCount(3);
    expect(n.textContent).toBe("3");
    expect(queue.hidden).toBe(false);
    view.setPendingCount(0);
    expect(queue.hidden).toBe(true);
    expect(close.focus).not.toHaveBeenCalled();
    // Only a focused Queue hands its focus to Close as it goes.
    view.setPendingCount(1);
    focused = true;
    view.setPendingCount(0);
    expect(close.focus).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
