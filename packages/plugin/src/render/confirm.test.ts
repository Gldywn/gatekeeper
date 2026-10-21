import { describe, expect, it, vi } from "vitest";
import { takeOver } from "../modal";
import { ConfirmModal, type ConfirmSpec, confirmHtml, runSentence } from "./confirm";
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
    expect(html).toContain('<span class="pii-col" title="Possible PII">email</span>');
    expect(html).toContain(
      '<span class="st sensitive-val" title="Sensitive value">\'jane@acme.io\'</span>',
    );
    // The tone reaches the card, which is what turns the frame red on a destructive.
    expect(html).toContain(
      '<div class="detail-card confirm-card destructive with-sql" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">',
    );
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

describe("runSentence", () => {
  it("says what the statement does to which table on which database", () => {
    expect(runSentence("", "UPDATE", ["treasury.debit_orders"], "<db>", false)).toBe(
      'It changes rows of <code class="name">treasury.debit_orders</code> on <db>, once, when you confirm.',
    );
    expect(runSentence("", "DELETE", ["a<b"], "<db>", true)).toBe(
      'It removes rows from <code class="name">a&lt;b</code> on <db>, once, when you confirm.',
    );
    // No single operation the parse vouches for: the database only.
    expect(runSentence("", undefined, [], "<db>", false)).toBe(
      "It changes data on <db>, once, when you confirm.",
    );
    expect(runSentence("", undefined, [], "<db>", true)).toBe(
      "It runs on <db>, once, when you confirm.",
    );
  });

  it("does not claim an upsert only adds rows", () => {
    const say = (sql: string) => runSentence(sql, "INSERT", ["firms"], "<db>", false);
    expect(say("INSERT INTO firms (id) VALUES (1)")).toContain("It adds rows to");
    expect(
      say("INSERT INTO firms (id, n) VALUES (1, 'A') ON CONFLICT (id) DO UPDATE SET n = 'B'"),
    ).toContain("It adds or changes rows of");
    expect(say("INSERT INTO firms (id) VALUES (1) ON DUPLICATE KEY UPDATE id = 2")).toContain(
      "It adds or changes rows of",
    );
    expect(say("INSERT INTO firms (id) VALUES (1) ON CONFLICT DO NOTHING")).toContain(
      "It adds rows to",
    );
    expect(
      say(
        "INSERT INTO firms (id) VALUES (1) ON /* policy */ CONFLICT (id) DO -- x\n UPDATE SET id = 2",
      ),
    ).toContain("It adds or changes rows of");
    expect(say("INSERT INTO firms (n) VALUES ('on conflict do update')")).toContain(
      "It adds rows to",
    );
  });

  it("puts the sentence and the tables in place of the body, before the SQL", () => {
    const html = confirmHtml({
      tone: "write",
      heading: "Run this UPDATE?",
      body: "",
      facts: { sentence: "It changes rows.", matrix: '<table class="mx"></table>' },
      sql: "UPDATE t SET a = 1",
      confirmLabel: "Run UPDATE",
      onConfirm: () => {},
    });
    expect(html).toContain('<p class="confirm-text">It changes rows.</p>');
    expect(html.indexOf('class="confirm-mx"')).toBeLessThan(
      html.indexOf('class="sql confirm-sql"'),
    );
  });
});

describe("ConfirmModal", () => {
  it("closes a run confirm once its request stops waiting, and only for that request", () => {
    const panel = { innerHTML: "", hidden: true, querySelector: () => ({ focus: vi.fn() }) };
    const modal = new ConfirmModal({
      addEventListener: vi.fn(),
      querySelector: () => panel,
    } as unknown as HTMLElement);
    const onConfirm = vi.fn();
    modal.open({
      tone: "write",
      heading: "Run?",
      body: "",
      confirmLabel: "Run",
      requestId: "a",
      onConfirm,
    });
    modal.dismissFor("b");
    expect(modal.isOpen).toBe(true);
    modal.dismissFor("a");
    expect(modal.isOpen).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("takeOver", () => {
  it("makes the rest inert, spares an overlay already inert, and returns the focus", () => {
    const opener = { isConnected: true, getClientRects: () => [{}], focus: vi.fn() } as {
      isConnected: boolean;
      getClientRects: () => object[];
      focus: ReturnType<typeof vi.fn>;
      ownerDocument?: unknown;
    };
    const doc = { activeElement: opener, body: {} };
    opener.ownerDocument = doc;
    const inbox = { inert: false };
    const settings = { inert: true };
    const confirm = { inert: false, hidden: true };
    const overlay = { ownerDocument: doc, parentElement: { children: [] as object[] } };
    overlay.parentElement.children.push(inbox, overlay, settings, confirm);
    const gear = { focus: vi.fn() };
    const release = takeOver(
      overlay as unknown as HTMLElement,
      () => gear as unknown as HTMLElement,
    );
    expect(inbox.inert).toBe(true);
    // A closed overlay stays live, so a confirm can still open over this one.
    expect(confirm.inert).toBe(false);
    release();
    expect(inbox.inert).toBe(false);
    expect(settings.inert).toBe(true);
    expect(opener.focus).toHaveBeenCalledOnce();
    // The opener gone by then (the gear menu's own button): the fallback takes the focus.
    opener.isConnected = false;
    takeOver(overlay as unknown as HTMLElement, () => gear as unknown as HTMLElement)();
    expect(gear.focus).toHaveBeenCalledOnce();
  });
});
