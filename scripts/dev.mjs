#!/usr/bin/env node
// Symlinks Beekeeper's plugin slot and the agent skill dir to THIS checkout so a
// rebuild needs no reinstall. A symlink to a checkout that can't load crashes the
// whole Beekeeper plugin manager, so link refuses that. A real install is moved aside,
// never deleted, and unlink puts it back.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeAgents, restoreAgents, runCli, switchAgents } from "./agent-configs.mjs";
import {
  cwdOf,
  findServers,
  identify,
  processes,
  sessionsOf,
  sessionsOnOtherBuilds,
} from "./servers.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const thisRoot = resolve(scriptDir, "..");

const args = process.argv.slice(3);
const cmd = process.argv[2];
const has = (flag) => args.includes(flag);
const dry = has("--dry-run");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const stateDir = () => join(homedir(), ".gatekeeper");

// GATEKEEPER_BK_PLUGINS_DIR is the escape hatch for Linux/Windows and custom
// installs: only the macOS path is verified.
function pluginsDir() {
  const override = process.env.GATEKEEPER_BK_PLUGINS_DIR;
  if (override) return override;
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "beekeeper-studio", "plugins");
  }
  fail(
    `Beekeeper plugins dir unknown on ${platform()}; set GATEKEEPER_BK_PLUGINS_DIR to it and re-run.`,
  );
}

const expandTilde = (p) =>
  p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;

// Skill targets are machine-specific, so they stay out of git but inside the repo:
// a gitignored .dev-skills (one path per line) in the checkout, or GATEKEEPER_SKILLS_DIRS
// to override. Empty = dev.mjs leaves skills untouched. Read directly, no shell needed.
let _skillDirs = null;
function skillDirs() {
  if (_skillDirs) return _skillDirs;
  let raw = process.env.GATEKEEPER_SKILLS_DIRS ?? "";
  if (!raw) {
    try {
      raw = readFileSync(join(thisRoot, ".dev-skills"), "utf8");
    } catch {}
  }
  _skillDirs = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"))
    .map(expandTilde);
  return _skillDirs;
}

const pluginSlot = () => join(pluginsDir(), "gatekeeper");
// Outside plugins/: a copy left inside could be scanned as a second "gatekeeper" plugin.
const pluginBackup = () => join(dirname(pluginsDir()), "gatekeeper-plugin.pre-dev");
const skillBackup = (link) => `${link}.pre-dev`;
const pluginSrc = (root) => join(root, "packages", "plugin");
const pluginDist = (root) => join(pluginSrc(root), "dist", "index.html");
const skillSrc = (root) => join(root, "skills", "gatekeeper");
const serverEntry = (root) => join(root, "packages", "server", "dist", "index.js");
const agentCtx = () => ({ home: homedir(), env: process.env, dry, log: console.log, run: runCli });

// Primary repo = parent of the shared git dir, resolvable from any worktree.
function primaryRoot() {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: thisRoot,
    encoding: "utf8",
  }).trim();
  return dirname(common);
}

// lstat, so a symlink whose target was deleted reads as a symlink (dangling),
// not as absent: that dangling state is the one that crashes Beekeeper.
function inspectLink(link) {
  const st = lstatSync(link, { throwIfNoEntry: false });
  if (!st) return { kind: "absent" };
  if (st.isSymbolicLink()) {
    try {
      // Resolve against the link's own dir: a relative target (e.g. a hub
      // symlink) is meaningless from our cwd.
      return { kind: "symlink", target: resolve(dirname(link), readlinkSync(link)) };
    } catch {
      return { kind: "symlink", target: null };
    }
  }
  if (st.isDirectory()) return { kind: "realdir" };
  return { kind: "other" };
}

function linkOne(label, src, link, bak) {
  if (!existsSync(src)) fail(`${label} source missing: ${src}`);
  const info = inspectLink(link);
  if (info.kind === "other") fail(`${link} exists and is not our symlink; refusing to touch it.`);
  if (info.kind === "realdir") {
    if (existsSync(bak))
      fail(`${link} is a real folder and ${bak} already exists; resolve by hand.`);
    if (dry) {
      console.log(`· would stash real ${label} ${link} -> ${bak}, then link -> ${src}`);
      return;
    }
    renameSync(link, bak);
    console.log(`· stashed real ${label} -> ${bak}`);
  }
  if (dry) {
    console.log(`· would link ${link} -> ${src}`);
    return;
  }
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(src, link);
  console.log(`· linked ${link} -> ${src}`);
}

function unlinkOne(label, link, bak) {
  const info = inspectLink(link);
  if (info.kind === "symlink") {
    if (dry) console.log(`· would remove ${label} symlink ${link}`);
    else {
      rmSync(link, { force: true });
      console.log(`· removed ${label} symlink ${link}`);
    }
  } else if (info.kind === "absent") {
    console.log(`· ${label}: no dev symlink`);
  } else {
    console.log(
      `· ${label}: ${info.kind === "realdir" ? "real install" : "unexpected entry"} in place, left as is`,
    );
    return;
  }
  if (existsSync(bak)) {
    if (dry) console.log(`· would restore ${bak} -> ${link}`);
    else {
      renameSync(bak, link);
      console.log(`· restored real ${label} -> ${link}`);
    }
  }
}

