import { describe, expect, it, vi } from "vitest";

// archive.ts reaches Beekeeper's storage only through its default argument; every test here
// hands it an in-memory one instead.
vi.mock("@beekeeperstudio/plugin", () => ({ appStorage: {} }));

import { type KeyStorage, parseResult, ResultArchive } from "./archive";
import type { HistResult } from "./result";

// Each call yields to the event loop, as Beekeeper's storage does over postMessage, so two
// archives sharing one store genuinely interleave.
function memoryStorage(): KeyStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    data,
    async getItem<T>(key: string) {
      await tick();
      return (data.has(key) ? structuredClone(data.get(key)) : null) as T | null;
    },
    async setItem(key, value) {
      await tick();
      data.set(key, structuredClone(value));
    },
  };
}

const RESULT: HistResult = {
  fields: [{ name: "id" }, { name: "email" }],
  rows: [
    { id: 1, email: "a.moreau@example.com" },
    { id: 2, email: null },
  ],
  rowCount: 39,
  truncated: true,
};

const flip = (payload: string, at: number) => {
  const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  bytes[at] ^= 1;
  return btoa(String.fromCharCode(...bytes));
};

describe("ResultArchive", () => {
  it("opens what it sealed, an empty result with its fields and a write's count included", async () => {
    const archive = new ResultArchive(memoryStorage());
    const empty: HistResult = { fields: [{ name: "id" }], rows: [], rowCount: 0, truncated: false };
    const write: HistResult = { ...empty, affectedRows: 2 };
    for (const result of [RESULT, empty, write]) {
      expect(await archive.open(await archive.seal(result, "req_1"), "req_1")).toEqual(result);
    }
  });

  it("refuses a tampered envelope, another request's envelope and an unknown version", async () => {
    const archive = new ResultArchive(memoryStorage());
    const sealed = await archive.seal(RESULT, "req_1");
    await expect(archive.open(flip(sealed, 40), "req_1")).rejects.toThrow();
    await expect(archive.open(sealed, "req_2")).rejects.toThrow();
    await expect(archive.open(flip(sealed, 0), "req_1")).rejects.toThrow("Unknown result envelope");
    await expect(archive.open("AAAA", "req_1")).rejects.toThrow("Unknown result envelope");
  });

  it("cannot open rows sealed under a key its storage does not hold", async () => {
    const sealed = await new ResultArchive(memoryStorage()).seal(RESULT, "req_1");
    await expect(new ResultArchive(memoryStorage()).open(sealed, "req_1")).rejects.toThrow(
      "Result key not found",
    );
  });

  it("refuses an envelope past the kept size before decoding it or reading a key", async () => {
    const storage = memoryStorage();
    const archive = new ResultArchive(storage);
    const get = vi.spyOn(storage, "getItem");
    const oversized = "A".repeat(Math.ceil((9 * 1024 * 1024) / 3) * 4 + 4);
    await expect(archive.open(oversized, "req_1")).rejects.toThrow("Result envelope too large");
    expect(get).not.toHaveBeenCalled();
  });

  it("stops opening once the result grows past its bound", async () => {
    const archive = new ResultArchive(memoryStorage());
    const huge = { ...RESULT, rows: [{ blob: "a".repeat(17 * 1024 * 1024) }] };
    const sealed = await archive.seal(huge, "req_1");
    await expect(archive.open(sealed, "req_1")).rejects.toThrow("Result too large");
  });

  it("keeps every key when two tabs create one at the same time", async () => {
    const storage = memoryStorage();
    const a = new ResultArchive(storage);
    const b = new ResultArchive(storage);
    const [ka, kb] = await Promise.all([a.ready(), b.ready()]);
    const sealedA = await a.seal(RESULT, "req_a");
    const sealedB = await b.seal(RESULT, "req_b");
    // Both tabs close; a later one still opens everything either of them sealed.
    const later = new ResultArchive(storage);
    expect(await later.open(sealedA, "req_a")).toEqual(RESULT);
    expect(await later.open(sealedB, "req_b")).toEqual(RESULT);
    expect(ka.id).not.toBe(kb.id);
  });

  it("reuses the current key across tabs once one exists", async () => {
    const storage = memoryStorage();
    const first = await new ResultArchive(storage).ready();
    expect((await new ResultArchive(storage).ready()).id).toBe(first.id);
  });

  it("starts a new key under a new id when the current one is gone, never reusing its id", async () => {
    const storage = memoryStorage();
    const lost = await new ResultArchive(storage).ready();
    storage.data.delete(`gatekeeper.history.key.${lost.id}`);
    const fresh = await new ResultArchive(storage).ready();
    expect(fresh.id).not.toBe(lost.id);
    expect(storage.data.has(`gatekeeper.history.key.${lost.id}`)).toBe(false);
  });

  it("seals nothing until the key is stored, and tries again on the next seal", async () => {
    const storage = memoryStorage();
    const set = storage.setItem;
    storage.setItem = async () => {};
    const archive = new ResultArchive(storage);
    await expect(archive.seal(RESULT, "req_1")).rejects.toThrow("Result key was not stored");
    storage.setItem = set;
    const sealed = await archive.seal(RESULT, "req_1");
    expect(await new ResultArchive(storage).open(sealed, "req_1")).toEqual(RESULT);
  });
});

describe("parseResult", () => {
  it.each([
    ["no fields", { rows: [], rowCount: 0, truncated: false }],
    ["a field without a name", { fields: [{}], rows: [], rowCount: 0, truncated: false }],
    ["a row that is not an object", { fields: [], rows: [[1]], rowCount: 1, truncated: false }],
    ["a negative count", { fields: [], rows: [], rowCount: -1, truncated: false }],
    ["a fractional count", { fields: [], rows: [], rowCount: 1.5, truncated: false }],
    ["no truncation flag", { fields: [], rows: [], rowCount: 0 }],
    ["a text count", { fields: [], rows: [], rowCount: 0, truncated: false, affectedRows: "2" }],
  ])("refuses %s", (_, value) => {
    expect(() => parseResult(value)).toThrow("Malformed result");
  });

  it("keeps an unknown count unknown", () => {
    expect(parseResult({ fields: [], rows: [], rowCount: null, truncated: false }).rowCount).toBe(
      null,
    );
  });
});
