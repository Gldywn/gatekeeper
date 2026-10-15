import type { BuildIdentity } from "@gatekeeper/shared";

// The plugin's only request beyond loopback (SECURITY.md, Network): release metadata,
// never an asset, and nothing is ever installed from it.
export const LATEST_RELEASE_URL = "https://api.github.com/repos/Gldywn/gatekeeper/releases/latest";
export const SERVER_IDENTITY_HEADER = "X-Gatekeeper-Server";

// Every Gatekeeper version is a plain x.y.z (release-please), dev builds included.
const TRIPLE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

export function compareVersions(a: string, b: string): number {
  const x = TRIPLE.exec(a) ?? [];
  const y = TRIPLE.exec(b) ?? [];
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const field = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;

// The header comes from whatever holds the broker port with our token: anything that is
// not the expected shape reads as unknown, never as a release.
export function parseServerIdentity(raw: string | null): BuildIdentity | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as { version?: unknown; dev?: unknown };
    const version = field(value?.version);
    if (!version || !TRIPLE.test(version)) return null;
    if (value.dev === undefined) return { version };
    const dev = (value.dev && typeof value.dev === "object" ? value.dev : {}) as {
      sha?: unknown;
      branch?: unknown;
    };
    const sha = field(dev.sha);
    const branch = field(dev.branch);
    return { version, dev: { ...(sha && { sha }), ...(branch && { branch }) } };
  } catch {
    return null;
  }
}

export async function fetchLatestRelease(): Promise<string | null> {
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const tag = ((await res.json()) as { tag_name?: unknown }).tag_name;
    const version = typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : "";
    return TRIPLE.test(version) ? version : null;
  } catch {
    return null;
  }
}

export type VersionRow =
  | { kind: "ok"; version: string }
  | { kind: "plain"; version: string }
  | { kind: "dev"; sha?: string; branch?: string }
  | { kind: "unknown" }
  // warn: below the other side (amber); info: only a newer release is out (neutral).
  | { kind: "behind"; version: string; tone: "warn"; peer: string }
  | { kind: "behind"; version: string; tone: "info"; latest: string };

export type VersionDock =
  | { kind: "ok"; version: string }
  | { kind: "dev" }
  | { kind: "mismatch" }
  | { kind: "update"; latest: string }
  | { kind: "unknown" };

export interface VersionStatus {
  plugin: VersionRow;
  server: VersionRow;
  dock: VersionDock;
}

function row(own: string, peer: string | null, latest: string | null): VersionRow {
  if (peer !== null && compareVersions(own, peer) < 0) {
    return { kind: "behind", version: own, tone: "warn", peer };
  }
  if (latest !== null && compareVersions(own, latest) < 0) {
    return { kind: "behind", version: own, tone: "info", latest };
  }
  return { kind: "ok", version: own };
}

// A dev side makes nothing comparable, so no advice at all. A mismatch outranks a newer
// release, which is only news while both sides agree.
export function versionStatus(
  plugin: BuildIdentity,
  server: BuildIdentity | null,
  latest: string | null,
): VersionStatus {
  if (plugin.dev || server?.dev) {
    const side = (b: BuildIdentity): VersionRow =>
      b.dev ? { kind: "dev", ...b.dev } : { kind: "plain", version: b.version };
    return {
      plugin: side(plugin),
      server: server ? side(server) : { kind: "unknown" },
      dock: { kind: "dev" },
    };
  }
  const pluginRow = row(plugin.version, server?.version ?? null, latest);
  const serverRow = server
    ? row(server.version, plugin.version, latest)
    : { kind: "unknown" as const };
  const behind = (tone: "warn" | "info") =>
    [pluginRow, serverRow].some((r) => r.kind === "behind" && r.tone === tone);
  let dock: VersionDock = { kind: "ok", version: plugin.version };
  if (behind("warn")) dock = { kind: "mismatch" };
  else if (behind("info") && latest !== null) dock = { kind: "update", latest };
  else if (serverRow.kind === "unknown") dock = { kind: "unknown" };
  return { plugin: pluginRow, server: serverRow, dock };
}
