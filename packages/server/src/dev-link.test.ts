import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS dev script
import { describeEntry, restoreAgents, switchAgents } from "../../../scripts/agent-configs.mjs";
// @ts-expect-error plain JS dev script
import {
  findServers,
  identify,
  sessionsOf,
  sessionsOnOtherBuilds,
} from "../../../scripts/servers.mjs";

type Run = (cmd: string, args: string[]) => { ok: boolean; err: string };

const NODE = "/opt/node/bin/node";
const at = (root: string) => [`${root}/packages/server/dist/index.js`];
const PUBLISHED = {
  type: "stdio",
  command: "/shims/pnpm",
  args: ["--ignore-workspace", "dlx", "@gldywn/gatekeeper-mcp-server@0.3.1"],
  env: { GATEKEEPER_BROKER_PORT: "9999" },
};
const CODEX = [
  'model = "gpt"',
  "",
  "# keep me",
  "[mcp_servers.gatekeeper]",
  'command = "/shims/pnpm" # pinned',
  'args = [ "--ignore-workspace", "dlx", "@gldywn/gatekeeper-mcp-server@0.3.1" ]',
  "startup_timeout_sec = 20",
  "",
  "[mcp_servers.gatekeeper.env]",
  'command = "an env value, not the server"',
  "",
  "[other]",
  "key = 1",
  "",
].join("\r\n");

let home: string;
let codexFile: string;
let logs: string[];
let calls: string[][];

const claudeFile = () => join(home, ".claude.json");
const claudeEntry = () => JSON.parse(readFileSync(claudeFile(), "utf8")).mcpServers.gatekeeper;
const codexEntry = () => parse(readFileSync(codexFile, "utf8")).mcp_servers.gatekeeper;
const backupFile = () => join(home, ".gatekeeper", "dev-link.json");
const backup = () => JSON.parse(readFileSync(backupFile(), "utf8"));

// Stands in for the claude CLI: edits the temp ~/.claude.json as `claude mcp` does. failAdds
// makes that many add-json calls fail first; dropEnv stores entries without their env; garble
// leaves the file unreadable after a successful add-json; removeThenFail saves, then fails.
function claudeCli({
  failAdds = 0,
  failRemove = false,
  removeThenFail = false,
  dropEnv = false,
  garble = false,
} = {}): Run {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    const config = JSON.parse(readFileSync(claudeFile(), "utf8"));
    if (args[1] === "remove") {
      if (failRemove) return { ok: false, err: "nope" };
      delete config.mcpServers.gatekeeper;
      if (removeThenFail) {
        writeFileSync(claudeFile(), JSON.stringify(config));
        return { ok: false, err: "late" };
      }
    }
    if (args[1] === "add-json") {
      if (failAdds-- > 0) return { ok: false, err: "boom" };
      const { env, ...rest } = JSON.parse(args[3]);
      config.mcpServers.gatekeeper = dropEnv ? rest : { ...rest, env };
    }
    writeFileSync(claudeFile(), garble ? "{" : JSON.stringify(config));
    return { ok: true, err: "" };
  };
}

const ctx = (over: Record<string, unknown> = {}) => ({
  home,
  env: {},
  dry: false,
  log: (line: string) => logs.push(line),
  run: claudeCli(),
  ...over,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gk-dev-link-"));
  logs = [];
  calls = [];
  writeFileSync(
    claudeFile(),
    JSON.stringify({
      numStartups: 3,
      mcpServers: { gatekeeper: PUBLISHED, other: { command: "x" } },
    }),
  );
  mkdirSync(join(home, ".codex"));
  codexFile = join(home, ".codex", "config.toml");
  writeFileSync(codexFile, CODEX, { mode: 0o600 });
});

