# Gatekeeper

Human-approved, LLM-agnostic bridge for running **read-only** SQL through Beekeeper
Studio's existing database connection.

An MCP server lets any MCP client (Claude Code, Codex CLI, OpenCode, ...) propose a
SQL query. A Beekeeper Studio plugin surfaces that query for a human to approve. On
approval, the query runs on the connection Beekeeper already holds, and the result
flows back to the agent. The agent never holds database credentials, and no query
runs without a human looking at it first.

## Why

During investigations (support triage, debugging, data checks) an agent often needs
to read from the database. Today the human copy-pastes the agent's SQL into a client,
runs it, and pastes the result back. Gatekeeper automates that transport while keeping
the human as the approval gate:

- The human eyeballs every `SELECT` before it runs. That is the PII / safety check.
- Queries run through Beekeeper's already-authenticated, read-replica connection, so
  the agent never touches credentials.
- Read-only by construction (`SELECT`-only, enforced in the plugin).

## Architecture

Three components, two independent communication channels.

```
  MCP client (Claude / Codex / OpenCode)      Broker (localhost)            Beekeeper Studio
 ┌──────────────────────────────────┐   MCP  ┌──────────────────┐  fetch   ┌──────────────────┐
 │  run_query(sql, intent)          │ ─────► │ MCP server       │ ◄─────── │  Plugin (iframe)  │
 │                                  │        │ + HTTP broker    │  poll    │  1. show SQL      │
 │                                  │ ◄───── │ /pending /result │ ───────► │  2. human approves│
 └──────────────────────────────────┘  rows  └──────────────────┘  result  │  3. runQuery()    │
                                                                             │  4. post result   │
                                                                             └──────────────────┘
```

### The two channels (the key mental model)

The plugin runs inside a sandboxed `<iframe>`. It cannot *receive* inbound
connections (it can never be a server), but it can *initiate* outbound ones like any
web page. There are two separate pipes, and the plugin glues them:

- **Channel 1, plugin <-> Beekeeper** (`postMessage`): the `@beekeeperstudio/plugin`
  API. `runQuery`, `getTables`, `confirm()` live here. Fully internal to Beekeeper;
  never reaches the outside world.
- **Channel 2, plugin <-> broker** (`fetch` over `http://localhost`): a plain web
  request, unrelated to Beekeeper. The plugin is the **client**; it **pulls** work by
  polling the broker. Nothing is ever pushed to the iframe. This pull model is what
  makes the whole thing sandbox-compatible.

### The loop

1. An MCP client calls the `run_query(sql)` tool.
2. The MCP server (= the broker) enqueues the proposal and blocks.
3. The plugin polls `GET /pending` (Channel 2) and picks up the proposal.
4. The plugin renders the SQL. The human approves (or rejects).
5. On approval, the plugin calls `runQuery(sql)` (Channel 1). Beekeeper executes it on
   the user's connection.
6. The plugin posts the result to `POST /result` (Channel 2).
7. The broker unblocks the MCP call and returns the rows to the client.

Approval is **pre-execution**, on the SQL text: the human checks the `SELECT` for PII
before it runs. The result then flows back without a second gate (see MVP scope).

## MVP scope

**In:**

- Broker (localhost HTTP) + MCP server, in one process.
- Beekeeper plugin: poll, render SQL + intent, human Approve / Reject, `runQuery` on
  approve, post the result back.
- Read-only: `SELECT`-only, hardcoded in the plugin (the only component that can call
  `runQuery`), simple but with a clean extension point.

**Explicitly deferred (do not build yet):**

- Release-gate (a second human approval on the result rows). The human's eyes are on
  the `SELECT`, that is enough for now.
- Automatic PII linter. Replaced by human eyes.
- Auth on the broker. Localhost-only for the MVP.
- Multiple concurrent plugins / queue fairness.

## Design decisions

- **LLM-agnostic.** A standard MCP server, no vendor-specific code, no "Claude"
  anywhere. Any MCP client connects through its own `mcp_servers` config.
