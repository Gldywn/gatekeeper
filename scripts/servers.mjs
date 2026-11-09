// Gatekeeper server processes, for dev-server.mjs's takeover and dev.mjs's link/unlink. The tsx
// watcher matches too, otherwise it could restart a server after takeover.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const REPO_BUILD = /gatekeeper[^\s]*[/\\]server[/\\](?:dist[/\\]index\.js|src[/\\]index\.ts)/;
// opencode.jsonc and .mcp.json (`${CLAUDE_PROJECT_DIR:-.}/...`) start the build by a path relative
// to the checkout the session runs in, spelled with or without `./`.
const RELATIVE_BUILD = /\s(?:\.[/\\])?packages[/\\]server[/\\]dist[/\\]index\.js\b/;
const HARNESSES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

export function cwdOf(pid) {
  const args = ["-a", "-p", String(pid), "-d", "cwd", "-Fn"];
  const out = spawnSync("lsof", args, { encoding: "utf8" }).stdout || "";
  const cwd = out.split("\n").find((l) => l.startsWith("n"));
  return cwd ? cwd.slice(1) : "";
}

// One snapshot, so a server and the session above it are read at the same instant.
export function processes() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error("Cannot list Gatekeeper processes. No servers stopped.");
  const list = [];
  for (const line of (result.stdout || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  return list;
}

export function findServers({ published }, list = processes()) {
  const hits = [];
  for (const { pid, ppid, cmd } of list) {
    // Requiring node avoids matching a stray shell command.
    if (pid === process.pid || pid === process.ppid || !/\bnode\b/.test(cmd)) continue;
    const build =
      REPO_BUILD.test(cmd) || (RELATIVE_BUILD.test(cmd) && /gatekeeper/.test(cwdOf(pid)));
    const release = !build && /gatekeeper-mcp-server/.test(cmd);
    if (build || (published && release)) hits.push({ pid, ppid, cmd, published: release });
  }
  return hits;
}

const harnessOf = (cmd) => HARNESSES[basename(cmd.split(/\s+/)[0])] ?? null;

// The session to restart is the first agent harness above a server: wrappers such as pnpm dlx or a
// shell sit in between. Read before any server is stopped, since a stopped one has no parent left.
export function sessionsOf(servers, list) {
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const sessions = new Map();
  for (const server of servers) {
    const seen = new Set([server.pid]);
    let p = byPid.get(server.ppid);
    while (p && !harnessOf(p.cmd) && !seen.has(p.pid)) {
      seen.add(p.pid);
      p = byPid.get(p.ppid);
    }
    if (p && harnessOf(p.cmd)) {
      if (!sessions.has(p.pid)) sessions.set(p.pid, { harness: harnessOf(p.cmd), pid: p.pid });
    } else sessions.set(`server ${server.pid}`, { harness: null, pid: server.pid });
  }
  return [...sessions.values()];
}

// What a process serving the broker runs, as far as its files on disk tell: a process started
// before a rebuild still runs the older code, so the stamp read here can be newer than it.
export function identify(command, cwd) {
  const words = command.split(/\s+/);
  const launcher = words.find((w) => /scripts[/\\]dev-server\.mjs$/.test(w));
  if (launcher) return { root: resolve(cwd, launcher, "../.."), label: "dev launcher (sources)" };
  const entry = words.find((w) => /dist[/\\]index\.js$/.test(w));
  if (!entry) return null;
  const dist = dirname(resolve(cwd, entry));
  const read = (file) => {
    try {
      return JSON.parse(readFileSync(join(dist, file), "utf8"));
    } catch {
      return null;
    }
  };
  const pkg = read("../package.json");
  const stamp = read("build.json");
  const branch = stamp?.dev?.branch ? ` on ${stamp.dev.branch}` : "";
  const dev = stamp?.dev ? ` dev ${stamp.dev.sha ?? "?"}${branch}` : "";
  return {
    root: checkoutOf(resolve(cwd, entry)),
    label: `${pkg?.name ?? "?"} ${stamp?.version ?? pkg?.version ?? "?"}${dev} (on disk)`,
  };
}

// A checkout build is any .../packages/server/dist/index.js: its root is the checkout.
export function checkoutOf(path) {
  return path.match(/^(.*)[/\\]packages[/\\]server[/\\]dist[/\\]index\.js$/)?.[1] ?? null;
}
