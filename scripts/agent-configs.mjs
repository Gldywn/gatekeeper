// The agents' user-level gatekeeper MCP entries, which dev:link points at a checkout's build and
// dev:unlink puts back. Sessions inside a checkout already run its build through the project
// config (.mcp.json, opencode.jsonc), which outranks these entries.

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { checkoutOf } from "./servers.mjs";

export function runCli(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  const err = (r.error?.message || r.stderr || r.stdout || "").trim().split("\n")[0];
  return { ok: r.status === 0, err };
}

// Backup and config values round-trip through JSON, so compare them in that form.
const same = (a, b) =>
  isDeepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));

function writeAtomic(path, text, mode) {
  const tmp = `${path}.dev-link-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

const claudeEntry = (path) => JSON.parse(readFileSync(path, "utf8")).mcpServers?.gatekeeper;

// `claude mcp` rather than a file edit: running sessions rewrite ~/.claude.json themselves. A
// failure that changed the entry says what it left (`left`), so the backup tracks only our writes.
function setClaude(ctx, { path, entry }, next, exact) {
  const cli = (...args) => ctx.run("claude", ["mcp", ...args, "--scope", "user"]);
  if (entry) {
    const removed = cli("remove", "gatekeeper");
    if (!removed.ok) throw new Error(`claude mcp remove failed: ${removed.err}`);
  }
  const added = cli("add-json", "gatekeeper", JSON.stringify(next));
  if (!added.ok) {
    const back = entry && cli("add-json", "gatekeeper", JSON.stringify(entry)).ok;
    const err = new Error(
      `claude mcp add-json failed: ${added.err}${back ? "; the previous entry is back" : ""}`,
    );
    throw entry && !back ? Object.assign(err, { left: undefined }) : err;
  }
  let now;
  try {
    now = claudeEntry(path);
  } catch (err) {
    // add-json said it stored `next`: take its word, unlink's conflict check covers the rest.
    throw Object.assign(new Error(`could not read ${path} back: ${err.message}`), { left: next });
  }
  const stored = exact
    ? same(now, next)
    : now?.command === next.command && same(now?.args, next.args);
  if (!stored)
    throw Object.assign(
      new Error(
        "claude mcp stored another entry than asked; compare `claude mcp get gatekeeper` with ~/.gatekeeper/dev-link.json",
      ),
      { left: now },
    );
  return now;
}

const claude = {
  name: "Claude Code",
  load(ctx) {
    // Claude Code keeps its config elsewhere then; guessing where would edit the wrong file.
    if (ctx.env.CLAUDE_CONFIG_DIR) return { skip: "CLAUDE_CONFIG_DIR is set, switch it by hand" };
    const path = join(ctx.home, ".claude.json");
    if (!existsSync(path)) return { skip: "not configured" };
    return { path, entry: claudeEntry(path) };
  },
  original: ({ entry }) => entry,
  swap: (ctx, loaded, command, args) =>
    setClaude(ctx, loaded, { ...loaded.entry, command, args }, false),
  restore: (ctx, loaded, record) => setClaude(ctx, loaded, record.original, true),
};

const TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:gatekeeper|"gatekeeper"|'gatekeeper')\s*\]/;

// Only the [mcp_servers.gatekeeper] table's own lines: a subtable (.env...) opens with its own
// header, so a `command` key inside it is never matched.
function keyLines(lines) {
  const at = {};
  const start = lines.findIndex((l) => TABLE.test(l));
  if (start < 0) return at;
  for (let i = start + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
    const key = lines[i].match(/^\s*(command|args)\s*=/)?.[1];
    if (key) at[key] = i;
  }
  return at;
}

// The line search cannot see TOML context (a multiline string, a multiline array), so the result
// is proven by parsing: it must read as the original with only command and args changed.
function editToml(text, lineFor) {
  const lines = text.split(/(?<=\n)/);
  const at = keyLines(lines);
  if (at.command === undefined || at.args === undefined)
    throw new Error("no command and args lines under [mcp_servers.gatekeeper]; switch it by hand");
  const fresh = {};
  for (const key of ["command", "args"]) {
    const old = lines[at[key]];
    fresh[key] = lineFor(key, old.replace(/\r?\n$/, ""));
    lines[at[key]] = fresh[key] + (old.match(/\r?\n$/)?.[0] ?? "");
  }
  const next = lines.join("");
  const expected = parse(text);
  Object.assign(expected.mcp_servers.gatekeeper, parse(`${fresh.command}\n${fresh.args}`));
  let actual;
  try {
    actual = parse(next);
  } catch {}
  if (!isDeepStrictEqual(actual, expected))
    throw new Error("config.toml has a shape dev:link cannot edit safely; switch it by hand");
  return next;
}

function setToml(loaded, lineFor) {
  const next = editToml(loaded.text, lineFor);
  if (readFileSync(loaded.path, "utf8") !== loaded.text)
    throw new Error(`${loaded.path} changed while being edited; re-run`);
  writeAtomic(loaded.path, next, statSync(loaded.path).mode & 0o777);
  return parse(next).mcp_servers.gatekeeper;
}

const codex = {
  name: "Codex",
  load(ctx, recorded) {
    const file = recorded ?? join(ctx.env.CODEX_HOME || join(ctx.home, ".codex"), "config.toml");
    if (!existsSync(file)) return { skip: "not configured" };
    // A symlinked config (dotfiles) is edited through its link, never replaced by a plain file.
    const path = realpathSync(file);
    const text = readFileSync(path, "utf8");
    return { path, text, entry: parse(text).mcp_servers?.gatekeeper };
  },
  original({ text }) {
    const lines = text.split(/\r?\n/);
    const at = keyLines(lines);
    return { command: lines[at.command], args: lines[at.args] };
  },
  swap: (_ctx, loaded, command, args) =>
    setToml(loaded, (key, old) => {
      const value = JSON.stringify(key === "command" ? command : args);
      return `${old.match(/^[ \t]*/)[0]}${key} = ${value}`;
    }),
  restore: (_ctx, loaded, record) => setToml(loaded, (key) => record.original[key]),
};

const CLIENTS = { claude, codex };

// One lock for link and unlink together: two runs racing on the backup could record a dev entry
// as the original and lose the published one.
function withBackup(ctx, fn) {
  const dir = join(ctx.home, ".gatekeeper");
  const file = join(dir, "dev-link.json");
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  if (ctx.dry) return fn(read(), () => {});
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "dev-link.lock");
  try {
    closeSync(openSync(lock, "wx"));
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    throw new Error(`${lock} exists: another dev:link/unlink is running, or delete it`);
  }
  try {
    const backup = read();
    // Entries can carry env secrets, hence owner-only.
    const save = () =>
      Object.keys(backup).length
        ? writeAtomic(file, `${JSON.stringify(backup, null, 2)}\n`, 0o600)
        : rmSync(file, { force: true });
    return fn(backup, save);
  } finally {
    rmSync(lock, { force: true });
  }
}

export function switchAgents(command, args, ctx) {
  return withBackup(ctx, (backup, save) => {
    let ok = true;
    for (const [key, client] of Object.entries(CLIENTS)) {
      try {
        const loaded = client.load(ctx);
        if (loaded.skip) {
          ctx.log(`· ${client.name}: ${loaded.skip}`);
          continue;
        }
        if (!loaded.entry) {
          ctx.log(`· ${client.name}: no gatekeeper entry in ${loaded.path}, left as is`);
          continue;
        }
        if (typeof loaded.entry.command !== "string")
          throw new Error("gatekeeper is not a local command entry; switch it by hand");
        // The backup holds one original per client: a second file has nowhere to keep its own.
        if (backup[key] && backup[key].path !== loaded.path)
          throw new Error(`linked earlier through ${backup[key].path}; run pnpm dev:unlink first`);
        if (loaded.entry.command === command && same(loaded.entry.args, args)) {
          ctx.log(`· ${client.name}: already runs ${args[0]}`);
          continue;
        }
        if (ctx.dry) {
          ctx.log(`· would point ${client.name} (${loaded.path}) at ${args[0]}`);
          continue;
        }
        const fresh = !backup[key];
        if (fresh) {
          backup[key] = { path: loaded.path, original: client.original(loaded) };
          save();
        }
        try {
          backup[key].written = client.swap(ctx, loaded, command, args);
        } catch (err) {
          if ("left" in err) backup[key].written = err.left;
          else if (fresh) delete backup[key];
          save();
          throw err;
        }
        save();
        ctx.log(`· pointed ${client.name} (${loaded.path}) at ${args[0]}`);
      } catch (err) {
        ok = false;
        ctx.log(`✗ ${client.name}: ${err.message}`);
      }
    }
    ctx.log(`· OpenCode: ${opencode(ctx)}`);
    return ok;
  });
}

export function restoreAgents(ctx) {
  return withBackup(ctx, (backup, save) => {
    let ok = true;
    if (!Object.keys(backup).length) ctx.log("· agents: no dev:link backup, entries left as is");
    for (const [key, record] of Object.entries(backup)) {
      const client = CLIENTS[key];
      try {
        const loaded = client.load(ctx, record.path);
        if (loaded.skip || !same(loaded.entry, record.written)) {
          ok = false;
          ctx.log(
            `! ${client.name}: entry changed since dev:link, left as is; its original stays in ~/.gatekeeper/dev-link.json`,
          );
          continue;
        }
        if (ctx.dry) {
          ctx.log(`· would restore ${client.name}'s gatekeeper entry (${record.path})`);
          continue;
        }
        try {
          client.restore(ctx, loaded, record);
        } catch (err) {
          if ("left" in err) {
            record.written = err.left;
            save();
          }
          throw err;
        }
        delete backup[key];
        save();
        ctx.log(`· restored ${client.name}'s gatekeeper entry (${record.path})`);
      } catch (err) {
        ok = false;
        ctx.log(`✗ ${client.name}: ${err.message}`);
      }
    }
    return ok;
  });
}

