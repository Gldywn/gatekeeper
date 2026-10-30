import { appStorage } from "@beekeeperstudio/plugin";
import { canEncrypt } from "./archive-availability";
import type { Field, HistResult } from "./result";

// Sealed here so the server stores rows it cannot read. Beekeeper keeps the key encrypted on
// disk with its own on-disk key: safe from a copy of ~/.gatekeeper alone, not of the whole home.

// version (1) | key id (16) | IV (12) | AES-GCM ciphertext and tag over the gzipped result.
// The version, key id and request id are authenticated, so no envelope opens under another id.
const VERSION = 1;
const KEY_ID_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KEY_ID_BYTES + IV_BYTES;
// The server keeps an envelope of at most 9 MiB (8 MiB of result, gzipped, plus the header); one
// larger is refused before it is decoded. Opened, twice the 8 MiB the agent can be sent.
const MAX_SEALED_BYTES = 9 * 1024 * 1024;
const MAX_OPENED_BYTES = 16 * 1024 * 1024;

const UNAVAILABLE = "Result encryption unavailable";

const CURRENT = "gatekeeper.history.current";
const entry = (id: string) => `gatekeeper.history.key.${id}`;

export interface KeyStorage {
  getItem<T>(key: string): Promise<T | null>;
  setItem(key: string, value: unknown): Promise<void>;
}

const beekeeperStorage: KeyStorage = {
  getItem: <T>(key: string) => appStorage.getItem<T>(key, { encrypted: true }),
  setItem: (key, value) => appStorage.setItem(key, value, { encrypted: true }),
};

// Beekeeper answers storage requests over postMessage with no time limit. One that never comes
// must fail the seal, so the agent still gets its rows, instead of holding the decision forever.
const STORAGE_TIMEOUT_MS = 5_000;

function bounded(storage: KeyStorage, ms: number): KeyStorage {
  const within = <T>(pending: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Key storage did not answer")), ms);
      pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  return {
    getItem: <T>(key: string) => within(storage.getItem<T>(key)),
    setItem: (key, value) => within(storage.setItem(key, value)),
  };
}

// Kept as JSON text: strings are what the plugin already stores encrypted (the broker token),
// so the key does not depend on how Beekeeper carries an object through its encryption.
function parseJwk(raw: unknown): JsonWebKey | null {
  try {
    const jwk = typeof raw === "string" ? (JSON.parse(raw) as JsonWebKey) : null;
    return typeof jwk?.k === "string" ? jwk : null;
  } catch {
    return null;
  }
}

interface CurrentKey {
  id: string;
  key: CryptoKey;
}

export class ResultArchive {
  private readonly storage: KeyStorage;
  private current: Promise<CurrentKey> | undefined;
  private readonly keys = new Map<string, Promise<CryptoKey | null>>();

  constructor(storage: KeyStorage = beekeeperStorage, timeoutMs = STORAGE_TIMEOUT_MS) {
    this.storage = bounded(storage, timeoutMs);
  }

  // Keys are written once under their own id and the pointer only names the next one to use, so
  // two tabs creating a key at once leave two valid keys, never a lost one.
  ready(): Promise<CurrentKey> {
    if (!canEncrypt()) return Promise.reject(new Error(UNAVAILABLE));
    this.current ??= this.loadCurrent().catch((err: unknown) => {
      this.current = undefined;
      throw err;
    });
    return this.current;
  }

  async seal(result: HistResult, requestId: string): Promise<string> {
    const { id, key } = await this.ready();
    const header = new Uint8Array(HEADER_BYTES);
    header[0] = VERSION;
    header.set(hexBytes(id), 1);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    header.set(iv, 1 + KEY_ID_BYTES);
    const plain = await gzip(new TextEncoder().encode(JSON.stringify(sealable(result))));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(header, requestId) },
      key,
      plain as BufferSource,
    );
    return toBase64(concat([header, new Uint8Array(sealed)]));
  }

  // Throws on anything it cannot vouch for (a missing key, a tampered or foreign envelope, an
  // oversized or malformed result); the caller shows the rows as not available.
  async open(payload: string, requestId: string): Promise<HistResult> {
    if (!canEncrypt()) throw new Error(UNAVAILABLE);
    if (payload.length > Math.ceil(MAX_SEALED_BYTES / 3) * 4) {
      throw new Error("Result envelope too large");
    }
    const bytes = fromBase64(payload);
    if (
      bytes.length < HEADER_BYTES + TAG_BYTES ||
      bytes.length > MAX_SEALED_BYTES ||
      bytes[0] !== VERSION
    ) {
      throw new Error("Unknown result envelope");
    }
    const key = await this.key(bytesHex(bytes.subarray(1, 1 + KEY_ID_BYTES)));
    if (!key) {
      throw new Error("Result key not found");
    }
    const header = bytes.subarray(0, HEADER_BYTES);
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: header.subarray(1 + KEY_ID_BYTES) as BufferSource,
        additionalData: aad(header, requestId),
      },
      key,
      bytes.subarray(HEADER_BYTES) as BufferSource,
    );
    const json = new TextDecoder().decode(await gunzip(new Uint8Array(plain), MAX_OPENED_BYTES));
    return parseResult(JSON.parse(json));
  }

  private async loadCurrent(): Promise<CurrentKey> {
    const id = await this.storage.getItem<string>(CURRENT);
    const existing = typeof id === "string" && id ? await this.key(id) : null;
    if (id && existing) {
      return { id, key: existing };
    }
    // Persisted and read back before any use, so nothing is ever sealed under a key not kept.
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    const fresh = bytesHex(crypto.getRandomValues(new Uint8Array(KEY_ID_BYTES)));
    const stored = JSON.stringify(jwk);
    await this.storage.setItem(entry(fresh), stored);
    if ((await this.storage.getItem<string>(entry(fresh))) !== stored) {
      throw new Error("Result key was not stored");
    }
    this.keys.set(fresh, Promise.resolve(key));
    await this.storage.setItem(CURRENT, fresh);
    return { id: fresh, key };
  }

  private key(id: string): Promise<CryptoKey | null> {
    let found = this.keys.get(id);
    if (!found) {
      found = this.storage.getItem<string>(entry(id)).then((raw) => {
        const jwk = parseJwk(raw);
        return jwk
          ? crypto.subtle.importKey("jwk", jwk, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
          : null;
      });
      // A miss is not remembered: another tab may write that entry a moment later.
      found.then(
        (k) => k ?? this.keys.delete(id),
        () => this.keys.delete(id),
      );
      this.keys.set(id, found);
    }
    return found;
  }
}

