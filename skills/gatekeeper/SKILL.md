---
name: gatekeeper
description: Read and change a database safely through Gatekeeper. You propose SQL, a human approves and runs it in Beekeeper Studio, and the rows come back to you; you never connect to the DB or run SQL yourself. Reads are the default; a write runs only if a human arms write mode. Use this whenever you need to read data, run a SELECT, inspect a schema, verify a migration, debug against real data, change data through an approved write, or answer anything that needs the database, and whenever the user mentions Gatekeeper, approving a query, or looking something up in the database.
version: 0.3.1 # x-release-please-version
---

# Gatekeeper

Gatekeeper is a bridge to a live database with manual approval by default. You **propose** SQL; the plugin runs approved queries in Beekeeper Studio and returns rows to you. You never hold credentials, connect to the database or run SQL yourself. Only the human can enable Auto mode beta for restricted reads. Never enable or configure it on their behalf, ask for its provider key, or treat agent intent as authorization. Writes always require human approval.

Use Gatekeeper whenever your task touches the database at all: reading data, exploring a schema, checking analytics, verifying a migration, debugging against real data, or making an approved change. It is the default path to the database, not a special case. If you are tempted to reach for a direct connection or your own credentials, use Gatekeeper instead.

## The waiting contract (read this first)

A query can require manual review even when the human enabled Auto mode. That takes seconds to minutes, and they may be away from the screen. Your job is to stay on the task until every query you submitted reaches a terminal state: `approved`, `rejected`, `failed`, `expired`, or `cancelled`. `pending`, `leased`, and `executing` are not answers; they mean keep waiting.

**Never end your turn while a query you submitted is non-terminal.** Once your turn is over the human's decision reaches no one, they have to re-prompt you, and in a headless or one-shot run the result is lost for good.

Two ways to wait, both correct, pick per situation:

1. **You still have useful work.** `submit_query` is non-blocking and returns a `request_id` at once. Keep making progress: read code, reason, prepare the next step, submit follow-ups. Then collect: one `poll_results` call tells you which of your queries resolved, and `get_query_result` reads a resolved one's rows. Repeat until nothing is non-terminal.
2. **Nothing left to do but wait.** Roll bounded waits: `poll_results({ wait_ms: 25000 })` for all your queries at once, or `get_query_result({ request_id, wait_ms: 25000 })` for one. Each call returns the instant the human decides, or after 25 seconds, whichever comes first. 25000 is the maximum the server accepts, and a larger value is rejected outright, so never try to wait longer in one call. When the wait runs out first, the call simply hands you back the same still-pending state. That is a timed checkpoint, not a decision. Call again, and keep calling until you get a terminal state. Several consecutive calls for one approval is the design, not a malfunction.

Why a short cap and a loop, rather than one long wait: every harness runs tool calls one at a time under its own per-call time limit (Codex cuts a tool call at 60 seconds by default, others allow more, some are undocumented). A 25 second wait fits inside every documented limit, and if some harness ever killed a wait call anyway, you would simply issue the next one. The loop, not one long wait, is what carries you across a human who takes minutes, and it is what makes the wait portable whatever limit your harness sets.

Rules that follow from the contract:

- Never conclude a query was refused because it has not resolved yet, and never stop to ask the human to tell you they approved it. The decision reaches you through your next `poll_results` or `get_query_result` the moment they click.
- `run_query` waits at most 25 seconds too and then returns whatever state it is in, still `pending` included. A pending return from `run_query` is not the result: keep waiting with `get_query_result` or `poll_results`.
- `expired` means the proposal outlived its window (about 15 minutes waiting unclaimed) before the human got to it. Re-submit it once and resume waiting, rather than dropping the task.
- `rejected` is an answer, so read the reviewer's message, adjust, then either propose again or explain the blocker to your user. A rejection can come from Gatekeeper's load check rather than a person ("Rejected automatically by the load check."), and a rejection of a query it flagged carries hints about your SQL, such as a missing `WHERE` clause or join condition. Narrow the query (a selective filter, a join condition, a `LIMIT`) instead of resubmitting the same statement.
- `failed` is an answer too: `terminal.error` says why, usually in the database's own words. Read it before anything else (see "When a query fails").
- A `failed` whose error starts with `Stop requested` means the human asked to stop the query while it ran, by hand or through an auto-stop limit they set, and the query then failed; the message says who asked, then quotes what the database returned, which may or may not be the cancellation itself. Never resubmit the same statement: propose a cheaper one (narrower filter, `LIMIT`, an indexed column) or ask your user. If it was a write, its effect is unknown, so check the data before anything else. A query that finished despite a stop request comes back `approved` as usual.

