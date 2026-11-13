import { describe, expect, it, vi } from "vitest";

vi.mock("@beekeeperstudio/plugin", () => ({ appStorage: {}, log: { error: vi.fn() } }));

import { SAVED_KEY_MASK } from "../render/auto";
import { SettingsView } from "./settings";

// The few nodes showKey touches, without a DOM: the evaluator page's key field and its remove.
function page(value: string, focused: boolean) {
  const input = { value };
  const remove = { hidden: true };
  const doc = { activeElement: focused ? input : null };
  const panel = {
    hidden: false,
    ownerDocument: doc,
    querySelector: (s: string) =>
      s === "#autoKey" ? input : s === "[data-key-remove]" ? remove : null,
  };
  const root = { querySelector: () => panel } as unknown as HTMLElement;
  const view = new SettingsView({ root, settings: () => ({}) as never, mode: () => "read" });
  return { view, input, remove };
}

describe("a key saved or removed later", () => {
  it("updates only the key's own controls", () => {
    const { view, input, remove } = page("", false);
    view.showKey(true);
    expect(input.value).toBe(SAVED_KEY_MASK);
    expect(remove.hidden).toBe(false);
    view.showKey(false);
    expect(input.value).toBe("");
    expect(remove.hidden).toBe(true);
  });

  it("never overwrites a key being typed", () => {
    for (const [value, focused] of [
      ["typing-a-new-key", true],
      ["typed-and-left", false],
    ] as const) {
      const { view, input } = page(value, focused);
      view.showKey(true);
      expect(input.value).toBe(value);
    }
  });
});