// A live broker holds the token in memory, so a reset only bites after it restarts.
function brokerAlive(port = Number(process.env.GATEKEEPER_BROKER_PORT ?? 9999)) {
  return new Promise((res) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (up) => {
      sock.destroy();
      res(up);
    };
    sock.setTimeout(400);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// Answers "which server is the plugin talking to". Each read is a separate snapshot, so a
// process that exits in between just leaves a field as "?".
function portOwner(port) {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  const pid = run("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"]).split("\n")[0];
  if (!pid) return null;
  const cwd = run("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"])
    .split("\n")
    .find((l) => l.startsWith("n"));
  return {
    pid,
    command: run("ps", ["-o", "command=", "-p", pid]) || "?",
    cwd: cwd?.slice(1) || "?",
  };
}

function build(root) {
  console.log("· building (pnpm build)…");
  const r = spawnSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) fail("build failed; not touching any symlink.");
}

function link() {
  if (!dry && !has("--no-build")) build(thisRoot);
  for (const built of [pluginDist(thisRoot), serverEntry(thisRoot)]) {
    if (!existsSync(built)) fail(`${built} is missing; build first (pnpm build).`);
  }
  linkOne("plugin", pluginSrc(thisRoot), pluginSlot(), pluginBackup());
  for (const dir of skillDirs())
    linkOne(
      "skill",
      skillSrc(thisRoot),
      join(dir, "gatekeeper"),
      skillBackup(join(dir, "gatekeeper")),
    );
  let switched;
  try {
    switched = switchAgents(process.execPath, [serverEntry(thisRoot)], agentCtx());
  } catch (err) {
    fail(err.message);
  }
  if (!switched) fail("an agent entry was not switched (see above): fix it and re-run.");
  // Published servers die below, but a dev launcher keeps the port whatever link does.
  const owner = portOwner(Number(process.env.GATEKEEPER_BROKER_PORT ?? 9999));
  const holder = owner && identify(owner.command, owner.cwd);
  if (holder?.label.startsWith("dev launcher") && holder.root !== thisRoot)
    console.log(`! pnpm dev of ${holder.root} holds the broker port: stop it to test this one.`);
  const list = stopServers({ published: true });
  const others = sessionsOnOtherBuilds(list, thisRoot, cwdOf);
  if (others.length) {
    console.log(
      "  Sessions on another checkout's build, likely from an earlier dev:link, to restart:",
    );
    for (const s of others) console.log(`  · ${s.harness} pid ${s.pid} in ${s.cwd}`);
  }
  console.log(`\n✓ Gatekeeper dev target: ${thisRoot}`);
  console.log("  Restart Beekeeper, then the agent sessions listed above.");
  console.log(
    "  To keep the broker on this checkout, run pnpm dev here before restarting them: it stops every other Gatekeeper server. Check with pnpm dev:status.",
  );
}

// Old servers keep the broker port, so the plugin would keep talking to them: link stops the
// published ones, unlink the repo builds. The sessions are read first: a stopped server has no
// parent left to read.
function stopServers({ published }) {
  const label = published ? "published server" : "dev server";
  let list;
  try {
    list = processes();
  } catch (err) {
    fail(err.message);
  }
  const servers = findServers({ published: true }, list).filter((s) => s.published === published);
  const sessions = sessionsOf(servers, list);
  for (const { pid } of servers) {
    if (dry) {
      console.log(`· would stop ${label} ${pid}`);
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      console.log(`· stopped ${label} ${pid}`);
    } catch (err) {
      console.log(`· could not stop ${label} ${pid}: ${err.message}`);
    }
  }
  if (sessions.length)
    console.log(
      "  Agent sessions that lose their Gatekeeper tools, to restart (claude --continue, codex resume):",
    );
  for (const s of sessions) {
    console.log(
      s.harness
        ? `  · ${s.harness} pid ${s.pid} in ${cwdOf(s.pid) || "?"}`
        : `  · server ${s.pid}: no agent session found above it`,
    );
  }
  return list;
}

function unlink() {
  unlinkOne("plugin", pluginSlot(), pluginBackup());
  for (const dir of skillDirs())
    unlinkOne("skill", join(dir, "gatekeeper"), skillBackup(join(dir, "gatekeeper")));
  let restored;
  try {
    restored = restoreAgents(agentCtx());
  } catch (err) {
    fail(err.message);
  }
  stopServers({ published: false });
  if (!restored) {
    process.exitCode = 1;
    console.log("\n✗ Some agent entries were not restored (see above); the rest is undone.");
  } else console.log("\n✓ Dev links removed. Restart Beekeeper and the agent sessions.");
  console.log(
    "  A slot with no stashed copy stays empty: re-install from published (Plugin Manager / npx skills add).",
  );
}