describe("dev:link agent entries", () => {
  it("points both clients at the build, keeping the rest of each entry, and unlink restores them exactly", () => {
    expect(switchAgents(NODE, at("/wt/a"), ctx())).toBe(true);
    expect(claudeEntry()).toEqual({ ...PUBLISHED, command: NODE, args: at("/wt/a") });
    expect(codexEntry()).toMatchObject({
      command: NODE,
      args: at("/wt/a"),
      startup_timeout_sec: 20,
      env: { command: "an env value, not the server" },
    });
    expect(readFileSync(codexFile, "utf8")).toContain("# keep me\r\n[mcp_servers.gatekeeper]\r\n");
    expect(statSync(backupFile()).mode & 0o777).toBe(0o600);
    expect(statSync(codexFile).mode & 0o777).toBe(0o600);

    expect(restoreAgents(ctx())).toBe(true);
    expect(readFileSync(codexFile, "utf8")).toBe(CODEX);
    expect(claudeEntry()).toEqual(PUBLISHED);
    expect(existsSync(backupFile())).toBe(false);
    expect(existsSync(join(home, ".gatekeeper", "dev-link.lock"))).toBe(false);
  });

  it("keeps the published original through a second link from another checkout", () => {
    switchAgents(NODE, at("/wt/a"), ctx());
    switchAgents(NODE, at("/wt/b"), ctx());
    expect(codexEntry().args).toEqual(at("/wt/b"));
    expect(backup().claude.original).toEqual(PUBLISHED);
    restoreAgents(ctx());
    expect(readFileSync(codexFile, "utf8")).toBe(CODEX);
    expect(claudeEntry()).toEqual(PUBLISHED);
  });

  it("reports a client with no config or no entry and creates nothing", () => {
    writeFileSync(claudeFile(), JSON.stringify({ mcpServers: {} }));
    const unset = ctx({ env: { CODEX_HOME: join(home, "nowhere") } });
    expect(switchAgents(NODE, at("/wt/a"), unset)).toBe(true);
    expect(calls).toEqual([]);
    expect(existsSync(backupFile())).toBe(false);
    expect(logs.join("\n")).toMatch(/Claude Code: no gatekeeper entry.*\n.*Codex: not configured/);
  });

  it("refuses a TOML shape it cannot prove, before writing anything", () => {
    for (const text of [
      // A table header inside a multiline string comes first and fools the line search.
      `notes = """\n[mcp_servers.gatekeeper]\ncommand = "x"\nargs = []\n"""\n${CODEX}`,
      CODEX.replace(/args = \[ (.*) \]/, "args = [\n  $1,\n]"),
    ]) {
      writeFileSync(codexFile, text);
      expect(switchAgents(NODE, at("/wt/a"), ctx({ env: { CLAUDE_CONFIG_DIR: "/x" } }))).toBe(
        false,
      );
      expect(readFileSync(codexFile, "utf8")).toBe(text);
      expect(existsSync(backupFile())).toBe(false);
    }
    expect(logs.join("\n")).toMatch(/Codex: config.toml has a shape dev:link cannot edit safely/);
  });

  it("puts Claude's previous entry back when add-json fails, and stops", () => {
    expect(switchAgents(NODE, at("/wt/a"), ctx({ run: claudeCli({ failAdds: 1 }) }))).toBe(false);
    expect(claudeEntry()).toEqual(PUBLISHED);
    expect(backup().claude).toBeUndefined();
    expect(logs.join("\n")).toMatch(/Claude Code: claude mcp add-json failed: boom; the previous/);
  });

  it("keeps the original when the entry put back after a failed add-json reads differently", () => {
    const run = claudeCli({ failAdds: 1, dropEnv: true });
    expect(switchAgents(NODE, at("/wt/a"), ctx({ run }))).toBe(false);
    const { env: _, ...withoutEnv } = PUBLISHED;
    expect(backup().claude).toMatchObject({ original: PUBLISHED, written: withoutEnv });
  });

  it("keeps the original when Claude's entry cannot be put back, so unlink restores it", () => {
    expect(switchAgents(NODE, at("/wt/a"), ctx({ run: claudeCli({ failAdds: 2 }) }))).toBe(false);
    expect(JSON.parse(readFileSync(claudeFile(), "utf8")).mcpServers.gatekeeper).toBeUndefined();
    expect(backup().claude.original).toEqual(PUBLISHED);
    // Linking again from there would report success with no entry at all.
    expect(switchAgents(NODE, at("/wt/a"), ctx())).toBe(false);
    expect(logs.join("\n")).toMatch(
      /Claude Code: no gatekeeper entry while .* run pnpm dev:unlink/,
    );
    restoreAgents(ctx());
    expect(claudeEntry()).toEqual(PUBLISHED);
  });

  it("keeps the original when the CLI fails after it already removed the entry", () => {
    const run = claudeCli({ removeThenFail: true });
    expect(switchAgents(NODE, at("/wt/a"), ctx({ run }))).toBe(false);
    expect(backup().claude.original).toEqual(PUBLISHED);
  });

  it("leaves an entry edited since link, and keeps its original", () => {
    switchAgents(NODE, at("/wt/a"), ctx());
    const edited = readFileSync(codexFile, "utf8").replace("an env value", "edited");
    writeFileSync(codexFile, edited);
    expect(restoreAgents(ctx())).toBe(false);
    expect(readFileSync(codexFile, "utf8")).toBe(edited);
    expect(Object.keys(backup())).toEqual(["codex"]);
    expect(claudeEntry()).toEqual(PUBLISHED);
  });

  it("refuses to re-link an entry edited since the last link, from any checkout", () => {
    switchAgents(NODE, at("/wt/a"), ctx());
    const edited = readFileSync(codexFile, "utf8").replace("an env value", "edited");
    writeFileSync(codexFile, edited);
    expect(switchAgents(NODE, at("/wt/a"), ctx())).toBe(false);
    expect(switchAgents(NODE, at("/wt/b"), ctx())).toBe(false);
    expect(readFileSync(codexFile, "utf8")).toBe(edited);
    expect(logs.join("\n")).toMatch(/Codex: entry changed since dev:link, left as is\. To undo/);
    expect(restoreAgents(ctx())).toBe(false);
    expect(readFileSync(codexFile, "utf8")).toBe(edited);
  });

  it("restores a config whose args line ends the file without a newline byte for byte", () => {
    const last = 'model = "gpt"\n[mcp_servers.gatekeeper]\ncommand = "npx"\nargs = ["-y", "x"]';
    writeFileSync(codexFile, last);
    switchAgents(NODE, at("/wt/a"), ctx());
    expect(restoreAgents(ctx())).toBe(true);
    expect(readFileSync(codexFile, "utf8")).toBe(last);
  });

  it("round-trips a command-only entry that ends the file without a newline", () => {
    const last = 'model = "gpt"\r\n[mcp_servers.gatekeeper]\r\ncommand = "gatekeeper-mcp-server"';
    writeFileSync(codexFile, last);
    expect(switchAgents(NODE, at("/wt/a"), ctx())).toBe(true);
    expect(codexEntry()).toMatchObject({ command: NODE, args: at("/wt/a") });
    expect(restoreAgents(ctx())).toBe(true);
    expect(readFileSync(codexFile, "utf8")).toBe(last);
  });

  it("adds an args line to a command-only Codex entry, and unlink removes it", () => {
    const bare = CODEX.replace(/args = .*\r\n/, "");
    writeFileSync(codexFile, bare);
    expect(switchAgents(NODE, at("/wt/a"), ctx())).toBe(true);
    expect(codexEntry()).toMatchObject({ command: NODE, args: at("/wt/a") });
    expect(restoreAgents(ctx())).toBe(true);
    expect(readFileSync(codexFile, "utf8")).toBe(bare);
  });

  it("keeps the record matching the entry before every step, so a cut-off run recovers", () => {
    const steps: unknown[][] = [];
    const cli = claudeCli();
    const run: Run = (cmd, args) => {
      const entry = JSON.parse(readFileSync(claudeFile(), "utf8")).mcpServers.gatekeeper;
      steps.push([args[1], entry ?? null, backup().claude.written ?? null]);
      return cli(cmd, args);
    };
    switchAgents(NODE, at("/wt/a"), ctx({ run }));
    restoreAgents(ctx({ run }));
    expect(steps.map(([step]) => step)).toEqual(["remove", "add-json", "remove", "add-json"]);
    for (const [, entry, written] of steps) expect(written).toEqual(entry);
    expect(claudeEntry()).toEqual(PUBLISHED);
  });

  it("keeps the record as it was when a re-link fails without changing the entry", () => {
    switchAgents(NODE, at("/wt/a"), ctx());
    const linked = backup().claude;
    expect(switchAgents(NODE, at("/wt/b"), ctx({ run: claudeCli({ failRemove: true }) }))).toBe(
      false,
    );
    expect(backup().claude).toEqual(linked);
    expect(restoreAgents(ctx())).toBe(true);
    expect(claudeEntry()).toEqual(PUBLISHED);
  });

  it("refuses a second link through another Codex config, which has no original saved", () => {
    switchAgents(NODE, at("/wt/a"), ctx());
    mkdirSync(join(home, "other-codex"));
    writeFileSync(join(home, "other-codex", "config.toml"), CODEX);
    const env = { CODEX_HOME: join(home, "other-codex") };
    expect(switchAgents(NODE, at("/wt/b"), ctx({ env }))).toBe(false);
    expect(readFileSync(join(home, "other-codex", "config.toml"), "utf8")).toBe(CODEX);
    expect(logs.join("\n")).toMatch(
      /Codex: linked earlier through .*config\.toml; run pnpm dev:unlink/,
    );
  });

  it("keeps the original once Claude's entry changed, even when it cannot be read back", () => {
    let runs = 0;
    const cli = claudeCli();
    const garbled = claudeCli({ garble: true });
    const run: Run = (cmd, args) => (++runs === 2 ? garbled : cli)(cmd, args);
    expect(switchAgents(NODE, at("/wt/a"), ctx({ run }))).toBe(false);
    expect(backup().claude).toMatchObject({
      original: PUBLISHED,
      written: { command: NODE, args: at("/wt/a") },
    });
  });

  it("keeps the backup when Claude stores the restored entry differently", () => {
    switchAgents(NODE, at("/wt/a"), ctx({ run: claudeCli({ dropEnv: true }) }));
    expect(restoreAgents(ctx({ run: claudeCli({ dropEnv: true }) }))).toBe(false);
    expect(backup().claude.original).toEqual(PUBLISHED);
    expect(logs.join("\n")).toMatch(/Claude Code: claude mcp stored another entry than asked/);
  });

  it("refuses while another link or unlink holds the lock", () => {
    mkdirSync(join(home, ".gatekeeper"));
    writeFileSync(join(home, ".gatekeeper", "dev-link.lock"), "");
    expect(() => switchAgents(NODE, at("/wt/a"), ctx())).toThrow(/dev-link\.lock exists/);
    expect(readFileSync(codexFile, "utf8")).toBe(CODEX);
    expect(calls).toEqual([]);
  });

  it("changes nothing in a dry run", () => {
    expect(switchAgents(NODE, at("/wt/a"), ctx({ dry: true }))).toBe(true);
    expect(calls).toEqual([]);
    expect(readFileSync(codexFile, "utf8")).toBe(CODEX);
    expect(existsSync(join(home, ".gatekeeper"))).toBe(false);
  });

  it("edits a symlinked CODEX_HOME config through its link, and restores the file it edited", () => {
    const real = join(home, "dotfiles.toml");
    writeFileSync(real, CODEX);
    mkdirSync(join(home, "codex-home"));
    symlinkSync(real, join(home, "codex-home", "config.toml"));
    const env = { CODEX_HOME: join(home, "codex-home") };
    switchAgents(NODE, at("/wt/a"), ctx({ env }));
    expect(lstatSync(join(home, "codex-home", "config.toml")).isSymbolicLink()).toBe(true);
    expect(parse(readFileSync(real, "utf8"))).toMatchObject({
      mcp_servers: { gatekeeper: { command: NODE } },
    });
    expect(restoreAgents(ctx())).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(CODEX);
    expect(readFileSync(codexFile, "utf8")).toBe(CODEX);
  });

  it("says where an entry points without printing its env", () => {
    expect(describeEntry(PUBLISHED)).toEqual({
      root: null,
      label: "published @gldywn/gatekeeper-mcp-server@0.3.1",
    });
    expect(describeEntry({ command: NODE, args: at("/wt/gone") })).toEqual({
      root: "/wt/gone",
      label: "checkout /wt/gone ✗ BUILD GONE",
    });
  });
});