- **Reuse Beekeeper's connection.** `runQuery` executes on the connection the user
  already opened. Point Beekeeper at a read replica.
- **The plugin is the only DB touchpoint.** Since `runQuery` is only callable from the
  plugin, the `SELECT`-only guard belongs there, at the source.
- **Pull, not push.** The sandboxed iframe cannot receive inbound connections, so it
  polls the broker.

## Technical validation (already done, do not redo)

Verified against the Beekeeper Studio source (`master`):

- iframe: `sandbox="allow-scripts allow-same-origin allow-forms"`,
  `allow="clipboard-read; clipboard-write;"`
  (`apps/studio/src/components/plugins/IsolatedPluginView.vue`).
- `plugin://` scheme:
  `registerSchemesAsPrivileged([{scheme:'plugin', privileges:{secure:true, standard:true}}])`
  (`apps/studio/src-commercial/entrypoints/main.ts`). Real, secure, standard origin.
- No `connect-src` and no `Content-Security-Policy` anywhere in the repo.
- `http://localhost` is a "potentially trustworthy" origin, exempt from mixed-content
  blocking, so a secure `plugin://` context can fetch it.
- CORS is under our control (we own the broker): respond with
  `Access-Control-Allow-Origin` for the plugin origin (or `*`) and handle the `OPTIONS`
  preflight.

**Conclusion:** outbound `fetch` from the plugin to a localhost broker should work.
Confirm empirically with Spike B before building the full loop. Guaranteed fallback if
it is ever blocked: the clipboard bridge (clipboard access is explicitly granted to
the iframe).

## API contracts (MVP, a starting point)

MCP tool (agent-facing):

- `run_query({ sql: string, intent?: string })` -> `{ rows: object[], fields: {name: string}[] }`
  Enqueues a proposal, blocks until the human approves (returns rows), rejects
  (returns a rejection with reason), or it times out.

Broker HTTP (plugin-facing, bind `127.0.0.1`):

- `GET /pending` -> `{ id, sql, intent, createdAt }` or `204 No Content`
  Returns the oldest un-claimed pending proposal and marks it claimed. MVP: short-poll
  every ~1s.
- `POST /result` `{ id, status: "approved" | "rejected", rows?, fields?, error?, reason? }` -> `200`
  Resolves the blocked `run_query` call.

## Suggested repo structure

```
gatekeeper/
  README.md
  pnpm-workspace.yaml
  plugin/                Beekeeper Studio plugin (Vite + TS, based on bks-sample-plugin)
    manifest.json
    index.html
    src/main.ts
    vite.config.ts
  server/                broker + MCP server, one Node process
    package.json
    src/
      queue.ts           in-memory proposal queue + result resolution
      broker.ts          HTTP /pending, /result
      mcp.ts             MCP run_query tool (@modelcontextprotocol/sdk)
      index.ts           wires broker + mcp together
  .gitignore
```

Keep dependencies minimal. No UI framework required for the plugin MVP.

## Tech stack

- **Plugin:** TypeScript, Vite, `@beekeeperstudio/plugin`. Copy `bks-sample-plugin` as
  the starting skeleton. Requires Beekeeper Studio >= 5.4, Node >= 20.19.
- **Server:** TypeScript, `@modelcontextprotocol/sdk`, Node's built-in `http` (or a
  micro-framework) for the broker.

## Build path

1. **Spike A** - minimal plugin from `bks-sample-plugin`, a button that calls
   `runQuery('SELECT 1')` and renders the result. Proves Channel 1.
2. **Spike B** - from the same plugin, `fetch('http://localhost:9999/ping')` against a
   throwaway node server; confirm success in dev tools. Proves Channel 2. Fallback:
   clipboard.
3. **Spike C** - build the broker + MCP + polling + approval UI, wire the full loop
   end to end.

Start with Spike A.

## References

- Plugin API: https://docs.beekeeperstudio.io/plugin_development/api-reference/
- Plugin architecture: https://docs.beekeeperstudio.io/plugin_development/
- Sample plugin: https://github.com/beekeeper-studio/bks-sample-plugin
- MCP: https://modelcontextprotocol.io
