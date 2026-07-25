# Gatekeeper

Human-approved, LLM-agnostic bridge for running **read-only** SQL through Beekeeper
Studio's existing database connection.

An MCP server lets any MCP client (Claude Code, Codex CLI, OpenCode, ...) propose a
SQL query. A Beekeeper Studio plugin surfaces that query for a human to approve. On
approval the query runs on the connection Beekeeper already holds, and the result
flows back to the agent. The agent never holds database credentials, and nothing runs
without a human approving it first.

## Why

During investigations (support triage, debugging, data checks) an agent often needs
to read from the database. The manual version is: the human copy-pastes the agent's
SQL into a client, runs it, pastes the result back. Gatekeeper automates that
transport while keeping the human as the approval gate:

- The human eyeballs every query before it runs. That is the PII and safety check.
- Queries run through Beekeeper's already-authenticated connection, so the agent never
  touches credentials. Point Beekeeper at a read replica or a read-only role for a hard
  backstop.
- Read-only is enforced in the plugin with a dialect-aware SQL parser (single `SELECT`
  only).

## Architecture

Three components, two independent channels.

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

### Two channels (the core mental model)

The plugin runs inside a sandboxed iframe. It cannot *receive* inbound connections (it
can never be a server), but it can *initiate* outbound ones like any web page. There
are two separate pipes, and the plugin glues them:

- **Channel 1, plugin <-> Beekeeper** (`postMessage`): the `@beekeeperstudio/plugin`
  API. `runQuery`, `getConnectionInfo`, `appStorage` live here. Fully internal to
  Beekeeper.
- **Channel 2, plugin <-> broker** (`fetch` over `http://127.0.0.1`): a plain web
  request. The plugin is the **client** and **pulls** work by polling the broker.
  Nothing is ever pushed into the iframe, which is what makes the design
  sandbox-compatible.

### The loop (non-blocking)

1. The agent calls `submit_query(sql, intent)`. The server enqueues the proposal and
   returns a `request_id` immediately; it does not block.
2. The plugin polls `GET /pending`, claims the oldest proposal under a lease, and
   renders the SQL.
3. The human approves or rejects. On approval the plugin calls `runQuery(sql)`
   (Channel 1); Beekeeper runs it on the user's connection.
4. The plugin posts the outcome to `POST /result` (Channel 2).
5. The agent reads the outcome with `get_query_result(request_id)`, optionally waiting
   up to a bounded window.

Because submit and read are separate, an agent can keep several proposals in flight and
collect each result as its human decision lands. Approval is **pre-execution**, on the
SQL text.

## MCP tools

- `submit_query({ sql, intent?, idempotency_key? })` -> ticket. Enqueues a read-only
  proposal and returns immediately with `request_id` and `state`.
- `get_query_result({ request_id, wait_ms? })` -> ticket. Reads a proposal, optionally
  waiting (bounded) for a terminal state: `approved`, `rejected`, `failed`, `expired`,
  `cancelled`.
- `cancel_query({ request_id })` -> ticket. Withdraws a pending or leased proposal.
- `run_query({ sql, intent? })` -> ticket. Convenience wrapper that submits and waits
  for the terminal result. It serializes one query at a time; prefer
  `submit_query` + `get_query_result` for concurrency.
- `get_connection_info()` -> snapshot. Non-sensitive context about the connected
  database (dialect, database, schema, read-only, captured-at). Never includes host,
  user, or credentials; informational only.

A ticket is `{ requestId, state, createdAt, expiresAt, terminal? }`, where `terminal`
carries the `rows` and `fields` of an approved query.

## Security

- **Read-only enforcement.** The plugin is the only component that can call `runQuery`,
  so the guard lives there: `node-sql-parser` parses each query in the connection's
  dialect and rejects anything that is not a single `SELECT`, with a conservative
  fallback when parsing fails. The server also preflights with a regex before enqueueing.
