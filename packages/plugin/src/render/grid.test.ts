import type { CellComponent } from "tabulator-tables";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cellTooltip, columnDef } from "./grid";

// Tabulator writes a string tooltip or a plain column title with innerHTML; the grid must hand it
// nodes whose text is set as text. A stand-in document records how each node was filled.
interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
}

beforeEach(() => {
  vi.stubGlobal("document", {
    createElement: (tagName: string): FakeNode => ({ tagName, className: "", textContent: "" }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const markup = '<img src="x" onerror="alert(1)">';

describe("result grid", () => {
  it("gives a long text value's tooltip as a text node, never as markup", () => {
    const value = `${markup}${"a".repeat(60)}`;
    const cell = { getValue: () => value } as unknown as CellComponent;
    const tip = cellTooltip(new Event("mouseover"), cell) as unknown as FakeNode;
    expect(typeof tip).toBe("object");
    expect(tip.textContent).toBe(value);
  });

  it("titles a column with a text node, whatever name the query gave it", () => {
    const def = columnDef(markup, [{ [markup]: 1 }]);
    const title = (def.titleFormatter as () => FakeNode)();
    expect(title.textContent).toBe(markup);
  });
});