function sealable(result: HistResult): HistResult {
  return {
    fields: result.fields,
    rows: result.rows,
    rowCount: result.rowCount,
    truncated: result.truncated,
    ...(result.affectedRows === undefined ? {} : { affectedRows: result.affectedRows }),
  };
}

const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// An envelope that authenticates was still written by whoever held the key, and the renderer
// trusts these shapes, so the opened result is checked like any input.
export function parseResult(value: unknown): HistResult {
  const r = value as Record<string, unknown> | null;
  const fields = r?.fields;
  const rows = r?.rows;
  if (
    !Array.isArray(fields) ||
    !fields.every((f) => typeof (f as Field | null)?.name === "string") ||
    !Array.isArray(rows) ||
    !rows.every((row) => typeof row === "object" && row !== null && !Array.isArray(row)) ||
    !(r?.rowCount === null || count(r?.rowCount)) ||
    typeof r?.truncated !== "boolean" ||
    !(r.affectedRows === undefined || count(r.affectedRows))
  ) {
    throw new Error("Malformed result");
  }
  return {
    fields: fields.map((f) => ({ name: (f as Field).name })),
    rows: rows as Record<string, unknown>[],
    rowCount: r.rowCount as number | null,
    truncated: r.truncated,
    ...(r.affectedRows === undefined ? {} : { affectedRows: r.affectedRows as number }),
  };
}

// The request id follows a fixed-length header, so the concatenation reads one way only.
function aad(header: Uint8Array, requestId: string): BufferSource {
  return concat([
    header.subarray(0, 1 + KEY_ID_BYTES),
    new TextEncoder().encode(requestId),
  ]) as BufferSource;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Stops as soon as the output passes `max`, before the whole expansion is held in memory.
async function gunzip(bytes: Uint8Array, max: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("Result too large");
    }
    chunks.push(value);
  }
  return concat(chunks);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const bytesHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
}

// btoa takes a binary string; built in slices so a large result never overflows the call stack.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
