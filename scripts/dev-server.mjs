#!/usr/bin/env node
// Dev broker owner: holds the broker port for its whole life and relays it to the sources
// under tsx watch, so a restart never frees it for another server. Never shipped.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { holdBrokerPort } from "./broker-proxy.mjs";
import { buildIdentity } from "./build-identity.mjs";
import { findServers } from "./servers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(root, "packages", "server", "src", "index.ts");
const serverRequire = createRequire(join(root, "packages", "server", "package.json"));
const args = [serverRequire.resolve("tsx/cli"), "watch", "--clear-screen=false", serverEntry];
const port = Number(process.env.GATEKEEPER_BROKER_PORT ?? 9999);
const listOnly = process.argv.includes("--list");

function killOthers() {
  for (const { pid, cmd } of findServers({ published: true })) {
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
  const hits = findServers({ published: true });
  console.error(hits.length ? "[gatekeeper-dev] would kill:" : "[gatekeeper-dev] nothing to kill");
  for (const { pid, cmd } of hits) console.error(`  ${pid}: ${cmd}`);
  process.exit(0);
}

killOthers();
await waitPortFree(2000);

// Fresh and owner-only (mkdtemp is 0700), so the relay never reaches another program by accident.
const socketDir = mkdtempSync(join(tmpdir(), "gk-dev-"));
const socketPath = join(socketDir, "broker.sock");
process.on("exit", () => rmSync(socketDir, { recursive: true, force: true }));
await holdBrokerPort(port, socketPath);

// A server watched from src/ has no dist/build.json, so it gets the stamp a build would write.
const identity = buildIdentity(
  join(root, "packages", "server"),
  serverRequire("./package.json").version,
  undefined,
);
const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    GATEKEEPER_BUILD_IDENTITY: JSON.stringify(identity),
    GATEKEEPER_BROKER_SOCKET: socketPath,
  },
});
const forward = (sig) => {
  try {
    child.kill(sig);
  } catch {}
};
process.on("SIGTERM", forward);
process.on("SIGINT", forward);
// Exiting with the child releases the port: a launcher left holding it would serve nothing.
child.on("error", (err) => {
  console.error(`[gatekeeper-dev] could not start the server: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