describe("dev:link servers and sessions", () => {
  const list = [
    { pid: 10, ppid: 1, cmd: "/opt/homebrew/bin/claude --resume" },
    { pid: 11, ppid: 10, cmd: "node /shims/pnpm.cjs dlx @gldywn/gatekeeper-mcp-server@0.3.1" },
    {
      pid: 12,
      ppid: 11,
      cmd: "node /dlx/node_modules/@gldywn/gatekeeper-mcp-server/dist/index.js",
    },
    { pid: 13, ppid: 10, cmd: "node /home/.npm/_npx/1/node_modules/.bin/gatekeeper-mcp-server" },
    { pid: 20, ppid: 1, cmd: "/Caskroom/codex/0.166.0/bin/codex" },
    { pid: 21, ppid: 20, cmd: "/bin/sh /work/wrap.sh" },
    { pid: 22, ppid: 21, cmd: "node /work/gatekeeper/packages/server/dist/index.js" },
    { pid: 30, ppid: 31, cmd: "node /other/gatekeeper-mcp-server/dist/index.js" },
    { pid: 31, ppid: 30, cmd: "/bin/sh loop" },
    { pid: 40, ppid: 999, cmd: "node /orphan/gatekeeper-mcp-server/dist/index.js" },
    // Mentioning the package is not running it.
    { pid: 50, ppid: 1, cmd: "node /pnpm.cjs --filter @gldywn/gatekeeper-mcp-server test" },
    { pid: 51, ppid: 1, cmd: "/opt/homebrew/bin/claude fix node gatekeeper-mcp-server" },
  ];
  const pids = (servers: { pid: number }[]) => servers.map((s) => s.pid);

  it("tells published servers from repo builds by the script node runs", () => {
    const servers = findServers({ published: true }, list);
    expect(pids(servers.filter((s: { published: boolean }) => s.published))).toEqual([
      12, 13, 30, 40,
    ]);
    expect(pids(findServers({ published: false }, list))).toEqual([22]);
  });

  it("finds the session above each server through wrappers, once per session", () => {
    const servers = findServers({ published: true }, list);
    expect(sessionsOf(servers, list)).toEqual([
      { harness: "Claude Code", pid: 10 },
      { harness: "Codex", pid: 20 },
      { harness: null, pid: 30 },
      { harness: null, pid: 40 },
    ]);
  });

  it("lists every session on another checkout's build by an absolute path", () => {
    const build = (root: string) => `node /wt/${root}/packages/server/dist/index.js`;
    const procs = [
      { pid: 60, ppid: 1, cmd: "claude" },
      { pid: 61, ppid: 60, cmd: build("gatekeeper-a") },
      { pid: 62, ppid: 1, cmd: "claude" },
      { pid: 63, ppid: 62, cmd: build("gatekeeper-a") },
      { pid: 64, ppid: 1, cmd: "codex" },
      { pid: 65, ppid: 64, cmd: build("gatekeeper-a") },
      { pid: 66, ppid: 1, cmd: "claude" },
      { pid: 67, ppid: 66, cmd: build("gatekeeper-b") },
    ];
    const cwds: Record<number, string> = { 60: "/proj", 64: "/wt/gatekeeper-a", 66: "/proj" };
    expect(sessionsOnOtherBuilds(procs, "/wt/gatekeeper-b", (pid: number) => cwds[pid])).toEqual([
      { harness: "Claude Code", pid: 60, cwd: "/proj" },
      { harness: "Claude Code", pid: 62, cwd: "?" },
      { harness: "Codex", pid: 64, cwd: "/wt/gatekeeper-a" },
    ]);
  });

  it("follows npx's bin link to the package it runs", () => {
    const pkg = join(home, "npx", "node_modules", "@gldywn", "gatekeeper-mcp-server");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "gk", version: "0.3.1" }));
    writeFileSync(join(pkg, "dist", "index.js"), "");
    writeFileSync(join(pkg, "dist", "build.json"), JSON.stringify({ version: "0.3.1" }));
    mkdirSync(join(home, "npx", "node_modules", ".bin"));
    const bin = join(home, "npx", "node_modules", ".bin", "gatekeeper-mcp-server");
    symlinkSync("../@gldywn/gatekeeper-mcp-server/dist/index.js", bin);
    expect(identify(`node ${bin}`, "/")).toEqual({ root: null, label: "gk 0.3.1 (on disk)" });
  });

  it("reads a broker holder's version from its files on disk", () => {
    const dist = join(home, "wt", "packages", "server", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "..", "package.json"),
      JSON.stringify({ name: "srv", version: "0.4.0" }),
    );
    writeFileSync(
      join(dist, "build.json"),
      JSON.stringify({ version: "0.4.0", dev: { sha: "abc" } }),
    );
    writeFileSync(join(dist, "index.js"), "");
    expect(identify("node packages/server/dist/index.js", join(home, "wt"))).toEqual({
      root: join(realpathSync(home), "wt"),
      label: "srv 0.4.0 dev abc (on disk)",
    });
    expect(identify("node ../../scripts/dev-server.mjs", "/wt/packages/server")).toEqual({
      root: "/wt",
      label: "dev launcher (sources)",
    });
  });
});
