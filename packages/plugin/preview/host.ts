import type {
  AppInfo,
  Column,
  ConnectionInfo,
  JsonValue,
  PrimaryKey,
  RunQueryResult,
  Table,
  TableIndex,
  TableKey,
} from "@beekeeperstudio/plugin";
import { installBroker } from "./broker";
import { COLUMNS, CONNECTION, duplicateRows, SQL, scenario, weekRows } from "./fixtures";

// Stands in for @beekeeperstudio/plugin in the preview build (vite.preview.config.ts aliases
// the package here). Everything answers from memory: nothing is posted to a parent window,
// written to disk or opened outside the page. Every app bootstrap under the preview config
// imports this module first, so the in-memory broker is in place before any of them fetches.
installBroker();

const store = new Map<string, unknown>([
  // A paired tab, so the preview opens on the queue rather than the pairing screen.
  ["enc:gatekeeper.token", "preview-token"],
]);

export const appStorage = {
  async getItem<T = unknown>(key: string, options?: { encrypted: boolean }): Promise<T | null> {
    return (store.get(`${options?.encrypted ? "enc:" : ""}${key}`) as T | undefined) ?? null;
  },
  async setItem<T = unknown>(key: string, value: T, options?: { encrypted: boolean }) {
    store.set(`${options?.encrypted ? "enc:" : ""}${key}`, value);
  },
};

// A single tab: the election hears nobody and promotes this instance after its claim window.
export const broadcast = {
  post<T extends JsonValue = JsonValue>(_message: T): void {},
  on<T extends JsonValue = JsonValue>(_handler: (message: T) => void): void {},
};

export const log = {
  error(err: string | Error): void {
    console.error("[preview host]", err);
  },
};

export const clipboard = {
  async writeText(text: string): Promise<void> {
    console.info("[preview host] clipboard", `${text.length} characters`);
  },
  async readText(): Promise<string> {
    return "";
  },
  async writeImage(_data: string): Promise<void> {},
};

export async function requestFileSave(options: { fileName?: string }): Promise<void> {
  console.info("[preview host] save", options.fileName);
}

export async function openExternal(link: string): Promise<void> {
  console.info("[preview host] open", link);
}

export async function setTabTitle(title: string): Promise<void> {
  document.title = title;
}

export async function getAppInfo(): Promise<AppInfo> {
  return { version: "5.5.0", theme: { palette: {}, cssString: "", type: "dark" } };
}

export function addNotificationListener(_name: string, _handler: (...args: unknown[]) => void) {}

export async function getConnectionInfo(): Promise<ConnectionInfo> {
  return CONNECTION;
}

export async function getColumns(table: string): Promise<Column[]> {
  return COLUMNS[table] ?? [];
}

export async function getSchemas(): Promise<string[]> {
  return ["public"];
}

export async function getTables(): Promise<Table[]> {
  return Object.keys(COLUMNS).map((name) => ({ name, schema: "public" }));
}

export async function getPrimaryKeys(): Promise<PrimaryKey[]> {
  return [{ columnName: "id", position: 0 }];
}

export async function getOutgoingKeys(): Promise<TableKey[]> {
  return [];
}

// Asked only for a table with a large estimate, which the failing catalog reads never give.
export async function getTableIndexes(): Promise<TableIndex[]> {
  return [];
}

const fields = (rows: Record<string, unknown>[]) =>
  Object.keys(rows[0] ?? {}).map((name) => ({ id: name, name }));

// The approved statements of the fixtures run here; the endpoint check gets a primary; every
// other statement (the catalog metadata reads) fails, as on an engine without them.
export async function runQuery(sql: string): Promise<RunQueryResult> {
  await new Promise((r) => setTimeout(r, scenario.delay));
  const text = sql.replace(/^\/\*.*?\*\/\s*/s, "");
  if (text.includes("pg_is_in_recovery")) {
    const rows = [{ replica: false, session_read_only: false, version: "PostgreSQL 16.4" }];
    return { results: [{ rows, fields: fields(rows) }] };
  }
  const known: [string, () => Record<string, unknown>[]][] = [
    [SQL.dup, duplicateRows],
    [SQL.active, weekRows],
    [
      SQL.plans,
      () => [
        { plan: "Business", revenue_eur: 182_400 },
        { plan: "Team", revenue_eur: 96_120 },
        { plan: "Starter", revenue_eur: 31_870 },
      ],
    ],
    [
      SQL.unpaid,
      () =>
        Array.from({ length: 12 }, (_, i) => ({
          invoice_number: `INV-2610-${1100 + i}`,
          amount_eur: 120 + i * 35,
          issued_at: `2026-10-${String(2 + i).padStart(2, "0")}`,
        })),
    ],
  ];
  const hit = known.find(([q]) => q === text);
  if (!hit) {
    return { results: [], error: { message: "Not available in the preview" } };
  }
  const rows = hit[1]();
  return { results: [{ rows, fields: fields(rows) }] };
}
