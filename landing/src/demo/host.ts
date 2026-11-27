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
import { catalogRows } from "../../../packages/plugin/src/sql/pg/catalog-fixture";
import type { PgReadPlan } from "../../../packages/plugin/src/sql/pg/plan";
import {
  planRead,
  readMetadataSql,
  readSearchPathSql,
} from "../../../packages/plugin/src/sql/read-analysis";
import { installBroker } from "./broker";
import { ARRIVALS, CONNECTION, TABLES, ticketRows, WAITING } from "./scenario";

// Stands in for @beekeeperstudio/plugin in the landing build (astro.config.mjs aliases the
// package here), as the plugin's fixture preview does: everything answers from memory, nothing
// reaches a parent window, the network or a real database.
installBroker();

const store = new Map<string, unknown>([
  // Paired, and a TypeSafe key saved, so the replay can turn Auto mode on through its own toggle.
  ["enc:gatekeeper.token", "demo-token"],
  ["enc:gatekeeper.typesafe-key", "demo-key"],
]);

export const appStorage = {
  async getItem<T = unknown>(key: string, options?: { encrypted: boolean }): Promise<T | null> {
    return (store.get(`${options?.encrypted ? "enc:" : ""}${key}`) as T | undefined) ?? null;
  },
  async setItem<T = unknown>(key: string, value: T, options?: { encrypted: boolean }) {
    store.set(`${options?.encrypted ? "enc:" : ""}${key}`, value);
  },
};

export const broadcast = {
  post<T extends JsonValue = JsonValue>(_message: T): void {},
  on<T extends JsonValue = JsonValue>(_handler: (message: T) => void): void {},
};

export const log = {
  error(_err: string | Error): void {},
};

export const clipboard = {
  async writeText(text: string): Promise<void> {
    await navigator.clipboard?.writeText(text).catch(() => {});
  },
  async readText(): Promise<string> {
    return "";
  },
  async writeImage(_data: string): Promise<void> {},
};

export async function requestFileSave(_options: { fileName?: string }): Promise<void> {}
// The plugin's own links (star the repo, send feedback) open as they would from Beekeeper.
export async function openExternal(link: string): Promise<void> {
  if (/^https:\/\//.test(link)) window.open(link, "_blank", "noopener");
}
export async function setTabTitle(_title: string): Promise<void> {}

export async function getAppInfo(): Promise<AppInfo> {
  return { version: "5.5.0", theme: { palette: {}, cssString: "", type: "dark" } };
}

export function addNotificationListener(_name: string, _handler: (...args: unknown[]) => void) {}

export async function getConnectionInfo(): Promise<ConnectionInfo> {
  return CONNECTION as unknown as ConnectionInfo;
}

export async function getColumns(table: string): Promise<Column[]> {
  return Object.entries(TABLES[table] ?? {}).map(([name, type]) => ({ name, type }));
}

export async function getSchemas(): Promise<string[]> {
  return ["public"];
}

export async function getTables(): Promise<Table[]> {
  return Object.keys(TABLES).map((name) => ({ name, schema: "public" }));
}

export async function getPrimaryKeys(): Promise<PrimaryKey[]> {
  return [{ columnName: "id", position: 0 }];
}

export async function getOutgoingKeys(): Promise<TableKey[]> {
  return [];
}

export async function getTableIndexes(): Promise<TableIndex[]> {
  return [];
}

const result = (rows: Record<string, unknown>[]): RunQueryResult => ({
  results: [{ rows, fields: Object.keys(rows[0] ?? {}).map((name) => ({ id: name, name })) }],
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The catalog answers for each read Auto mode may evaluate, from the plugin's own test catalog,
// keyed by the exact metadata SQL the analysis sends. Built on first use: planning needs the
// grammar, which loads after this module.
let catalog: Map<string, Record<string, unknown>[]> | undefined;
function catalogAnswers(): Map<string, Record<string, unknown>[]> {
  if (catalog) return catalog;
  catalog = new Map();
  for (const read of ARRIVALS) {
    const plan = planRead(read.sql, "postgresql") as PgReadPlan | string;
    if (typeof plan === "string") continue;
    const relations = Object.fromEntries(
      plan.relations.map((r) => [`${r.schema}.${r.table}`, TABLES[r.table] ?? {}]),
    );
    catalog.set(readMetadataSql(plan), catalogRows(plan, relations));
  }
  return catalog;
}

export async function runQuery(sql: string): Promise<RunQueryResult> {
  const text = sql.replace(/^\/\*.*?\*\/\s*/s, "");
  const catalog = catalogAnswers();
  if (text === readSearchPathSql()) {
    await wait(120);
    return result([{ path: JSON.stringify(["pg_catalog", "public"]) }]);
  }
  const meta = catalog.get(text);
  if (meta) {
    await wait(260);
    return result(meta);
  }
  if (text.includes("pg_is_in_recovery")) {
    return result([{ replica: false, session_read_only: false, version: "PostgreSQL 16.4" }]);
  }
  const read = ARRIVALS.find((r) => r.sql === text);
  if (read) {
    await wait(650);
    return result(read.rows());
  }
  if (text === WAITING.openTickets) {
    await wait(650);
    return result(ticketRows());
  }
  return { results: [], error: { message: "Not available in the replay" } };
}
