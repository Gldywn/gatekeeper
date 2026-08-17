# Gatekeeper

Human-approved, LLM-agnostic bridge for running SQL through Beekeeper Studio's existing
database connection. **Read-only by default**: a write runs only under an ephemeral mode
a human arms in the plugin, and every statement is approved on its text before it runs.

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
- The plugin classifies each query with a dialect-aware parser (read / write /
  destructive) and only lets the human approve a class the armed mode allows. The armed
  mode is off (read-only) by default; a human arms Write or Destructive in the plugin,
  and it is ephemeral (never persisted, and dropped on a connection switch or re-pair).

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

### Access modes

Every query is approved by a human click on its text; the armed mode decides which risk
classes that click may approve:

- **Read** (default): only reads can be approved. Writes and destructive statements show
  but their Approve button is blocked until the matching mode is armed.
- **Write**: an `INSERT`/`UPDATE` can be approved, with a second confirmation by default.
- **Destructive**: a `DELETE`/`DROP`/`TRUNCATE`/`ALTER` can be approved, with a second
  confirmation by default.

The armed mode is in-memory only, never persisted, and resets to read-only on a
connection switch or a re-pair. The plugin re-classifies and re-checks the mode at the
moment of execution, so arming and disarming take effect immediately. Read is not a
guarantee of zero side effects (see [`SECURITY.md`](./SECURITY.md)): a `SELECT` can call
a volatile function, so the human approval on the visible SQL is the real backstop.

## MCP tools

- `submit_query({ sql, intent?, idempotency_key? })` -> ticket. Enqueues a proposal (a
  read, or a write for a human to approve under an armed mode) and returns immediately
  with `request_id` and `state`. Requires a session label first (see
  `set_session_label`), otherwise it is rejected. Reusing an `idempotency_key` with
  different SQL is rejected rather than silently returning the first statement's result.
- `get_query_result({ request_id, wait_ms? })` -> ticket. Reads a proposal, optionally
  waiting for a terminal state: `approved`, `rejected`, `failed`, `expired`, `cancelled`.
  Every wait is bounded by `MAX_WAIT_MS` (25s), so a wait that runs out returns the
  proposal in whatever non-terminal state it is in; the agent calls again to keep waiting.
- `poll_results({ wait_ms? })` -> `{ results, pending }`. The state of every query the
  session proposed recently, in one call, optionally waiting (same 25s bound) until any
  pending one resolves. States only; fetch a resolved one's rows with `get_query_result`.
- `cancel_query({ request_id })` -> ticket. Withdraws a pending or leased proposal.
- `run_query({ sql, intent? })` -> ticket. Convenience wrapper that submits and waits
  once, under the same 25s bound, so it can return a still-pending proposal rather than
  the result. It serializes one query at a time; prefer `submit_query` +
  `poll_results`/`get_query_result` for concurrency.
- `set_session_label({ label })` -> ok. Names the session with a short, human-readable
  label shown in the plugin's connected-agents roster. Required before any query: the
  server rejects `submit_query` until a session label is set.
