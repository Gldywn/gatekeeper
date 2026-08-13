import { describe, expect, it, vi } from "vitest";

// settings.ts imports appStorage only for the store; the pure helpers under test
// never touch it, so a no-op mock keeps this a plain node run.
vi.mock("@beekeeperstudio/plugin", () => ({
  appStorage: {
    getItem: async () => null,
    setItem: async () => {},
  },
}));

import { defaultSettings, filterSchema, normalizeSettings, resultBudgetBytes } from "./settings";
import type { SchemaContext } from "./sql/schema";

const full: SchemaContext = {
  tables: ["audit.users"],
  pii: ["email"],
  client: ["company_name"],
  literals: ["jane@acme.io"],
  star: false,
};

describe("settings/normalizeSettings", () => {
  it("fills every default for an empty blob", () => {
    expect(normalizeSettings(undefined)).toEqual(defaultSettings());
  });

  it("keeps a valid recentlyResolved option and an explicit false", () => {
    const s = normalizeSettings({ piiFlagging: false, recentlyResolved: 50 });
    expect(s.piiFlagging).toBe(false);
    expect(s.clientFlagging).toBe(true);
    expect(s.recentlyResolved).toBe(50);
  });

  it("falls back to 20 for an out-of-range or non-numeric recentlyResolved", () => {
    expect(normalizeSettings({ recentlyResolved: 999 }).recentlyResolved).toBe(20);
    expect(normalizeSettings({ recentlyResolved: "nope" }).recentlyResolved).toBe(20);
  });

  it("keeps a valid resultCacheMb option and defaults an invalid one to 512", () => {
    expect(normalizeSettings({ resultCacheMb: 1024 }).resultCacheMb).toBe(1024);
    expect(normalizeSettings({ resultCacheMb: 300 }).resultCacheMb).toBe(512);
    expect(normalizeSettings({ resultCacheMb: "nope" }).resultCacheMb).toBe(512);
  });

  it("derives the serialized byte budget from the RAM ceiling (heap factor 3)", () => {
    expect(resultBudgetBytes(defaultSettings())).toBe(Math.floor((512 * 1024 * 1024) / 3));
  });
});

describe("settings/filterSchema", () => {
  it("passes everything through when all guards are on", () => {
    expect(filterSchema(full, defaultSettings())).toEqual(full);
  });

  it("drops the whole annotation when schema annotation is off", () => {
    expect(filterSchema(full, { ...defaultSettings(), schemaAnnotation: false })).toBeNull();
  });

  it("blanks each detection axis independently", () => {
    expect(filterSchema(full, { ...defaultSettings(), piiFlagging: false })).toEqual({
      ...full,
      pii: [],
    });
    expect(filterSchema(full, { ...defaultSettings(), clientFlagging: false })?.client).toEqual([]);
    expect(filterSchema(full, { ...defaultSettings(), sensitiveValues: false })?.literals).toEqual(
      [],
    );
  });

  it("returns null for a null annotation", () => {
    expect(filterSchema(null, defaultSettings())).toBeNull();
  });
});
