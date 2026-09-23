import { describe, expect, it } from "vitest";
import { type ConfirmSpec, confirmHtml } from "./confirm";
import { cardHtml } from "./queue";

const schema = {
  tables: ["audit.users"],
  pii: ["email"],
  client: ["company_name"],
  literals: ["jane@acme.io"],
  star: false,
};

const spec: ConfirmSpec = {
  tone: "destructive",
  heading: "Run this destructive statement?",
  body: "This deletes data on the live database the moment you confirm.",
  sql: "DELETE FROM audit.users WHERE email = 'jane@acme.io'",
  schema,
  confirmLabel: "Run destructive",
  onConfirm: () => {},
};

describe("render/confirm", () => {
  it("recalls the statement in the queue card's own SQL block", () => {
    const html = confirmHtml(spec);
    // Same shell as the card: the corner frame, the copy button, the highlighted body.
    expect(html).toContain('<pre class="sql confirm-sql">');
    expect(html).toContain('<code class="sql-body">');
    expect(html).toContain(
      '<button class="copy-sql" type="button" data-copy-sql="DELETE FROM audit.users WHERE email = \'jane@acme.io\'" aria-label="Copy SQL">',
    );
    // Same marks as the card, so a sensitive value cannot look ordinary here.
    expect(html).toContain('<span class="kw">DELETE</span>');
    expect(html).toContain('<span class="pii-col">email</span>');
    expect(html).toContain("<span class=\"st sensitive-val\">'jane@acme.io'</span>");
    // The tone reaches the card, which is what turns the frame red on a destructive.
    expect(html).toContain('<div class="detail-card confirm-card destructive">');
  });

  it("renders the same body as the card it confirms", () => {
    const card = cardHtml(
      {
        id: "q_1",
        sql: spec.sql!,
        state: "ready",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        leaseExpiresAt: Date.now() + 60_000,
        leaseId: "l1",
        sessionId: "s1",
        session: null,
        schema,
      },
      "postgresql",
      new Map(),
      "destructive",
    );
    const body = (html: string) =>
      html.slice(html.indexOf("sql-body"), html.indexOf("</code></pre>"));
    expect(body(confirmHtml(spec))).toContain(body(card).slice(body(card).indexOf("<span")));
  });

  it("escapes a statement that carries markup or quotes, in the block and in the copy", () => {
    const html = confirmHtml({
      ...spec,
      schema: undefined,
      sql: `SELECT '<script>alert("x")</script>' FROM audit.users`,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");
  });

  it("keeps the challenge, the locked confirm and the plain modal without SQL", () => {
    const armed = confirmHtml({
      ...spec,
      challenge: { label: "Type the database name", expected: "prod", placeholder: "prod" },
    });
    expect(armed).toContain("data-confirm-input");
    expect(armed).toContain("data-confirm-go disabled");

    const plain = confirmHtml({ ...spec, sql: undefined, schema: undefined });
    expect(plain).not.toContain('class="sql confirm-sql"');
    expect(plain).not.toContain("data-copy-sql");
    // Copying is not an action of the dialog: it carries no confirm or cancel hook.
    expect(confirmHtml(spec)).not.toContain('data-copy-sql="" data-confirm');
  });
});
