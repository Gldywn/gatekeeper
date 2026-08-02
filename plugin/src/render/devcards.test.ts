import { describe, expect, it } from "vitest";
import { SchemaAnnotator } from "../annotate";
import { isReadOnlyQuery } from "../sql/readonly";
import { analyzeSql, clientColumns, piiColumns, sensitiveLiterals } from "../sql/schema";
import {
  buildDevCard,
  DEV_CARD_TYPES,
  type DevCardType,
  devBundle,
  devCardSpec,
  devPanelHtml,
} from "./devcards";
import { schemaInner } from "./queue";

const DIALECTS = ["postgresql", "mysql"] as const;

// The dev cards have no real tables, so [] is the right column set: detection must
// come from the query text alone, exactly as the annotator sees it here.
function flags(sql: string, dialect: string) {
  const parsed = analyzeSql(sql, dialect);
  return {
    parsed,
    pii: parsed ? piiColumns(parsed, []) : [],
    client: parsed ? clientColumns(parsed, []) : [],
    literals: sensitiveLiterals(sql, dialect),
  };
}

describe("devcards/generator", () => {
  it("returns one spec per type, in panel order", () => {
    expect(DEV_CARD_TYPES).toEqual(["pii", "client", "sensitive", "star", "plain"]);
    expect(devBundle().map((s) => s.type)).toEqual([...DEV_CARD_TYPES]);
  });

  it("builds a synthetic card that is ready, flagged dev, and never a real lease", () => {
    const now = 1_000_000;
    const card = buildDevCard(devCardSpec("pii"), "dev_0001", now);
    expect(card.dev).toBe(true);
    expect(card.state).toBe("ready");
    expect(card.id).toBe("dev_0001");
    expect(card.leaseId).toBe("dev_0001-lease");
    expect(card.sessionId).toBe("dev-mode");
    expect(card.session?.harness).toBe("dev-mode");
    expect(card.createdAt).toBe(now);
    expect(card.expiresAt).toBe(now + 300_000);
    expect(card.leaseExpiresAt).toBe(now + 300_000);
  });
});

describe("devcards/SQL is always read-only on both dialects", () => {
  for (const type of DEV_CARD_TYPES) {
    for (const dialect of DIALECTS) {
      it(`${type} on ${dialect}`, () => {
        const { sql } = devCardSpec(type);
        expect(isReadOnlyQuery(sql, dialect)).toBe(true);
        // Also proves it parses (no dialect-specific syntax error), i.e. it will run.
        expect(analyzeSql(sql, dialect)).not.toBeNull();
      });
    }
  }
});

describe("devcards/each type triggers its own detection on both dialects", () => {
  const expected: Record<DevCardType, (f: ReturnType<typeof flags>) => void> = {
    pii: (f) => {
      expect(f.pii).toEqual(["email", "full_name", "phone"]);
      // The email literal is also flagged (its shape is PII), a bonus axis.
      expect(f.literals).toContain("a@b.com");
    },
    client: (f) => {
      expect(f.client).toEqual(["company_name"]);
    },
    sensitive: (f) => {
      expect(f.literals).toEqual(["noreply@example.com"]);
      expect(f.pii).toEqual([]);
      expect(f.client).toEqual([]);
    },
    star: (f) => {
      expect(f.parsed?.star).toBe(true);
      expect(f.parsed?.tables).toEqual([{ schema: "information_schema", name: "tables" }]);
    },
    plain: (f) => {
      expect(f.pii).toEqual([]);
      expect(f.client).toEqual([]);
      expect(f.literals).toEqual([]);
      expect(f.parsed?.star).toBe(false);
    },
  };

  for (const type of DEV_CARD_TYPES) {
    for (const dialect of DIALECTS) {
      it(`${type} on ${dialect}`, () => {
        expected[type](flags(devCardSpec(type).sql, dialect));
      });
    }
  }
});

describe("devcards/panel", () => {
  it("renders the bundle button and one chip per type", () => {
    const html = devPanelHtml();
    expect(html).toContain("data-dev-bundle");
    for (const type of DEV_CARD_TYPES) {
      expect(html).toContain(`data-dev-chip="${type}"`);
    }
    expect(html).toContain("Sensitive literal");
    expect(html).toContain("SELECT *");
  });
});

// End-to-end: generator SQL through the real annotator into the on-card render. The
// dev cards are table-less, so getColumns is never reached; a stub keeps it a plain run.
describe("devcards/render pipeline", () => {
  function annotate(sql: string, dialect: string) {
    return new SchemaAnnotator({
      getColumns: async () => [],
      dialect: () => dialect,
      defaultSchema: () => undefined,
      generation: () => 0,
    }).schemaFor(sql);
  }

  it("surfaces the PII flags on the card for both dialects", async () => {
    for (const dialect of DIALECTS) {
      const html = schemaInner(await annotate(devCardSpec("pii").sql, dialect));
      expect(html).toContain("possible PII");
      for (const col of ["email", "full_name", "phone"]) {
        expect(html).toContain(col);
      }
    }
  });

  it("surfaces the client-data flag on the card", async () => {
    const html = schemaInner(await annotate(devCardSpec("client").sql, "postgresql"));
    expect(html).toContain("client data");
    expect(html).toContain("company_name");
  });

  it("surfaces the sensitive-value flag on the card", async () => {
    const html = schemaInner(await annotate(devCardSpec("sensitive").sql, "mysql"));
    expect(html).toContain("sensitive value");
  });

  it("leaves the plain card unannotated", async () => {
    expect(schemaInner(await annotate(devCardSpec("plain").sql, "postgresql"))).toBe("");
  });
});