- **Capability token.** The broker requires an `Authorization: Bearer` token on every
  request (`401` otherwise). It is generated on first run and stored at
  `~/.gatekeeper/broker-token` (`0600`); the plugin keeps it in Beekeeper's encrypted
  storage.
- **Loopback only, DNS-rebinding defense.** The broker binds `127.0.0.1` and rejects
  unexpected `Host` headers (`421`).
- **Owner-only state.** `~/.gatekeeper` is created `0700`, covering the token, the
  SQLite database, and its WAL side files.
- **Minimal retention.** The audit log records the lifecycle (decision, timestamps, SQL
  digest, row count) with no raw SQL and no rows. Approved result rows are stripped from
  the database 10 minutes after the decision.

See [`SECURITY.md`](./SECURITY.md) for the supply-chain policy and the read-only
database boundary.

## Durability

Proposals live in a SQLite queue with a lease state machine
(`pending -> leased -> executing -> terminal`). A claimed proposal is leased to one
plugin for 30 seconds and renewed while its card is open. If a plugin dies mid-decision
the lease expires and the proposal is re-offered; if it dies mid-execution the proposal
is failed as `execution_unknown` and never re-run, so a query is never silently executed
twice.

## Getting started

Prerequisites: Node >= 20.19, pnpm, Beekeeper Studio >= 5.4.

1. Install and build:
   ```
   pnpm install
   pnpm build
   ```
2. **Register the MCP server** with your client. Copy `.mcp.json.example` and point
   `args` at the absolute path of `server/dist/index.js`. The client launches the server
   over stdio.
3. **Install the plugin** into Beekeeper Studio. Symlink the `plugin/` directory into
   Beekeeper's plugins folder (see Beekeeper's plugin development docs) under the name
   `gatekeeper`; the folder name must match the manifest `id`.
4. **Pair the plugin.** Open Gatekeeper from Beekeeper's Tools menu, read the token with
   `cat ~/.gatekeeper/broker-token`, and paste it into the pairing screen.
5. **Use it.** The agent calls `submit_query`; the plugin shows the SQL; approve it; the
   rows return to the agent.

Environment variables:

- `GATEKEEPER_TOKEN`: use a fixed token instead of the generated file.
- `GATEKEEPER_BROKER_PORT`: broker port (default `9999`).
- `GATEKEEPER_DB`: SQLite path (default `~/.gatekeeper/requests.db`).

## Repo layout

```
server/
  src/
    index.ts       broker + MCP wiring, token, shutdown
    broker.ts      loopback HTTP endpoints
    mcp.ts         MCP tools
    service.ts     submit / get / cancel, ticket shaping, read-only preflight
    store.ts       durable SQLite lease queue + audit trail
    connection.ts  non-sensitive connection snapshot
    policy.ts      server-side read-only preflight
    config.ts      environment and constants
plugin/
  manifest.json
  index.html
  src/
    main.ts        UI, polling, lease renewal, approve / reject, history
    readonly.ts    dialect-aware read-only guard
    result.ts      history result caps
    style.css
  DESIGN.md        plugin design system
.mcp.json.example  MCP client stub
biome.json         lint + format
SECURITY.md        supply-chain policy + DB boundary
```

## Development

```
pnpm build     # build both packages
pnpm test      # server + plugin test suites (vitest)
pnpm lint      # biome check
pnpm format    # biome format --write
```

## Tech stack

- **Plugin:** TypeScript, Vite, `@beekeeperstudio/plugin`, `node-sql-parser`. Requires
  Beekeeper Studio >= 5.4.
- **Server:** TypeScript, `@modelcontextprotocol/sdk`, `better-sqlite3`, Node's built-in
  `http`. Requires Node >= 20.19.
- **Tooling:** Biome (lint + format), Vitest, pnpm workspaces with an exact-pin,
  quarantined supply-chain policy.

## References

- Plugin API: https://docs.beekeeperstudio.io/plugin_development/api-reference/
- Plugin architecture: https://docs.beekeeperstudio.io/plugin_development/
- MCP: https://modelcontextprotocol.io
