#!/usr/bin/env node
// Dev-only MCP launcher: kills every other Gatekeeper server, then execs the
// local code. Multiple builds sharing ~/.gatekeeper/requests.db corrupt it, so
// dev must be the sole server. Never shipped: packages/server publishes only dist.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const serverEntry = join(root, "packages", "server", watch ? "src/index.ts" : "dist/index.js");
const serverRequire = createRequire(join(root, "packages", "server", "package.json"));
const args = watch
  ? [serverRequire.resolve("tsx/cli"), "watch", "--clear-screen=false", serverEntry]
  : [serverEntry];
const port = Number(process.env.GATEKEEPER_BROKER_PORT ?? 9999);
const listOnly = process.argv.includes("--list");

// Match the watcher too, otherwise it could restart a server after takeover.
// Requiring node avoids matching a stray shell command.
function findServers() {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error("Cannot list Gatekeeper processes. No servers stopped.");
  const out = result.stdout || "";
  const hits = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === process.pid || pid === process.ppid) continue;
    if (!/\bnode\b/.test(cmd)) continue;
    const isServer =
      /gatekeeper[^\s]*[/\\]server[/\\](?:dist[/\\]index\.js|src[/\\]index\.ts)/.test(cmd) ||
      /gatekeeper-mcp-server/.test(cmd);
    if (isServer) hits.push({ pid, cmd });
  }
  return hits;
}

function killOthers() {
  for (const { pid, cmd } of findServers()) {
    try {
      process.kill(pid, "SIGTERM");
      console.error(`[gatekeeper-dev] killed ${pid}: ${cmd}`);
    } catch (err) {
      console.error(`[gatekeeper-dev] could not kill ${pid}: ${err.message}`);
    }
  }
}

// Refused connection = port free; a successful connect = still held.
function portFree() {
  return new Promise((res) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    sock.setTimeout(300);
    sock.once("connect", () => {
      sock.destroy();
      res(false);
    });
    sock.once("timeout", () => {
      sock.destroy();
      res(false);
    });
    sock.once("error", (error) => res(error.code === "ECONNREFUSED"));
  });
}

async function waitPortFree(capMs) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (await portFree()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Broker port ${port} is still occupied. No replacement server started.`);
}

if (listOnly) {
  const hits = findServers();
  console.error(hits.length ? "[gatekeeper-dev] would kill:" : "[gatekeeper-dev] nothing to kill");
  for (const { pid, cmd } of hits) console.error(`  ${pid}: ${cmd}`);
  process.exit(0);
}

// Precondition before any side effect: never kill everything then die on a
// missing entrypoint.
if (!existsSync(serverEntry)) {
  console.error(`[gatekeeper-dev] ${serverEntry} is missing. No servers killed.`);
  process.exit(1);
}

killOthers();
await waitPortFree(2000);

const child = spawn(process.execPath, args, { stdio: "inherit" });
const forward = (sig) => {
  try {
    child.kill(sig);
  } catch {}
};
process.on("SIGTERM", forward);
process.on("SIGINT", forward);
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
