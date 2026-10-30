import { describe, expect, it, vi } from "vitest";

// settings.ts imports appStorage only for the store; the pure helpers under test
// never touch it, so a no-op mock keeps this a plain node run.
const { getItem } = vi.hoisted(() => ({ getItem: vi.fn(async (): Promise<unknown> => null) }));
vi.mock("@beekeeperstudio/plugin", () => ({
  appStorage: {
    getItem: (key: string) => getItem(key),
    setItem: async () => {},
  },
}));

import { defaultSettings, filterSchema, normalizeSettings, SettingsStore } from "./settings";
import type { SchemaContext } from "./sql/schema";

const full: SchemaContext = {
  tables: ["audit.users"],
  pii: ["email"],
  client: ["company_name"],
  complete: false,
};

describe("settings/normalizeSettings", () => {
  it("fills every default for an empty blob", () => {
    expect(normalizeSettings(undefined)).toEqual(defaultSettings());
  });

  it("turns auto-deny of heavy queries on unless explicitly turned off", () => {
    expect(defaultSettings().autoDenyHeavy).toBe(true);
    expect(normalizeSettings({ autoDenyHeavy: "nope" }).autoDenyHeavy).toBe(true);
    expect(normalizeSettings({ autoDenyHeavy: false }).autoDenyHeavy).toBe(false);
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
    // schemaAnnotation and sensitiveValues were removed as settings; a value left in storage
    // cannot bring them back, and the two display preferences keep their own effect.
    const stored = normalizeSettings({
      schemaAnnotation: false,
      sensitiveValues: false,
      piiFlagging: false,
    });
    expect("schemaAnnotation" in stored).toBe(false);
    expect("sensitiveValues" in stored).toBe(false);
    expect(filterSchema(full, stored)).toEqual({ ...full, pii: [] });
  });

  it("blanks each detection axis independently, never the untraced-output limit", () => {
    expect(filterSchema(full, { ...defaultSettings(), piiFlagging: false })).toEqual({
      ...full,
      pii: [],
    });
    expect(filterSchema(full, { ...defaultSettings(), clientFlagging: false })?.client).toEqual([]);
    expect(
      filterSchema(full, { ...defaultSettings(), piiFlagging: false, clientFlagging: false })
        ?.complete,
    ).toBe(false);
  });

  it("returns null for a null annotation", () => {
    expect(filterSchema(null, defaultSettings())).toBeNull();
  });
});

describe("settings/SettingsStore", () => {
  it("keeps the active connection's preferences when an older load resolves last", async () => {
    let resolveSlow!: (value: unknown) => void;
    getItem
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
      )
      .mockResolvedValueOnce({ b: { autoDenyHeavy: false } });
    const store = new SettingsStore();
    const first = store.load("a");
    expect(store.loadedForConnection("a")).toBe(false);
    await store.load("b");
    expect(store.loadedForConnection("b")).toBe(true);
    resolveSlow({ a: { autoDenyHeavy: true }, b: { autoDenyHeavy: false } });
    await first;
    expect(store.get().autoDenyHeavy).toBe(false);
    expect(store.loadedForConnection("b")).toBe(true);
  });
});

describe("settings/SettingsStore reloads", () => {
  it("lets only the latest load apply, even for the same connection", async () => {
    let resolveFirst!: (value: unknown) => void;
    getItem
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({ b: {} })
      .mockResolvedValueOnce({ a: { autoDenyHeavy: false } });
    const store = new SettingsStore();
    const first = store.load("a");
    await store.load("b");
    await store.load("a");
    expect(store.get().autoDenyHeavy).toBe(false);
    resolveFirst({ a: { autoDenyHeavy: true } });
    await first;
    expect(store.get().autoDenyHeavy).toBe(false);
    expect(store.loadedForConnection("a")).toBe(true);
  });
});
