#!/usr/bin/env node
// Symlinks Beekeeper's plugin slot and the agent skill dir to THIS checkout so a
// rebuild needs no reinstall. A symlink to a checkout that can't load crashes the
// whole Beekeeper plugin manager, so link refuses that and never deletes a real install.

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
const pluginSrc = (root) => join(root, "packages", "plugin");
const pluginDist = (root) => join(pluginSrc(root), "dist", "index.html");
const skillSrc = (root) => join(root, "skills", "gatekeeper");

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

// stashRealDir: for the skill, a real folder at the target is a re-syncable copy,
// so move it aside (…​.pre-dev) and link; the plugin never does this, it refuses.
function linkOne(label, src, link, stashRealDir = false) {
  if (!existsSync(src)) fail(`${label} source missing: ${src}`);
  const info = inspectLink(link);
  if (info.kind === "other") fail(`${link} exists and is not our symlink; refusing to touch it.`);
  if (info.kind === "realdir") {
    if (!stashRealDir) {
      fail(
        `${link} is a real ${label} install (not our symlink); uninstall it normally first, then re-run. Never removed automatically.`,
      );
    }
    const bak = `${link}.pre-dev`;
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

function unlinkOne(label, link) {
  const info = inspectLink(link);
  const bak = `${link}.pre-dev`;
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

function build(root) {
  console.log("· building (pnpm build)…");
  const r = spawnSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) fail("build failed; not touching any symlink.");
}

function link() {
  if (!dry && !has("--no-build")) build(thisRoot);
  if (!existsSync(pluginDist(thisRoot))) {
    fail(
      `${pluginDist(thisRoot)} is missing; build first (pnpm build) so Beekeeper can load the plugin.`,
    );
  }
  linkOne("plugin", pluginSrc(thisRoot), pluginSlot());
  for (const dir of skillDirs())
    linkOne("skill", skillSrc(thisRoot), join(dir, "gatekeeper"), true);
  console.log(`\n✓ Gatekeeper dev target: ${thisRoot}`);
  console.log(
    skillDirs().length
      ? "  Restart Beekeeper (plugin) and the agent session (skill) to pick this up."
      : "  Restart Beekeeper to pick up the plugin.",
  );
}

function unlink() {
  unlinkOne("plugin", pluginSlot());
  for (const dir of skillDirs()) unlinkOne("skill", join(dir, "gatekeeper"));
  console.log("\n✓ Dev symlinks removed. Restart Beekeeper and the agent session.");
  console.log(
    "  Re-install from published to restore (Plugin Manager / npx skills add). MCP config is committed, nothing to undo.",
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
  printSlot(inspectLink(pluginSlot()), primary, "plugin");

  for (const dir of skillDirs()) {
    const link = join(dir, "gatekeeper");
    console.log(`\nskill slot: ${link}`);
    printSlot(inspectLink(link), primary, "skill");
    if (existsSync(`${link}.pre-dev`)) console.log(`  stashed real folder: ${link}.pre-dev`);
  }

  const up = await brokerAlive();
  console.log(`\nbroker 127.0.0.1:9999 : ${up ? "up" : "down"}`);
  console.log(
    `~/.gatekeeper/broker-token : ${existsSync(join(stateDir(), "broker-token")) ? "present" : "absent"}`,
  );
  console.log(
    `~/.gatekeeper/requests.db  : ${existsSync(join(stateDir(), "requests.db")) ? "present" : "absent"}`,
  );
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