### Harness notes on waiting

Both patterns above work in every harness. Only the fine print differs:

- **Claude Code**: MCP calls run inside your turn. Since v2.1.212 a main-conversation MCP call that has been running for about two minutes moves to a background task, but a Gatekeeper wait can never last that long (the server caps it at 25 seconds), so backgrounding is not something you can lean on here. Roll the waits yourself.
- **Codex CLI**: MCP tool calls time out after 60 seconds by default (`tool_timeout_sec`), so never improvise a longer blocking call; a 25 second wait always fits. Nothing runs in the background: keep waiting inside your turn.
- **OpenCode**: no per-call MCP timeout or backgrounding is documented, so roll the waits in your own turn. Do not delegate the wait to a subagent: at best the rows land in the subagent's context instead of yours, and a subagent with its own MCP connection is a different Gatekeeper session, which cannot read your queries at all.
- **Cursor and Gemini CLI**: synchronous calls with generous limits (Gemini allows 10 minutes per call by default). Rolling waits work unchanged.
- **Click fatigue**: harnesses that confirm each MCP call (Cursor by default, Gemini unless the server is trusted, OpenCode with `ask` permissions, Claude Code under default permissions) can prompt the human on every poll. If that happens, ask the human once to auto-allow Gatekeeper's low-stakes tools, the read-only ones plus the session label: `poll_results`, `get_query_result`, `get_schema`, `get_connection_info`, `set_session_label`. Leave `submit_query` and `run_query` on manual approval; Gatekeeper already gates those with a human, so a second prompt buys nothing. This matters for the loop itself: a human who has given up clicking looks exactly like a human who has not approved yet.
- **Headless and one-shot runs** (`claude -p`, `codex exec`, `opencode run`, `gemini -p`): nobody is there to re-prompt you, so ending with a pending query loses the result permanently. Rolling waits are not optional there.

## Name your session first (required)

Before anything else, call `set_session_label` once with a short, human-readable label for this session, ideally the same title as your own session (a ticket id or the task you are on) so a human can correlate this agent with your session on their side. Name the whole task, not a single query, in a few words, and keep PII, credentials, and connection details out. Put any ticket, incident or PR id here, once, rather than in every query's intent. It shows in the human's connected-agents roster. **This is required: Gatekeeper rejects `submit_query` until a session label is set.** Update it if the task changes.

Examples: `Weekly active users by plan`, `Verify migration 0142 backfilled order_totals`, `Orders stuck in pending since 09:00`, `SUP-1042 login check for a locked-out customer`.

## Confirm which database you are on

`get_connection_info` tells you where the plugin is pointed right now: connection name, engine, database name, default schema, read-only, and the human's armed mode. The human can switch that connection in Beekeeper at any moment without telling you, because from their side they are simply doing other work.

Call it once before your first query and keep the three fields that identify the target: `connectionName`, `databaseType`, `databaseName`. Together they are the connection's identity; two connections sharing a display name but sitting on different engines or databases are not the same target.

Compare that to what your task implies, and only to that. If your task is about staging and the database reads like staging, say nothing and get to work. If your task is clearly about one environment and the connection points at another, ask the human plainly whether they are on the intended database before you propose anything. When your task says nothing about an environment, you have nothing to compare against: do not invent an expectation, and do not ask.

Read it again, on your own initiative, at the two moments where a switch is both likely and expensive:

- When you pick the task back up after a long gap, roughly ten minutes or more without a query, or any time you resume a session. That is exactly the window in which the human went and did something else, possibly against another database.
- Before proposing a write or a destructive statement, where being on the wrong database costs the most.

If any of those three identifying fields changed since you started, do not carry on quietly. Tell the human what the target was, what it is now, and ask whether to continue against the new one. Whatever they answer, the schema you read earlier describes the old database: call `get_schema` again before you write SQL against the new one. If nothing changed, say nothing: this check earns its place by being silent almost every time.

## If a call comes back NOT_PAIRED

The human's plugin is not connected to Gatekeeper yet. Reply with the 6-digit code from the error, ask them to type it into the Gatekeeper tab in Beekeeper Studio, then stop and wait for their confirmation. This is a one-off setup on their machine, not a fault in your query and nothing you can fix, so do not investigate it, do not retry the call, and do not open the pairing page yourself. If they tell you the plugin was never installed, or the Gatekeeper tools are not there at all, that is an install rather than a query, so hand it to the `install-gatekeeper` skill and stop, rather than improvising one yourself.

