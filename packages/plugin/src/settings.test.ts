import { describe, expect, it, vi } from "vitest";

// settings.ts imports appStorage only for the store; the pure helpers under test
// never touch it, so a no-op mock keeps this a plain node run.
vi.mock("@beekeeperstudio/plugin", () => ({
  appStorage: {
    getItem: async () => null,
    setItem: async () => {},
  },
}));

import { defaultSettings, filterSchema, normalizeSettings } from "./settings";
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

  it("drops the Result memory budget an older blob still stores", () => {
    expect(normalizeSettings({ resultCacheMb: 1024, recentlyResolved: 50 })).toEqual({
      ...defaultSettings(),
      recentlyResolved: 50,
    });
  });

  it("keeps a valid auto-stop option and turns anything else off", () => {
    expect(defaultSettings().autoStopMinutes).toBe(0);
    expect(normalizeSettings({ autoStopMinutes: 15 }).autoStopMinutes).toBe(15);
    expect(normalizeSettings({ autoStopMinutes: 7 }).autoStopMinutes).toBe(0);
    expect(normalizeSettings({ autoStopMinutes: "5" }).autoStopMinutes).toBe(5);
    expect(normalizeSettings({ autoStopMinutes: -1 }).autoStopMinutes).toBe(0);
  });
});

describe("settings/filterSchema", () => {
  it("passes everything through when all guards are on", () => {
    expect(filterSchema(full, defaultSettings())).toEqual(full);
  });

  it("keeps annotating whatever an older stored blob asked for (2026-09-21 decision)", () => {
    // schemaAnnotation was removed as a setting; a false left in storage cannot bring it
    // back, and the three display preferences keep their own effect.
    const stored = normalizeSettings({ schemaAnnotation: false, piiFlagging: false });
    expect("schemaAnnotation" in stored).toBe(false);
    expect(filterSchema(full, stored)).toEqual({ ...full, pii: [] });
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