- `get_connection_info()` -> snapshot. Non-sensitive context about the connected
  database (dialect, database, schema, read-only, the human's armed mode, captured-at).
  Never includes host, user, or credentials; informational only.
- `get_schema()` -> structure. The connected database's schemas, tables, and columns
  (with types and keys) so the agent can write valid SQL. Never returns row data,
  default values, view/function bodies, or comments. Available only while the human has
  Schema access on for the connection; otherwise it reports unavailable.

A ticket is `{ requestId, state, createdAt, expiresAt, terminal? }`, where `terminal`
carries the `rows` and `fields` of an approved query. The plugin caps the forwarded rows
so a bulk read never floods the agent context; `terminal.truncated` says it capped and
`terminal.rowCount` is the true pre-cap total.

## Agent skill

A companion skill teaches any agent to drive these tools well: name the session up
front, propose read-only PII-free SQL, work in parallel while a human approves, and
collect results as they land instead of blocking or ending the turn early. It is a
single model-agnostic `SKILL.md` under [`skills/gatekeeper/`](skills/gatekeeper/SKILL.md),
distributed through the [skills.sh](https://skills.sh) CLI so it installs across Claude
Code, Codex, Cursor, and the rest:

```bash
npx skills add Gldywn/gatekeeper
```

The CLI is interactive: it asks which agents to install for and whether to install
globally. Editing the skill: change `skills/gatekeeper/SKILL.md`, commit, and re-sync
with `npx skills update`.

## Security

- **Risk classification and mode gating.** The plugin is the only component that can call
  `runQuery`, so the gate lives there: `node-sql-parser` parses each query in the
  connection's dialect, classifies it read / write / destructive (escalating on any
  embedded modify node, with a conservative fallback when parsing fails), and only lets
  the human approve a class the armed mode allows. The server also preflights with a
  regex to block empty and multi-statement input before enqueueing. A single `SELECT` can
  still carry side effects through volatile functions; see `SECURITY.md`.
- **Capability token.** The broker requires an `Authorization: Bearer` token on every
  request (`401` otherwise). It is generated on first run and stored at
  `~/.gatekeeper/broker-token` (`0600`); the plugin keeps it in Beekeeper's encrypted
  storage. Any process running as the same OS user can read that token; see `SECURITY.md`
  for the same-user trust boundary.
- **Pairing by code.** The broker cannot tell the plugin apart from any web page the human
  visits: both are browser contexts issuing the same loopback requests. So the token
  crosses over on a channel a page cannot observe, the human's eyes: a single-use 6-digit
  code, valid five minutes, killed after five wrong guesses and paced by a guess budget.
  The page that displays it deliberately carries no CORS headers, so no site can read it;
  the exchange route keeps them (the plugin must read its answer) and rests on the code.
- **Loopback only, DNS-rebinding defense.** The broker binds `127.0.0.1` and rejects
  unexpected `Host` headers (`421`).
- **Owner-only state.** `~/.gatekeeper` is created `0700`, covering the token, the
  SQLite database, and its WAL side files.
- **Result caps.** The plugin caps the rows it forwards to the agent (by count and bytes)
  so a bulk read never floods the agent context or the LLM provider; the agent still
  learns the true count via `truncated` + `rowCount`.
- **Retention.** The agent-facing audit records the lifecycle (decision, timestamps, SQL
  digest, row count) with no raw SQL and no rows. The raw SQL lives in the local queue
  and the human-only Audit Trail until retention; approved result rows are stripped 10
  minutes after the decision. See `SECURITY.md` for the at-rest window.

See [`SECURITY.md`](./SECURITY.md) for the supply-chain policy, the same-user trust
boundary, and the read-only database posture.

## Durability

Proposals live in a SQLite queue with a lease state machine
(`pending -> leased -> executing -> terminal`). A claimed proposal is leased to one
plugin for 30 seconds and renewed while its card is open. If a plugin dies mid-decision
the lease expires and the proposal is re-offered; if it dies mid-execution the proposal
is failed as `execution_unknown` and never re-run, so a query is never silently executed
twice.

## Install

Prerequisites: Beekeeper Studio >= 5.4 and Node >= 22. If you run Claude Code or Codex
CLI you already have Node. There is nothing else to install up front, and **no background
service**: your agent starts the server when its session opens and it exits when that
session ends.

The npm package and the plugin registry listing land with the first tagged release. Until
then, follow [Build from source](#build-from-source) instead of steps 1 and 2.

**1. Install the plugin in Beekeeper Studio.** Tools -> Manage Plugins, find Gatekeeper,
Install. Until the registry entry is merged, download `gatekeeper-<version>.zip` from the
[latest release](https://github.com/Gldywn/gatekeeper/releases/latest), extract it into
Beekeeper's plugins folder as a directory named `gatekeeper` (the folder name must match
the manifest `id`), and restart Beekeeper:

| OS | Plugins folder |
|---|---|
| macOS | `~/Library/Application Support/beekeeper-studio/plugins/` |
| Linux | `~/.config/beekeeper-studio/plugins/` |
| Windows | `%APPDATA%\beekeeper-studio\plugins\` |

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

Any client that reads `.mcp.json` can use [`.mcp.json.example`](./.mcp.json.example) as-is.

Pin the version if you would rather audit upgrades than receive them:
`npx -y @gldywn/gatekeeper-mcp-server@0.1.0`. Unpinned, `npx` re-resolves the latest release
on every agent launch, which keeps you current but means a process with a path to your
database changes under you. Pinning also skips a registry round-trip at each start.

**3. Start your agent once.** This launches the server, which starts the local broker on
`127.0.0.1:9999`. Nothing answers on that port until the server has run once; open the
plugin before that and it tells you so rather than showing a pairing field it cannot
honour.

**4. Pair the plugin.** Open Gatekeeper from Beekeeper's Tools menu, then ask your agent
for anything that needs the database. Until the plugin is paired every Gatekeeper tool
fails with a 6-digit code: type that code into the plugin. It is single-use, lasts about
five minutes, and `http://127.0.0.1:9999/pair` always shows the current one (the plugin
can open that page for you). The capability token it hands over is stored in Beekeeper's
encrypted storage, once per machine, so this is a one-off.

**5. Install the agent skill** so your agent knows how to drive the tools well:

```bash
npx skills add Gldywn/gatekeeper
```

**6. Use it.** Ask your agent for something that needs the database. It proposes SQL, the
query appears in the plugin, you approve it, and the rows return to the agent. Reads work
by default; a write runs only once you arm Write or Destructive mode in the plugin.

### Build from source

For contributors, and the fallback until the first release is published:

```bash
pnpm install
pnpm build
```

Then register the built entrypoint instead of the npm package, by absolute path:

```bash
claude mcp add gatekeeper -- node /absolute/path/to/gatekeeper/packages/server/dist/index.js
```

For the plugin, symlink `packages/plugin/` into Beekeeper's plugins folder (see the table
above) under the name `gatekeeper`, so a rebuild is picked up without reinstalling.

