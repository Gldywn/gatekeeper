<p align="center">
  <img src="https://raw.githubusercontent.com/Gldywn/gatekeeper/main/docs/assets/gatekeeper-logo.svg" alt="Gatekeeper" width="112">
</p>

<h1 align="center">Gatekeeper</h1>

<p align="center"><b>Your agents propose the SQL. You approve what runs.</b></p>

<p align="center">
  <a href="https://github.com/Gldywn/gatekeeper/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Gldywn/gatekeeper/ci.yml?branch=main&label=ci" alt="CI"></a>
  <a href="https://github.com/Gldywn/gatekeeper/releases"><img src="https://img.shields.io/github/v/release/Gldywn/gatekeeper" alt="Release"></a>
  <a href="https://github.com/Gldywn/gatekeeper/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Gldywn/gatekeeper" alt="License"></a>
</p>

<p align="center">
  <a href="#getting-started"><img src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" alt="Works with Claude Code"></a>
  <a href="#getting-started"><img src="https://img.shields.io/badge/Codex_CLI-555555" alt="Works with Codex CLI"></a>
  <a href="#getting-started"><img src="https://img.shields.io/badge/OpenCode-000000?logo=opencode&logoColor=white" alt="Works with OpenCode"></a>
</p>

Gatekeeper is a human-approved bridge between AI agents and your database. An agent proposes
a query over MCP; nothing runs until you approve it in
[Beekeeper Studio](https://www.beekeeperstudio.io), on the SQL text, before execution. The
query then runs on the connection Beekeeper already holds, and the rows return to the agent.

**Read-only by default.** A write runs only under a mode you arm yourself in the plugin, and
that mode is ephemeral. The agent never holds your database credentials.

<details>
<summary>Music</summary>

Music from #Uppbeat (free for Creators!): [Shine by Swoop](https://uppbeat.io/t/swoop/shine)

</details>

> [!TIP]
> **Coming soon:** an auto mode that scores each query's risk against your session intent, so safe ones can run without a click. More on the way.

## The three pieces

| Piece | What it does | Where it runs |
|---|---|---|
| **Beekeeper Studio plugin** | Shows each proposed query, classifies its risk, executes it on your connection once you approve | Inside Beekeeper Studio |
| **MCP server** | The agent-facing side: the tools an agent calls to propose a query and collect its result | On your machine, started by your agent |
| **Agent skill** | Teaches any agent to drive those tools well | In your agent's skills folder |

They ship together under one version, and they are useful together: the plugin without the
server has nothing to approve, the server without the plugin has no one to ask.

## Why

- **You are the PII and safety check.** Every query is read by a human before it runs, and
  the decision is recorded.
- **No credentials leave Beekeeper.** Queries run through its already-authenticated
  connection. Point Beekeeper at a read replica or a read-only role for a hard backstop.
- **Risk is classified, not assumed.** A dialect-aware parser sorts each query into read,
  write or destructive, and the Approve button stays blocked until the matching mode is
  armed.

## How it works

```
  MCP client                     Gatekeeper server (127.0.0.1)          Beekeeper Studio
 ┌────────────────────┐   MCP    ┌───────────────────────────┐  fetch   ┌────────────────────┐
 │ submit_query(sql)  │ ───────► │ MCP server + HTTP broker  │ ◄─────── │ Plugin (iframe)    │
 │ get_query_result() │ ◄─────── │ SQLite lease queue + audit│  poll    │ 1. show SQL        │
 │ cancel_query()     │          │ /pending /executing       │ ───────► │ 2. human approves  │
 │                    │          │ /result  /lease/renew     │  result  │ 3. runQuery()      │
 └────────────────────┘          └───────────────────────────┘          │ 4. post result     │
                                                                        └────────────────────┘
```

1. The agent submits a proposal and gets a request id back immediately. Nothing blocks.
2. The plugin polls the local broker, claims the proposal under a lease, and renders the SQL.
3. You approve or reject. On approval Beekeeper runs the query on your connection.
4. The plugin posts the outcome back, and the agent collects it when it is ready.

The plugin runs in a sandboxed iframe, so it can never receive an inbound connection: it
polls the broker instead. That single constraint explains the whole shape. Full detail in
[Architecture](https://github.com/Gldywn/gatekeeper/blob/main/docs/ARCHITECTURE.md).

## Getting started

**Prerequisites:** Beekeeper Studio >= 5.4 and Node >= 22. If you run Claude Code or Codex
CLI you already have Node. There is no background service to install: your agent starts the
server when its session opens, and it exits when that session ends.

> **macOS only, for now.** Gatekeeper is developed and tested on macOS. **Windows and Linux
> are not yet tested**, so treat them as unsupported until someone reports back. Nothing in
> the shipped code is macOS-specific (the server resolves paths from your home directory, the
> plugin is a standard Beekeeper webview), so both are expected to work, but expected is not
> verified. Reports from either platform are very welcome.

> **Not in Beekeeper's plugin registry yet.** A submission is in progress with the Beekeeper
> maintainers. Until it is merged, Manage Plugins will not list Gatekeeper and the one-click
> install is unavailable, so step 1 below is the manual route. Nothing else differs.

**1. Install the plugin in Beekeeper Studio.** Download `gatekeeper-<version>.zip` from the
[latest release](https://github.com/Gldywn/gatekeeper/releases/latest), extract it into
Beekeeper's plugins folder, and restart Beekeeper:

| OS | Plugins folder |
|---|---|
| macOS | `~/Library/Application Support/beekeeper-studio/plugins/` |
| Linux | `~/.config/beekeeper-studio/plugins/` |
| Windows | `%APPDATA%\beekeeper-studio\plugins\` |

> **The extracted folder must be named exactly `gatekeeper`.** The zip expands to
> `gatekeeper-<version>/`, so rename it after extracting. Beekeeper matches the folder name
> against the plugin id and **skips any folder that disagrees without saying a word**: no
> error, no entry in Manage Plugins, nothing to click. This is the single most common reason
> a manual install appears to do nothing.

**2. Register the MCP server with your agent.** This is also the server install: `npx`
downloads and caches it on first launch.

```bash
# Claude Code
claude mcp add gatekeeper --scope user -- npx -y @gldywn/gatekeeper-mcp-server
```

```toml
# Codex CLI, in ~/.codex/config.toml
[mcp_servers.gatekeeper]
command = "npx"
args = ["-y", "@gldywn/gatekeeper-mcp-server"]
```

**Prefer pnpm?** `pnpm dlx @gldywn/gatekeeper-mcp-server` is the direct equivalent of the
`npx` line. To resolve the package once rather than at every agent launch, install it with
`pnpm add -g @gldywn/gatekeeper-mcp-server` and point your client at the
`gatekeeper-mcp-server` binary it puts on your `PATH`.

Any client that reads `.mcp.json` can use
[`.mcp.json.example`](https://github.com/Gldywn/gatekeeper/blob/main/.mcp.json.example) as-is.
Pin the version (`@gldywn/gatekeeper-mcp-server@<version>`) if you would rather audit upgrades
than receive them: unpinned, `npx` re-resolves the latest release on every agent launch,
which keeps you current but means a process with a path to your database changes under you.

**3. Install the agent skill.**

```bash
npx skills add Gldywn/gatekeeper
```

The CLI is interactive: it asks which agents to install for and whether to install globally.
It works across Claude Code, Codex, Cursor and the rest.

**4. Pair the plugin, once per machine.** Start your agent, then ask it for anything that
needs the database. Until the plugin is paired every Gatekeeper tool answers with a 6-digit
code: type that code into the plugin (Tools -> Gatekeeper). The code is single-use and lasts
about five minutes, and `http://127.0.0.1:9999/pair` always shows the current one. The
capability token it hands over is kept in Beekeeper's encrypted storage.

Nothing answers on that port until your agent has started the server at least once. Open the
plugin before that and it tells you so, rather than showing a pairing field it cannot honour.

**5. Use it.** Ask your agent for something that needs the database. It proposes SQL, the
query appears in the plugin, you approve, and the rows return to the agent. Reads work
straight away; a write runs only once you arm Write or Destructive mode.

Building from source is documented in
[Development](https://github.com/Gldywn/gatekeeper/blob/main/docs/DEVELOPMENT.md).

### If the plugin never shows up

Beekeeper ships with its plugin system locked down, so a fresh install can ignore a
third-party plugin entirely. Three things to check, in order:

**1. The folder name.** Exactly `gatekeeper`, not `gatekeeper-0.1.1`. A mismatch is skipped
silently, as above.

**2. The plugin system is enabled.** Beekeeper's shipped defaults set
`pluginSystem.disabled = true`, with an allowlist that contains only its own two plugins.
Add this to your user config, then restart:

```ini
[pluginSystem]
disabled = false
```

**3. Community plugins are enabled.** `communityDisabled = true` is a shipped default too,
and it disables any plugin Beekeeper lists as community. If the plugin manager shows
"Community plugins are disabled via configuration", add `communityDisabled = false` in the
same block.

| OS | User config file |
|---|---|
| macOS | `~/Library/Application Support/beekeeper-studio/user.config.ini` |
| Linux | `~/.config/beekeeper-studio/user.config.ini` |
| Windows | `%APPDATA%\beekeeper-studio\user.config.ini` |

## Access modes

Every query is approved by a human click on its text. The armed mode decides which risk
classes that click is allowed to approve.

| Mode | Approves | Armed by |
|---|---|---|
| **Read** (default) | `SELECT` and friends | Nothing to do |
| **Write** | `INSERT`, `UPDATE` | You, in the plugin, with a second confirmation |
| **Destructive** | `DELETE`, `DROP`, `TRUNCATE`, `ALTER` | You, in the plugin, with a second confirmation |

The armed mode is in-memory only, never persisted, and resets to read-only on a connection
switch or a re-pair. The plugin re-classifies and re-checks at the moment of execution, so
arming and disarming take effect immediately.

**The card reads the query for you**, so deciding takes a glance instead of a careful parse.
The SQL arrives formatted and highlighted, with invisible and direction-flipping characters
shown as explicit markers, so what you read is what runs. A write or destructive statement
carries a coloured class badge and names its verb and its target tables, and a statement the
parser cannot read says so in standing text and is treated as destructive.

Under the SQL, an annotation names the tables the query reads and the sensitive columns among
them: person data in one accent, company and commercial data in another, a sensitive value
flagged even when it only appears in a `WHERE` filter, and a `SELECT *` expanded against the
real columns so nothing hides behind the star. A header badge stacks the three read-only
layers, the armed mode, the Beekeeper connection and the database endpoint, and warns you
when not one of them would block a write.

Each detector is a toggle in the plugin settings, they all run on your machine, and none of
what they surface is ever sent to the agent. They match column names and value shapes, so
treat them as a fast pointer at what deserves a second look, not as proof that a query is
clean. No flags can also mean the annotation never resolved.

## Security

- **The gate lives where execution lives.** The plugin is the only component that can run a
  query, so that is where the classifier and the mode check sit.
- **Capability token on every request.** The broker answers `401` without it. It is generated
  on first run, stored `0600` under `~/.gatekeeper`, and held by the plugin in Beekeeper's
  encrypted storage.
- **Pairing by code.** The broker cannot tell the plugin apart from any web page you visit,
  so the token crosses on a channel a page cannot observe: a single-use 6-digit code you read
  with your own eyes, valid five minutes, killed after five wrong guesses.
- **Loopback only.** The broker binds `127.0.0.1` and rejects unexpected `Host` headers, so a
  DNS-rebinding page gets a `421`.
- **Capped results, minimal audit.** Forwarded rows are capped by count and bytes so a bulk
  read never floods the agent context. The agent-facing audit keeps the decision and a SQL
  digest, never raw SQL and never rows.

Read is not a guarantee of zero side effects: a `SELECT` can call a volatile function, which
is exactly why approval happens on the visible SQL.
[`SECURITY.md`](https://github.com/Gldywn/gatekeeper/blob/main/SECURITY.md) has the threat
model, the same-user trust boundary, the retention windows and the supply-chain policy.

## Documentation

| Document | What is in it |
|---|---|
| [Architecture](https://github.com/Gldywn/gatekeeper/blob/main/docs/ARCHITECTURE.md) | The two channels, the approval loop, the lease queue, result caps |
| [MCP tools](https://github.com/Gldywn/gatekeeper/blob/main/docs/MCP-TOOLS.md) | Every tool an agent can call, the ticket shape, the waiting contract |
| [Configuration](https://github.com/Gldywn/gatekeeper/blob/main/docs/CONFIGURATION.md) | Environment variables and desktop notifications |
| [Security](https://github.com/Gldywn/gatekeeper/blob/main/SECURITY.md) | Threat model, trust boundary, retention, supply chain |
| [Development](https://github.com/Gldywn/gatekeeper/blob/main/docs/DEVELOPMENT.md) | Build from source, dev wiring, repo layout, tech stack |
| [Releasing](https://github.com/Gldywn/gatekeeper/blob/main/docs/RELEASING.md) | How a commit becomes a plugin release and an npm package |

## Development

```bash
pnpm install
pnpm build     # both packages
pnpm ci        # typecheck + build + test
```

`pnpm dev:link` points Beekeeper at your checkout and `pnpm dev` starts the plugin UI with
hot reload. The full setup, including the test databases, is in
[Development](https://github.com/Gldywn/gatekeeper/blob/main/docs/DEVELOPMENT.md).

## License

[MIT](https://github.com/Gldywn/gatekeeper/blob/main/LICENSE)
