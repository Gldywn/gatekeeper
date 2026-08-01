import { appStorage } from "@beekeeperstudio/plugin";
import type { SchemaContext } from "./sql/schema";

// Per-connection host-side preferences. Every field defaults on; recentlyResolved is
// how many resolved items the history panel keeps. None of this ever reaches the broker.
export interface Settings {
  piiFlagging: boolean;
  clientFlagging: boolean;
  schemaAnnotation: boolean;
  sensitiveValues: boolean;
  recentlyResolved: number;
}

export const RECENTLY_RESOLVED_OPTIONS = [10, 20, 50] as const;
const RECENTLY_RESOLVED_DEFAULT = 20;

export function defaultSettings(): Settings {
  return {
    piiFlagging: true,
    clientFlagging: true,
    schemaAnnotation: true,
    sensitiveValues: true,
    recentlyResolved: RECENTLY_RESOLVED_DEFAULT,
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
  return {
    piiFlagging: asBool(r.piiFlagging, true),
    clientFlagging: asBool(r.clientFlagging, true),
    schemaAnnotation: asBool(r.schemaAnnotation, true),
    sensitiveValues: asBool(r.sensitiveValues, true),
    recentlyResolved: (RECENTLY_RESOLVED_OPTIONS as readonly number[]).includes(resolved)
      ? resolved
      : RECENTLY_RESOLVED_DEFAULT,
  };
}

// Apply the host-side detection toggles to a fresh annotation. schemaAnnotation off
// drops the whole thing; each axis blanks only its own set. Never mutates the input.
export function filterSchema(schema: SchemaContext | null, s: Settings): SchemaContext | null {
  if (!schema || !s.schemaAnnotation) {
    return null;
  }
  return {
    tables: schema.tables,
    star: schema.star,
    pii: s.piiFlagging ? schema.pii : [],
    client: s.clientFlagging ? schema.client : [],
    literals: s.sensitiveValues ? schema.literals : [],
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

  async load(connectionName: string): Promise<Settings> {
    this.connectionName = connectionName;
    try {
      this.all = (await appStorage.getItem<Store>(STORE_KEY)) ?? {};
    } catch {
      this.all = {};
    }
    this.current = normalizeSettings(this.all[connectionName]);
    return this.current;
  }

  get(): Settings {
    return this.current;
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
}
