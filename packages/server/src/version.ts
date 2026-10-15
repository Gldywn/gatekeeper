import { readFileSync } from "node:fs";
import type { BuildIdentity } from "@gatekeeper/shared";

const field = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;

// A stamp only proves a release when it matches the package it sits in: a stale dist/ from
// another version, or any doubt at all, reads as dev rather than as a release.
export function readIdentity(pkgText: string, stampText: string | null): BuildIdentity {
  const { version } = JSON.parse(pkgText) as { version: string };
  let stamp: { version?: unknown; dev?: unknown } | null = null;
  try {
    stamp = stampText === null ? null : JSON.parse(stampText);
  } catch {}
  if (!stamp || typeof stamp !== "object" || stamp.version !== version) return { version, dev: {} };
  if (stamp.dev === undefined) return { version };
  const dev = (stamp.dev ?? {}) as { sha?: unknown; branch?: unknown };
  const sha = field(dev.sha);
  const branch = field(dev.branch);
  return { version, dev: { ...(sha && { sha }), ...(branch && { branch }) } };
}

function readOrNull(url: URL): string | null {
  try {
    return readFileSync(url, "utf8");
  } catch {
    return null;
  }
}

const pkgText = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const stamp = readOrNull(new URL("./build.json", import.meta.url));

// build.json is written into dist/ by the build. A server watched from src/ has none, so
// scripts/dev-server.mjs hands it one in the environment, which can only ever say dev.
function fromLauncher(): BuildIdentity {
  const { version, dev } = readIdentity(pkgText, process.env.GATEKEEPER_BUILD_IDENTITY ?? null);
  return { version, dev: dev ?? {} };
}

export const SERVER_IDENTITY = stamp !== null ? readIdentity(pkgText, stamp) : fromLauncher();