### Environment variables

- `GATEKEEPER_TOKEN`: use a fixed token instead of the generated file.
- `GATEKEEPER_BROKER_PORT`: broker port (default `9999`). The plugin always talks to
  `9999`, so changing this breaks pairing with no clear error. Leave it alone unless you
  are developing against a second instance.
- `GATEKEEPER_DB`: SQLite path (default `~/.gatekeeper/requests.db`).

## Repo layout

```
packages/
  server/
    src/
      index.ts       broker + MCP wiring, token, shutdown
      broker.ts      loopback HTTP endpoints
      mcp.ts         MCP tools
      pairing.ts     pairing gate on every tool, agent-facing notice
      pairing-page.ts  the CORS-free page that shows the code
      service.ts     submit / get / cancel, ticket shaping, read-only preflight
      store.ts       durable SQLite lease queue + audit trail
      connection.ts  non-sensitive connection snapshot
      policy.ts      server-side advisory risk classifier (blocks empty/multi-statement)
      config.ts      environment and constants
  plugin/
    manifest.json
    index.html
    src/
      app.ts         UI, polling, lease renewal, approve / reject, history
      sql/classify.ts  dialect-aware risk classifier (the execution gate)
      sql/sanitize.ts  surfaces bidi/invisible chars in displayed SQL
      result.ts      result caps (local history + agent-bound)
      style.css
    DESIGN.md        plugin design system
  shared/
    src/index.ts     wire-contract types shared by server + plugin
    tokens.css       design tokens shared by plugin + landing
landing/             marketing site (not part of the shipped product)
skills/gatekeeper/   the agent skill, installed with `npx skills add`
docs/RELEASING.md    release runbook + plugin registry submission
.github/workflows/   release-please, plugin release assets, npm publish
.mcp.json.example    MCP client stub
biome.json           lint + format
SECURITY.md          supply-chain policy + DB boundary
```

## Development

```
pnpm build     # build both packages
pnpm test      # server + plugin test suites (vitest)
pnpm lint      # biome check
pnpm format    # biome format --write
pnpm ci        # typecheck + build + test
```

Releases are conventional-commit driven; see [`docs/RELEASING.md`](./docs/RELEASING.md)
for how a version reaches the Beekeeper plugin manager and npm.

## Tech stack

- **Plugin:** TypeScript, Vite, `@beekeeperstudio/plugin`, `node-sql-parser`. Requires
  Beekeeper Studio >= 5.4.
- **Server:** TypeScript, `@modelcontextprotocol/sdk`, `better-sqlite3`, Node's built-in
  `http`. Published to npm as `@gldywn/gatekeeper-mcp-server`. Requires Node >= 22, the floor
  at which `better-sqlite3` ships a prebuilt binary so `npx` needs no C++ toolchain.
- **Tooling:** Biome (lint + format), Vitest, pnpm workspaces with an exact-pin,
  quarantined supply-chain policy.

## References

- Plugin API: https://docs.beekeeperstudio.io/plugin_development/api-reference/
- Plugin architecture: https://docs.beekeeperstudio.io/plugin_development/
- MCP: https://modelcontextprotocol.io