## Write the intent for a human, not a parser

The `intent` is the line a reviewer approves on, and the name the query keeps in the Queue, Recently resolved and the Audit Trail, whose rows cut it to one line. Write one short plain sentence, starting with a verb, that says what you want to accomplish in words someone who doesn't know the schema can judge. Aim for fewer than ten words when that stays clear, and use more only when needed. Add a reason only when it helps the reviewer judge the query.

The plugin already shows the agent and session context, so don't repeat it. Put ticket, incident and PR ids in the session label, not in the intent. For a write or destructive query, state what changes, its scope and any irreversible effect, that is what the human is gating. Don't restate the SQL or lean on table or column names. Never paste raw PII, secrets or record values; describe the record instead (`this customer`, `the two duplicate invoices`). Don't invent context you haven't verified, such as row counts or approvals.

Avoid the `Label: detail` shape (`Analytics: …`, `Note: …`) in the intent, the session label and your replies about queries. Write a plain sentence instead, or a plain title for the label.

- Bad: `Select count(*) from sessions group by plan`
  Good: `Count weekly active users by plan`
- Bad: `#5336 / #5761 end-of-day cross-check (wider time window)`
  Good: `Cross-check end-of-day totals over a wider time window`
- Bad: `#5761: prepare the list of the 6 refunds`
  Good: `List the six refunds to prepare`
- Bad: `Select * from orders where total is null`
  Good: `Find orders still without a total after the backfill`
- Bad: `Select status, last_login_at from users where email='jane@acme.io'`
  Good: `Check this locked-out customer's account status and last sign-in`
- Bad: `Update accounts set status active where id 4821`
  Good: `Reactivate only this account suspended by a false fraud flag`
- Bad: `Delete from events where user_id 10237`
  Good: `Permanently delete only this former user's events for their erasure request`

## The tools

