// Gatekeeper server processes, for dev-server.mjs's takeover and dev.mjs's unlink. The tsx
// watcher matches too, otherwise it could restart a server after takeover.

import { spawnSync } from "node:child_process";

const REPO_BUILD = /gatekeeper[^\s]*[/\\]server[/\\](?:dist[/\\]index\.js|src[/\\]index\.ts)/;
// opencode.jsonc starts the build by a path relative to the checkout it runs in.
const RELATIVE_BUILD = /\spackages[/\\]server[/\\]dist[/\\]index\.js\b/;

function cwdOf(pid) {
  const args = ["-a", "-p", String(pid), "-d", "cwd", "-Fn"];
  const out = spawnSync("lsof", args, { encoding: "utf8" }).stdout || "";
  const cwd = out.split("\n").find((l) => l.startsWith("n"));
  return cwd ? cwd.slice(1) : "";
}

export function findServers({ published }) {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error("Cannot list Gatekeeper processes. No servers stopped.");
  const hits = [];
  for (const line of (result.stdout || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    // Requiring node avoids matching a stray shell command.
    if (pid === process.pid || pid === process.ppid || !/\bnode\b/.test(cmd)) continue;
    const isServer =
      REPO_BUILD.test(cmd) ||
      (published && /gatekeeper-mcp-server/.test(cmd)) ||
      (RELATIVE_BUILD.test(cmd) && /gatekeeper/.test(cwdOf(pid)));
    if (isServer) hits.push({ pid, cmd });
  }
  return hits;
}
