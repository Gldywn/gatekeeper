import { describe, expect, it, vi } from "vitest";
import { relAge, withSqlKeywords } from "./html";

describe("withSqlKeywords", () => {
  it("escapes the prose, then styles whole SQL keywords only", () => {
    expect(withSqlKeywords("adds DELETE, DROP <b> & SELECTED rows in a WHERE filter")).toBe(
      'adds <code class="kw">DELETE</code>, <code class="kw">DROP</code> &lt;b&gt; &amp; SELECTED rows in a <code class="kw">WHERE</code> filter',
    );
  });
});

describe("relAge", () => {
  it("runs from seconds to days, rounded down at each step", () => {
    vi.useFakeTimers({ now: 10 * 86_400_000 });
    const ago = (s: number) => relAge(Date.now() - s * 1000);
    expect([ago(5), ago(59), ago(60), ago(3_599), ago(3_600), ago(86_399), ago(86_400)]).toEqual([
      "5s ago",
      "59s ago",
      "1m ago",
      "59m ago",
      "1h ago",
      "23h ago",
      "1d ago",
    ]);
    vi.useRealTimers();
  });
});
