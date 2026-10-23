import { appStorage } from "@beekeeperstudio/plugin";
import type { SchemaContext } from "./sql/schema";

// Per-connection host-side preferences. Every field defaults on; recentlyResolved is
// how many of the latest decisions the Queue shows. None of this ever reaches the broker.
export interface Settings {
  piiFlagging: boolean;
  clientFlagging: boolean;
  // Require a second one-click confirmation before an approved write or destructive
  // statement runs. On by default; a read never prompts.
  confirmWrites: boolean;
  // Reject a query the load check flags as heavy as soon as its card arrives. On by default.
  autoDenyHeavy: boolean;
  // Let connected agents read the database's table/column/type structure (never data)
  // through the get_schema tool. Off by default; the human opts in per connection.
  schemaAccess: boolean;
  recentlyResolved: number;
  // Ask the database to cancel an approved query after this many minutes; 0 is never.
  autoStopMinutes: number;
}

export const RECENTLY_RESOLVED_OPTIONS = [10, 20, 50] as const;
const RECENTLY_RESOLVED_DEFAULT = 20;

export const AUTO_STOP_OPTIONS = [0, 1, 5, 15, 30] as const;

export function defaultSettings(): Settings {
  return {
    piiFlagging: true,
    clientFlagging: true,
    confirmWrites: true,
    autoDenyHeavy: true,
    schemaAccess: false,
    recentlyResolved: RECENTLY_RESOLVED_DEFAULT,
    autoStopMinutes: 0,
  };
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// A stored blob may predate a field or hold a stale recentlyResolved value; coerce
// every field back into range so an older or hand-edited blob can never break a toggle.
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>;
  const resolved = Number(r.recentlyResolved);
  const autoStop = Number(r.autoStopMinutes);
  return {
    piiFlagging: asBool(r.piiFlagging, true),
    clientFlagging: asBool(r.clientFlagging, true),
    confirmWrites: asBool(r.confirmWrites, true),
    autoDenyHeavy: asBool(r.autoDenyHeavy, true),
    schemaAccess: asBool(r.schemaAccess, false),
    recentlyResolved: (RECENTLY_RESOLVED_OPTIONS as readonly number[]).includes(resolved)
      ? resolved
      : RECENTLY_RESOLVED_DEFAULT,
    autoStopMinutes: (AUTO_STOP_OPTIONS as readonly number[]).includes(autoStop) ? autoStop : 0,
  };
}

// Apply the host-side display preferences to a fresh annotation; each axis blanks only
// its own set. Never mutates the input.
// Naming the tables and columns a query reads is how a human reads that query, not a
// preference, so it is unconditional since the 2026-09-21 decision and no longer has a
// setting. A schemaAnnotation:false left in an older stored blob is ignored, not migrated.
export function filterSchema(schema: SchemaContext | null, s: Settings): SchemaContext | null {
  if (!schema) {
    return null;
  }
  return {
    tables: schema.tables,
    pii: s.piiFlagging ? schema.pii : [],
    client: s.clientFlagging ? schema.client : [],
    complete: schema.complete,
  };
}

const STORE_KEY = "gatekeeper.settings.v1";
type Store = Record<string, Settings>;

// One versioned blob for every connection (keyed by connectionName) in the plugin's
// persistent store. Loaded per connection; each toggle rewrites the whole blob.
export class SettingsStore {
  private all: Store = {};
  private connectionName = "";
  private current: Settings = defaultSettings();
  private loadedFor: string | null = null;
  private loads = 0;

  async load(connectionName: string): Promise<Settings> {
    const load = ++this.loads;
    this.connectionName = connectionName;
    this.loadedFor = null;
    let all: Store;
    try {
      all = (await appStorage.getItem<Store>(STORE_KEY)) ?? {};
    } catch {
      all = {};
    }
    // Only the latest load applies; an older one, even for the same connection, is stale.
    if (load !== this.loads) return this.current;
    this.all = all;
    this.current = normalizeSettings(all[connectionName]);
    this.loadedFor = connectionName;
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  // Until then get() may still hold the previous connection's preferences.
  loadedForConnection(connectionName: string): boolean {
    return this.loadedFor === connectionName;
  }

  async set(patch: Record<string, boolean | number>): Promise<Settings> {
    this.current = normalizeSettings({ ...this.current, ...patch });
    // Re-read before writing so a connection switch between writes cannot clobber
    // another connection's just-saved preferences; we only ever replace our own key.
    try {
      this.all = (await appStorage.getItem<Store>(STORE_KEY)) ?? this.all;
      this.all[this.connectionName] = this.current;
      await appStorage.setItem(STORE_KEY, this.all);
    } catch {
      this.all[this.connectionName] = this.current;
    }
    return this.current;
  }

  // Restore this connection's settings to their defaults, persisting the same way set() does.
  async reset(): Promise<Settings> {
    this.current = defaultSettings();
    try {
      this.all = (await appStorage.getItem<Store>(STORE_KEY)) ?? this.all;
      this.all[this.connectionName] = this.current;
      await appStorage.setItem(STORE_KEY, this.all);
    } catch {
      this.all[this.connectionName] = this.current;
    }
    return this.current;
  }
}
