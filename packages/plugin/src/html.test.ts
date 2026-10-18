import { describe, expect, it } from "vitest";
import { withSqlKeywords } from "./html";

describe("withSqlKeywords", () => {
  it("escapes the prose, then styles whole SQL keywords only", () => {
    expect(withSqlKeywords("adds DELETE, DROP <b> & SELECTED rows in a WHERE filter")).toBe(
      'adds <code class="kw">DELETE</code>, <code class="kw">DROP</code> &lt;b&gt; &amp; SELECTED rows in a <code class="kw">WHERE</code> filter',
    );
  });
});