// OpenCode is reported, not switched: its global config is JSONC and nothing here edits JSONC
// without losing comments. Text search only, so a comment counts as a mention.
function opencode(ctx) {
  const dir = join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, ".config"), "opencode");
  const files = ["config.json", "opencode.json", "opencode.jsonc"]
    .map((f) => join(dir, f))
    .filter((f) => existsSync(f));
  const hit = files.find((f) => readFileSync(f, "utf8").includes('"gatekeeper"'));
  if (hit) return `${hit} mentions gatekeeper; dev:link does not switch OpenCode, edit it by hand`;
  return files.length ? "no global gatekeeper entry" : "not configured";
}

// Where an entry points, without printing env or the full argv (either can carry secrets).
export function describeEntry(entry) {
  const words = [entry.command, ...(entry.args ?? [])].filter((w) => typeof w === "string");
  const build = words.map(checkoutOf).find(Boolean);
  if (build) {
    const gone = existsSync(join(build, "packages", "server", "dist", "index.js"))
      ? ""
      : " ✗ BUILD GONE";
    return { root: resolve(build), label: `checkout ${build}${gone}` };
  }
  const published = words.find((w) => w.includes("gatekeeper-mcp-server"));
  return { root: null, label: published ? `published ${published}` : "another command" };
}

export function describeAgents(ctx) {
  const rows = Object.values(CLIENTS).map((client) => {
    try {
      const loaded = client.load(ctx);
      if (loaded.skip) return { name: client.name, note: loaded.skip };
      if (!loaded.entry) return { name: client.name, note: `no gatekeeper entry (${loaded.path})` };
      return { name: client.name, path: loaded.path, ...describeEntry(loaded.entry) };
    } catch (err) {
      return { name: client.name, note: `unreadable: ${err.message}` };
    }
  });
  rows.push({ name: "OpenCode", note: opencode(ctx) });
  return rows;
}
