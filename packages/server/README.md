# @gldywn/gatekeeper-mcp-server

The MCP server half of [Gatekeeper](https://github.com/Gldywn/gatekeeper): a human-approved,
LLM-agnostic bridge for running SQL through Beekeeper Studio's existing database connection.

An agent proposes a query through this server. The [Gatekeeper plugin](https://github.com/Gldywn/gatekeeper)
inside Beekeeper Studio shows the SQL to a human, who approves or rejects it. On approval the
query runs on the connection Beekeeper already holds and the rows flow back to the agent. The
agent never holds database credentials, and nothing runs without a human approving it first.

Reads are the default; a write runs only under an ephemeral mode a human arms in the plugin.

## Not a daemon

This is a short-lived stdio child of your agent. Your MCP client starts it when the session
opens and it exits when that session's stdio pipe closes. There is no background service to
install, enable, or keep running.

While it runs it also serves a loopback-only HTTP broker on `127.0.0.1:9999` that the plugin
polls. If several agents run at once, the first one owns the broker and the rest share the same
local queue; the role fails over automatically when the owner exits.

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

## Pairing

Start your agent once. That launches this server, which creates a capability token at
`~/.gatekeeper/broker-token` (`0600`, in a `0700` directory). Then open Gatekeeper from
Beekeeper Studio's Tools menu and paste the token:

```bash
cat ~/.gatekeeper/broker-token
```

The plugin keeps its copy in Beekeeper's encrypted storage. Pairing is once per machine.

## MCP tools

`submit_query`, `get_query_result`, `poll_results`, `cancel_query`, `run_query`,
`set_session_label`, `get_connection_info`, `get_schema`. See the
[repo README](https://github.com/Gldywn/gatekeeper#mcp-tools) for the full contract, and the
companion agent skill (`npx skills add Gldywn/gatekeeper`) that teaches an agent to drive them.

## Environment

- `GATEKEEPER_TOKEN`: use a fixed token instead of the generated file.
- `GATEKEEPER_BROKER_PORT`: broker port (default `9999`). The plugin talks to `9999`, so
  changing this here breaks pairing.
- `GATEKEEPER_DB`: SQLite path (default `~/.gatekeeper/requests.db`).

## Security

See [SECURITY.md](https://github.com/Gldywn/gatekeeper/blob/main/SECURITY.md) for the
same-user trust boundary, the supply-chain policy, and the read-only database posture.

MIT © Gldywn
