# MCP tools

The tools `@gldywn/gatekeeper-mcp-server` exposes to any MCP client. Every one of them is
gated on pairing: until the plugin is paired, each call fails with the 6-digit pairing code
instead of running.

- `submit_query({ sql, intent?, idempotency_key? })` -> ticket. Enqueues a proposal (a read,
  or a write for a human to approve under an armed mode) and returns immediately with
  `request_id` and `state`. Requires a session label first (see `set_session_label`),
  otherwise it is rejected. Reusing an `idempotency_key` with different SQL is rejected
  rather than silently returning the first statement's result.
- `get_query_result({ request_id, wait_ms? })` -> ticket. Reads a proposal, optionally
  waiting for a terminal state: `approved`, `rejected`, `failed`, `expired`, `cancelled`.
  Every wait is bounded by `MAX_WAIT_MS` (25s), so a wait that runs out returns the proposal
  in whatever non-terminal state it is in; the agent calls again to keep waiting.
- `poll_results({ wait_ms? })` -> `{ results, pending }`. The state of every query the
  session proposed recently, in one call, optionally waiting (same 25s bound) until any
  pending one resolves. States only; fetch a resolved one's rows with `get_query_result`.
- `cancel_query({ request_id })` -> ticket. Withdraws a pending or leased proposal.
- `run_query({ sql, intent? })` -> ticket. Convenience wrapper that submits and waits once,
  under the same 25s bound, so it can return a still-pending proposal rather than the result.
  It serializes one query at a time; prefer `submit_query` + `poll_results` /
  `get_query_result` for concurrency.
- `set_session_label({ label })` -> ok. Names the session with a short, human-readable label
  shown in the plugin's connected-agents roster. Required before any query: the server
  rejects `submit_query` until a session label is set.
- `get_connection_info()` -> snapshot. Non-sensitive context about the connected database
  (dialect, database, schema, read-only, the human's armed mode, captured-at). Never includes
  host, user, or credentials; informational only.
- `get_schema()` -> structure. The connected database's schemas, tables, and columns (with
  types and keys) so the agent can write valid SQL. Never returns row data, default values,
  view/function bodies, or comments. Engine catalogs are left out, since they dwarf the
  database's own tables, and the ones skipped come back in `excludedSchemas`. An agent that
  needs one reads it by proposing a normal query against it. Available only while the human
  has Schema access on for the connection; otherwise it reports unavailable.

## The ticket shape

A ticket is `{ requestId, state, createdAt, expiresAt, terminal? }`, where `terminal` carries
the `rows` and `fields` of an approved query. The plugin caps the forwarded rows so a bulk
read never floods the agent context: `terminal.truncated` says it capped and
`terminal.rowCount` is the true pre-cap total.

## The waiting contract

No call blocks for longer than `MAX_WAIT_MS` (25s). A wait that runs out is not a failure and
not a timeout error: it returns the proposal as it stands, and the agent decides whether to
wait again. This is what lets an agent keep working while a human takes minutes to approve,
instead of holding a request open or ending its turn.

The companion agent skill teaches that pattern (name the session up front, propose read-only
PII-free SQL, work in parallel while a human approves, collect results as they land). It
lives in [`skills/gatekeeper/SKILL.md`](../skills/gatekeeper/SKILL.md).
