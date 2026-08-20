<p align="center">
  <img src="https://raw.githubusercontent.com/Gldywn/gatekeeper/main/docs/assets/gatekeeper-logo.svg" alt="Gatekeeper" width="96">
</p>

<h1 align="center">@gldywn/gatekeeper-mcp-server</h1>

<p align="center"><b>Your agents propose the SQL. You approve what runs.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@gldywn/gatekeeper-mcp-server"><img src="https://img.shields.io/npm/v/@gldywn/gatekeeper-mcp-server" alt="npm"></a>
  <a href="https://github.com/Gldywn/gatekeeper/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Gldywn/gatekeeper/ci.yml?branch=main&label=ci" alt="CI"></a>
  <a href="https://github.com/Gldywn/gatekeeper/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Gldywn/gatekeeper" alt="License"></a>
</p>

The MCP server half of [Gatekeeper](https://github.com/Gldywn/gatekeeper): a human-approved
bridge between AI agents and your database. An agent proposes a query through this server;
the Gatekeeper plugin inside Beekeeper Studio shows the SQL to a human, who approves or
rejects it. On approval the query runs on the connection Beekeeper already holds and the rows
flow back to the agent.

The agent never holds database credentials, and nothing runs without a human approving it
first. Reads are the default; a write runs only under an ephemeral mode a human arms in the
plugin.

## This package is one of three pieces

| Piece | Where it goes |
|---|---|
| **This MCP server** | Registered with your agent, started by it, `npx` fetches it |
| **Beekeeper Studio plugin** | Installed in Beekeeper Studio, where you approve queries |
| **Agent skill** | `npx skills add Gldywn/gatekeeper`, teaches an agent to drive the tools |

The server on its own has no one to ask. Start from the
[repo README](https://github.com/Gldywn/gatekeeper) for the full setup.

## Not a daemon

This is a short-lived stdio child of your agent. Your MCP client starts it when the session
opens and it exits when that session's stdio pipe closes. There is no background service to
install, enable, or keep running.

While it runs it also serves a loopback-only HTTP broker on `127.0.0.1:9999` that the plugin
polls. If several agents run at once, the first one owns the broker and the rest share the
same local queue; the role fails over automatically when the owner exits.

## Install

Nothing to clone or build. Register it with your agent and `npx` fetches it on first launch:

```bash
# Claude Code
claude mcp add gatekeeper --scope user -- npx -y @gldywn/gatekeeper-mcp-server

# Codex CLI (~/.codex/config.toml)
# [mcp_servers.gatekeeper]
# command = "npx"
# args = ["-y", "@gldywn/gatekeeper-mcp-server"]
```

Any client that reads `.mcp.json`:

```json
{
  "mcpServers": {
    "gatekeeper": {
      "command": "npx",
      "args": ["-y", "@gldywn/gatekeeper-mcp-server"]
    }
  }
}
```

Append `@<version>` to pin (`npx -y @gldywn/gatekeeper-mcp-server@0.1.0`). Unpinned, `npx`
re-resolves the latest release on every agent launch: current, but a process with a path to
your database changes under you.

Requires **Node >= 22**. The only native dependency is `better-sqlite3`, which ships prebuilt
binaries for Node 22, 24, 25 and 26, so a normal install needs no C++ toolchain. On Node 20 or
21 there is no prebuild and npm falls back to compiling from source.

## Pair once per machine

The broker cannot tell the plugin apart from any web page you visit, so the capability token
crosses on a channel a page cannot observe: your eyes.

Start your agent and ask it for anything that needs the database. Until the plugin is paired,
every Gatekeeper tool answers with a **6-digit code** instead of running. Type that code into
the Gatekeeper tab in Beekeeper Studio (Tools menu). The code is single-use, lasts five
minutes, and dies after five wrong guesses; `http://127.0.0.1:9999/pair` always shows the
current one.

The plugin then keeps the token it receives in Beekeeper's encrypted storage, so this happens
once per machine.

## MCP tools

`submit_query`, `get_query_result`, `poll_results`, `cancel_query`, `run_query`,
`set_session_label`, `get_connection_info`, `get_schema`. See
[MCP tools](https://github.com/Gldywn/gatekeeper/blob/main/docs/MCP-TOOLS.md) for the full
contract, and the companion agent skill (`npx skills add Gldywn/gatekeeper`) that teaches an
agent to drive them well.

## Configuration

`GATEKEEPER_TOKEN`, `GATEKEEPER_BROKER_PORT`, `GATEKEEPER_DB` and `GATEKEEPER_NOTIFY`, all
documented in
[Configuration](https://github.com/Gldywn/gatekeeper/blob/main/docs/CONFIGURATION.md)
alongside the macOS desktop notifications.

## Security

The broker binds `127.0.0.1`, requires a bearer token on every request, and rejects
unexpected `Host` headers. The risk gate itself lives in the plugin, where execution happens.
[`SECURITY.md`](https://github.com/Gldywn/gatekeeper/blob/main/SECURITY.md) has the threat
model, the same-user trust boundary, and the retention windows.

MIT © Gldywn