- `set_session_label({ label })`: name this session. Required, and it must be your first call; queries are rejected until it is set.
- `submit_query({ sql, intent })`: propose one statement. Non-blocking: returns a `request_id` at once and nothing runs until a human approves it. You can keep several in flight (up to 32; past that a submission is rejected until one resolves). `intent` is the short sentence the human approves on (see "Write the intent for a human").
- `poll_results({ wait_ms? })`: one call returning the state of every query you proposed, plus a `pending` count. With `wait_ms` (25000 max) it returns the instant any pending one resolves, or at the cap; when it returns with `pending` above 0, call it again. States only, not rows.
- `get_query_result({ request_id, wait_ms? })`: read one query's outcome (rows if approved). With `wait_ms` (25000 max) it waits, bounded, for a decision. If it comes back `pending`, `leased`, or `executing`, call it again. Never treat a non-terminal return as an answer.
- `cancel_query({ request_id })`: withdraw a proposal you no longer need.
- `get_schema({ schema?, tables? })`: the connected database's structure (schemas, tables, columns with types, primary and foreign keys) and its `databaseType`, so you can write valid SQL without a probing round trip. No row data, and no human approval needed. Available only when the human has turned on Schema access. On a large database a call without arguments returns `mode: "index"`, table names with column counts only: call it again with the `tables` you need (exact, unqualified names, with `schema` passed separately) to read their columns. `hint` says when tables did not fit or were not found. `complete: false` (or `null`, unknown) or a table marked `incomplete` means part of the tables or columns could not be read, so a name missing there is not proof it does not exist; keys are best effort. The structure is as of `collectedAt`: a table created since (a migration run outside Beekeeper, or a statement you just got approved) can be missing until the plugin collects again, so after a schema change confirm with an introspection query instead of concluding the table is absent. Read it once and reuse it, and read it again when the connection changes under you.
- `get_connection_info()`: non-sensitive context about the connected database (dialect, database name, default schema, read-only, the human's armed mode, and whether a plugin is connected at all). Never host, user, or credentials. Informational only.
- `run_query({ sql, intent })`: submit plus a single bounded wait, for a quick one-off. It waits at most 25 seconds and then returns whatever state it is in, **which may still be `pending`**. Prefer `submit_query` plus the waiting patterns above, especially when you want more than one query in flight.

## Read results promptly

Approved rows are held for about 10 minutes and then stripped. If you poll, see `approved`, and only read the rows after a long detour, you get `purged: true` with an empty row set and have to propose the query again. Read a query's rows when it resolves.

The plugin also caps how many rows reach you, by count and by bytes, so a bulk read never floods your context. `truncated` says the cap fired and `rowCount` is the true total before it. A truncated result is a slice, not the answer: never conclude on it as if it were complete. Say what you actually got, then go back with something narrower, an aggregate, or an explicit `LIMIT`, so the shape of what you receive is your decision rather than the cap's.

An approved write returns no rows: read `affectedRows` for how many it changed. Treat a missing `affectedRows` as unknown, not as zero, and when you need certainty there, propose a read that checks the change.

## When to keep waiting, and the one time to stop

Keep rolling waits going for as long as the proposal can live. Slowness is never a no, and the one thing that justifies pausing to tell the user is a dead channel, not a slow human. If `get_connection_info` reports `connected: false`, or a `capturedAt` more than a few minutes old, the Beekeeper plugin is probably closed or disconnected and no approval can arrive. Say that plainly and let the user reconnect, instead of spinning. Do not confuse it with a human who is merely taking their time; for that one, you keep waiting.

## Modes: reads by default, writes are human-armed

Reads (one `SELECT`, or a read-only CTE) are always allowed. Writes (INSERT/UPDATE) run only if the human has armed **Write** mode, and destructive statements (DELETE/DROP/TRUNCATE/ALTER) only under **Destructive** mode. Those modes are off by default, ephemeral, and the human's decision, not yours. One statement per proposal, never several. Propose a write only when the task genuinely calls for it; expect it to sit pending until the human arms the matching mode, and make its `intent` state what changes and whether it's reversible. Whether to restrict what a query may read (personal data, for instance) is a policy of your task, not of Gatekeeper; follow your own instructions on that.

## Get the query right the first time

A query that fails on first run, or that a reviewer cannot follow, wastes a human round trip. Before proposing:

- Verify table and column names and their types; do not infer them. Call `get_schema` first, it costs no approval. Spell identifiers exactly as it reports them, and quote the ones that are mixed-case or reserved words.
- When Schema access is off, propose one introspection query against the engine's own catalog as your first query, asking only for schema, table and column names and types (itself PII-free): `information_schema.columns` where the engine has it, leaving out the engine's own catalog schemas (`information_schema`, `pg_catalog`, `sys`) rather than keeping only the default schema, since the tables you need may live in another one. On MySQL and MariaDB also add `table_schema = DATABASE()`, because their catalog spans every database the account can see. On SQLite, table names from `sqlite_master`, then `SELECT ... FROM pragma_table_info('<table>')` for a table it listed, never a bare `PRAGMA` statement, which Gatekeeper treats as destructive.
- Write in the dialect `databaseType` names (from `get_connection_info`): row limits, identifier quoting and date functions differ between engines. Qualify tables by schema when the database uses several, and cast literals to the column's type when the dialect is strict.
- Ask for the columns you need rather than `SELECT *`, and prefer a count or an aggregate when it answers the question just as well. Everything you pull back lands in your context and in front of the human who reads it before approving, and a wide read is also the one that trips the row cap.
- Write SQL a reviewer can follow top to bottom at a glance. Default to standard SQL and basic functions (`count`, `sum`, `coalesce`, `case`, `cast`), split a multi-step query into named CTEs that each do one thing, and prefer a join to a correlated subquery in the select list when it returns the same rows. Readable does not mean dumbed down, so keep the query as short as the question allows.
- Give each output column an alias that says what it holds (`verified_accounts`, `plan_code`), and keep words that read as personal or customer data (`email`, `phone`, `address`) out of an alias whose value holds none, since a reviewer reads such an alias as personal data.
- Keep constructs that not every engine supports (JSON operators, `FILTER`, `LATERAL`, array functions) for when no plain equivalent can answer the question or the construct is clearly more efficient on a large table, and say why in a few words of the intent.
- Give a clear `intent` (see "Write the intent for a human") so the human can approve at a glance.

## When a query fails

A `failed` result says why in `terminal.error`: usually the engine's own message, sometimes Gatekeeper's `execution_unknown`. What to do depends on what it says:

- An unknown table or column, or a syntax error: check the named identifier, and the current target, against the schema, then propose the corrected query. Resubmitting the same SQL fails the same way.
- A connection error says nothing about your SQL. Confirm the intended connection with `get_connection_info`; once the database connection is restored, a read can be proposed unchanged. A write may have landed before the connection dropped: treat it as below.
- `execution_unknown` means the plugin lost track of the query while it ran, so it may have executed. Never resubmit a write after it: first propose a read that checks whether the change landed, and if no read can tell, stop and ask the human.
