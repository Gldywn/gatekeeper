---
name: gatekeeper
description: Read a database safely through Gatekeeper. You propose read-only SQL, a human approves and runs it in Beekeeper Studio, and the rows come back to you; you never connect to the DB or run SQL yourself. Use this whenever you need to read data, run a SELECT, inspect a schema, or answer anything that needs the database, and whenever the user mentions Gatekeeper, approving a query, or looking something up in the database.
version: 1.0.0
---

# Gatekeeper

Gatekeeper is a human-approved bridge to a live database. You **propose** read-only SQL; a human reviews and runs it in Beekeeper Studio; the rows come back to you. You never hold credentials, never connect to the database, and never run SQL yourself. A human gates every execution, no exception.

## Name your session first (required)

Before anything else, call `set_session_label` once with a short, human-readable label for this session, ideally the same title as your own session (a ticket id or the task you are on) so a human can correlate this agent with your session on their side. It shows in the human's connected-agents roster. **This is required: Gatekeeper rejects `submit_query` until a session label is set.** Update it if the task changes.

## The tools

- `set_session_label({ label })`: name this session. Required, and it must be your first call; queries are rejected until it is set.
- `submit_query({ sql, intent })`: propose one read-only SELECT. Non-blocking: returns a `request_id` at once; the query does not run until a human approves it. `intent` is a one-line reason the human approves on.
- `poll_results({ wait_ms? })`: one call returning the state of every query you proposed (pending, approved, rejected, failed, ...). Optional `wait_ms` returns the instant any pending one resolves.
- `get_query_result({ request_id, wait_ms? })`: read one query's outcome (rows if approved). Optional `wait_ms` blocks (bounded) until it resolves.
- `run_query({ sql, intent })`: convenience wrapper, submit plus wait in one call. Prefer `submit_query` + `poll_results` when you want several queries in flight.
- `cancel_query({ request_id })`: withdraw a proposal you no longer need.
- `get_connection_info()`: non-sensitive context about the connected database (dialect, database name, schema, read-only). Never host, user, or credentials. Informational only.

## Work in parallel, never block for nothing

`submit_query` is non-blocking on purpose, so you stay productive while a human approves:

1. Submit your queries (one `submit_query` each).
2. Keep making progress: read code, reason, prepare the next step, propose follow-ups.
3. Check back with `poll_results` (one call tells you which resolved), and read a resolved one's rows with `get_query_result`.
4. Only when you have nothing else useful to do but still have a pending query, block on it with `get_query_result({ wait_ms })` or `poll_results({ wait_ms })`, which return the instant the human decides.

**Never end your turn with a query still pending.** Once your turn is over the human's approval can no longer reach you, and they would have to re-prompt you. Poll or wait first.

## Be patient: a pending query is not a no

A human may take minutes to approve, and may be away from the screen. Latency is normal. It is not a refusal, and not a reason to give up.

- A `wait_ms` that returns while the query is still `pending`, `leased`, or `executing` is a checkpoint, not a decision: wait again (rolling waits). Only a terminal state (`approved`, `rejected`, `failed`, `expired`, `cancelled`) is an answer.
- Never conclude a query was denied because it has not resolved yet, and never stop to ask the human to tell you they approved it. The result reaches you automatically through your next `poll_results` / `get_query_result` the instant they decide. Keep waiting.
- If a proposal comes back `expired` (the human did not get to it in time), re-submit it rather than dropping the task.
- If your harness can schedule a follow-up or run a background poll, use it to keep watching a pending query instead of ending. A pending query is to be actively awaited, not abandoned.

## Read-only

Gatekeeper enforces read-only: one `SELECT` (or a read-only CTE) per proposal. Anything that writes (UPDATE, DELETE, INSERT, DDL) is rejected, so do not propose writes. Whether to restrict what a query may read (personal data, for instance) is a policy of your task, not of Gatekeeper; follow your own instructions on that.

## Get the query right the first time

A query that fails on first run wastes a human round trip. Before proposing:

- Verify table and column names and their schema; do not infer them. Use `get_connection_info` for the dialect and default schema, and an `information_schema.columns` introspection (itself PII-free) when unsure.
- Qualify tables by schema when the database uses several, and cast literals to the column's type when the dialect is strict.
- Give a clear one-line `intent` so the human can approve at a glance.
