# Architecture

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

## Two channels (the core mental model)

The plugin runs inside a sandboxed iframe. It cannot *receive* inbound connections (it can
never be a server), but it can *initiate* outbound ones like any web page. There are two
separate pipes, and the plugin glues them:

- **Channel 1, plugin to Beekeeper** (`postMessage`): the `@beekeeperstudio/plugin` API.
  `runQuery`, `getConnectionInfo`, `appStorage` live here. Fully internal to Beekeeper.
- **Channel 2, plugin to broker** (`fetch` over `http://127.0.0.1`): a plain web request.
  The plugin is the **client** and **pulls** work by polling the broker. Nothing is ever
  pushed into the iframe, which is what makes the design sandbox-compatible.

## The loop (non-blocking)

1. The agent calls `submit_query(sql, intent)`. The server enqueues the proposal and returns
   a `request_id` immediately; it does not block.
2. The plugin polls `GET /pending`, claims the oldest proposal under a lease, and renders the
   SQL.
3. The human approves or rejects. On approval the plugin calls `runQuery(sql)` (Channel 1);
   Beekeeper runs it on the user's connection.
4. The plugin posts the outcome to `POST /result` (Channel 2).
5. The agent reads the outcome with `get_query_result(request_id)`, optionally waiting up to
   a bounded window.

Because submit and read are separate, an agent can keep several proposals in flight and
collect each result as its human decision lands. Approval is **pre-execution**, on the SQL
text.

## Access modes

Every query is approved by a human click on its text; the armed mode decides which risk
classes that click may approve:

- **Read** (default): only reads can be approved. Writes and destructive statements show but
  their Approve button is blocked until the matching mode is armed.
- **Write**: an `INSERT`/`UPDATE` can be approved, with a second confirmation by default.
- **Destructive**: a `DELETE`/`DROP`/`TRUNCATE`/`ALTER` can be approved, with a second
  confirmation by default.

The armed mode is in-memory only, never persisted, and resets to read-only on a connection
switch or a re-pair. The plugin re-classifies and re-checks the mode at the moment of
execution, so arming and disarming take effect immediately. Read is not a guarantee of zero
side effects: a `SELECT` can call a volatile function, so the human approval on the visible
SQL is the real backstop. See [`SECURITY.md`](../SECURITY.md).

## Where the risk gate lives

The plugin is the only component that can call `runQuery`, so the gate lives there:
`node-sql-parser` parses each query in the connection's dialect, classifies it read / write /
destructive (escalating on any embedded modify node, with a conservative fallback when
parsing fails), and only lets the human approve a class the armed mode allows. The server
also preflights with a regex to block empty and multi-statement input before enqueueing.

## Durability

Proposals live in a SQLite queue with a lease state machine
(`pending -> leased -> executing -> terminal`). A claimed proposal is leased to one plugin
for 30 seconds and renewed while its card is open. If a plugin dies mid-decision the lease
expires and the proposal is re-offered; if it dies mid-execution the proposal is failed as
`execution_unknown` and never re-run, so a query is never silently executed twice.

## Result caps

The plugin caps the rows it forwards to the agent (by count and bytes) so a bulk read never
floods the agent context or the LLM provider. The agent still learns the true size:
`terminal.truncated` says it capped and `terminal.rowCount` is the true pre-cap total.

## Retention

The agent-facing audit records the lifecycle (decision, timestamps, SQL digest, row count)
with no raw SQL and no rows. The raw SQL lives in the local queue and the human-only Audit
Trail until retention; approved result rows are stripped 10 minutes after the decision. See
[`SECURITY.md`](../SECURITY.md) for the at-rest window.