function describeTarget(target, primary, kind) {
  if (!existsSync(target)) {
    return kind === "plugin"
      ? `→ ${target}  ✗ TARGET GONE (would crash the plugin manager)`
      : `→ ${target}  ✗ TARGET GONE (broken symlink)`;
  }
  if (kind === "plugin" && !existsSync(join(target, "dist", "index.html"))) {
    return `→ ${target}  ✗ NOT BUILT (run pnpm build)`;
  }
  const mine = kind === "plugin" ? pluginSrc(thisRoot) : skillSrc(thisRoot);
  const theirs = kind === "plugin" ? pluginSrc(primary) : skillSrc(primary);
  const owner =
    target === mine ? "this checkout" : target === theirs ? "primary" : "another checkout";
  return `→ ${target}  (${owner})`;
}

function printSlot(info, primary, kind) {
  if (info.kind === "absent") console.log("  → absent (no dev link)");
  else if (info.kind === "realdir") console.log("  → real install (a normal folder)");
  else if (info.kind === "other") console.log("  → unexpected entry (not ours)");
  else if (!info.target) console.log("  → symlink (unreadable)");
  else console.log(`  ${describeTarget(info.target, primary, kind)}`);
}

async function status() {
  const primary = primaryRoot();
  console.log(`this checkout : ${thisRoot}${primary === thisRoot ? " (primary)" : ""}`);
  console.log(`primary repo  : ${primary}`);

  console.log(`\nplugin slot: ${pluginSlot()}`);
  const plugin = inspectLink(pluginSlot());
  printSlot(plugin, primary, "plugin");
  if (existsSync(pluginBackup())) console.log(`  stashed real folder: ${pluginBackup()}`);
  // Everything that serves the plugin should come from the checkout it runs, or none at all.
  const pluginRoot =
    plugin.kind === "symlink" && plugin.target ? resolve(plugin.target, "../..") : null;
  const expected = pluginRoot ? `the plugin's checkout ${pluginRoot}` : "a published server";
  const mismatches = [];

  for (const dir of skillDirs()) {
    const link = join(dir, "gatekeeper");
    console.log(`\nskill slot: ${link}`);
    printSlot(inspectLink(link), primary, "skill");
    if (existsSync(skillBackup(link))) console.log(`  stashed real folder: ${skillBackup(link)}`);
  }

  console.log("\nagents' user-level gatekeeper entry:");
  for (const row of describeAgents(agentCtx())) {
    console.log(
      `  ${row.name.padEnd(11)} : ${row.label ? `${row.label} (${row.path})` : row.note}`,
    );
    if (row.label && row.root !== pluginRoot)
      mismatches.push(`${row.name} runs ${row.label}, not ${expected}`);
  }
  if (existsSync(join(stateDir(), "dev-link.json")))
    console.log("  originals kept in ~/.gatekeeper/dev-link.json until dev:unlink");

  const port = Number(process.env.GATEKEEPER_BROKER_PORT ?? 9999);
  // Held, not healthy: the dev launcher keeps the port even while its server restarts.
  const held = await brokerAlive(port);
  console.log(`\nbroker port 127.0.0.1:${port} : ${held ? "held" : "free"}`);
  const owner = held && portOwner(port);
  if (owner) console.log(`  by pid ${owner.pid}: ${owner.command} (cwd ${owner.cwd})`);
  else if (held) console.log("  by an unknown process (no lsof, or it exited meanwhile)");
  const holder = owner && identify(owner.command, owner.cwd);
  if (holder) {
    console.log(`  runs ${holder.label}`);
    if (holder.root !== pluginRoot)
      mismatches.push(`the broker runs ${holder.root ?? holder.label}, not ${expected}`);
  } else if (held && pluginRoot) {
    mismatches.push(`the broker holder could not be identified as ${expected}`);
  }
  console.log(
    `~/.gatekeeper/broker-token : ${existsSync(join(stateDir(), "broker-token")) ? "present" : "absent"}`,
  );
  console.log(
    `~/.gatekeeper/requests.db  : ${existsSync(join(stateDir(), "requests.db")) ? "present" : "absent"}`,
  );
  for (const m of mismatches) console.log(`! ${m}`);
}

async function reset() {
  const all = has("--all");
  const targets = [
    "broker-token",
    ...(all ? ["requests.db", "requests.db-wal", "requests.db-shm"] : []),
  ];
  if (await brokerAlive()) {
    console.log(
      "! broker is live: it holds the token in memory, so this takes effect on its next start.",
    );
  }
  for (const name of targets) {
    const path = join(stateDir(), name);
    if (!existsSync(path)) continue;
    if (dry) {
      console.log(`· would remove ${path}`);
      continue;
    }
    rmSync(path, { force: true });
    console.log(`· removed ${path}`);
  }
  console.log(
    all
      ? "\n✓ token and results DB cleared."
      : "\n✓ token cleared; the plugin re-pairs on next start. Use --all to also wipe the DB.",
  );
}

const verbs = { link, unlink, status, reset };
if (!verbs[cmd]) {
  console.error(
    "usage: node scripts/dev.mjs <link|unlink|status|reset> [--dry-run] [--no-build] [--all]",
  );
  process.exit(1);
}
await verbs[cmd]();
