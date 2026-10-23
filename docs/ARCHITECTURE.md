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
3. The human approves or rejects, or explicitly enabled Auto mode approves an eligible read.
   On approval the plugin calls `runQuery(sql)` (Channel 1);
   Beekeeper runs it on the user's connection.
4. The plugin posts the outcome to `POST /result` (Channel 2).
5. The agent reads the outcome with `get_query_result(request_id)`, optionally waiting up to
   a bounded window.

Because submit and read are separate, an agent can keep several proposals in flight and
collect each result as its human decision lands. Approval is **pre-execution**, on the SQL
text.

## Access modes

Approval is manual by default; Execution mode decides which risk classes may run:

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

Auto mode beta is a separate ephemeral toggle that forces Read only. Confirming a switch
to Write or Destructive disables Auto mode before arming the selected mode. Cancelling
the confirmation leaves Auto mode active. Its PostgreSQL-only subset requires successful parsing, complete catalog
metadata, local sensitivity checks and a pinned Jev evaluation. Provider errors or concerns
leave manual controls available. The plugin and broker revalidate authority after awaited
operations. See [Auto mode](AUTO-MODE.md) for the supported subset and sharing boundary.

## Connection check

Beekeeper's plugin API has no connection event, so the plugin checks itself. It re-reads
`getConnectionInfo()` every 5 seconds (switches, Beekeeper's read-only mode) and, on
PostgreSQL, MySQL and MariaDB, runs one fixed scalar read-only probe every 15 seconds while
Beekeeper's window is visible and the Gatekeeper view has a size on screen, never two at
once. `runQuery` takes no connection id, so each check re-reads the connection first and
picks its SQL from the engine it gets back. The probe's verdict feeds the endpoint
read-only layer and the card gates; its outcome (passed, failed, three failures in a row) is
the dot on the header's database icon. A failure says only that the check failed, not why.
See [`SECURITY.md`](../SECURITY.md).

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
If final authority checks stop a reserved execution before `runQuery`, the plugin uses
`POST /execution/withdraw` to return it to `leased`. Available evaluation and approval
attribution are kept in `policy_json`, independently of result-row retention.

## Stopping a running query

The plugin API has no cancel, so on PostgreSQL and MySQL the approved statement runs behind a
comment tag and the human's Stop (or their auto-stop limit) sends a second, fixed `runQuery`
that asks the database to cancel the session running the tagged statement. The broker sees
no new state: a query that fails after a stop request ends `failed` with an error starting
"Stop requested", and one that completes anyway returns its result. Details and the
residual case are in [`SECURITY.md`](../SECURITY.md#stopping-a-running-query).

## Result caps

The plugin caps the rows it forwards to the agent (10,000 rows, 8 MiB counted in UTF-8 bytes over
the whole result) so a bulk read never floods the agent context or the LLM provider. The agent
still learns the true size: `terminal.truncated` says it capped and `terminal.rowCount` is the
true pre-cap total. The kept copy (see Retention) is this same capped result.

## Versions

Every build is stamped by `scripts/build-identity.mjs`: a release only when a release
workflow built it (`GATEKEEPER_RELEASE_TAG`), otherwise dev, with its commit and branch when
git can tell. The server sends its stamp on every authenticated broker answer as the
`X-Gatekeeper-Server` header (URI-encoded JSON, set after the bearer check, so an unpaired
caller never sees it). The plugin reads it off its 1 Hz `/pending` poll, so a new broker
owner shows within a second. A release build of the plugin also asks GitHub once per start
for the latest release (see [`SECURITY.md`](../SECURITY.md), Network).

The bottom-left indicator and Settings > Version compare the three. A side behind the other
is a warning, with what to do; both sides behind the latest release is only news; a dev
build on either side gets no advice. A server that sends no header, or one the plugin
cannot reach, shows as unknown.

## Retention

The agent-facing technical audit records the lifecycle (decision, timestamps, SQL digest,
row count) with no raw SQL and no rows. Those events expire after 24 hours. Decided requests
remain indefinitely in the local store, including SQL, intent, state, timestamps, session
metadata and Auto mode records; the store itself refuses to delete a request
(`requests_keep`) once a current server has opened it, so a server from before 0.3.0 cannot
purge them. Referenced sessions survive cleanup.

Every approved result is kept twice, for two readers.

- **The agent's copy**, in `requests.result_json`, in clear, is what `get_query_result` reads.
  Its rows and fields are stripped 10 minutes after the decision. The remaining result contains
  `purged: true` and any known `rowCount` (returned rows) and `affectedRows` (changed rows).
  Late agent reads still receive those scalars. Missing counts remain unknown, including for
  results purged by older versions. A known zero remains zero. This window is the agent's whole
  access: no MCP tool reads the kept copy below.
- **The kept copy**, in the `results` table, is the same result sealed by the plugin and kept
  for good. The plugin gzips it and encrypts it with AES-256-GCM under a key that lives only in
  Beekeeper's encrypted plugin storage, bound to the request id, and posts it with the decision
  (`/result` field `archive`). A sealed copy the server accepts is stored in the same transaction
  as the decision, so an accepted copy never goes missing; one it refuses (malformed, or over
  9 MiB) is dropped and the decision still lands. If sealing fails, the agent still gets its rows
  and only the kept copy is missing. The server cannot read it; the plugin
  fetches it with `GET /results/:id` (same scope as `/activity`, approved requests only) and
  opens it. It holds exactly what the agent was sent: at most 10,000 rows and 8 MiB, counted in
  UTF-8 bytes over the whole result, so the history never shows a row the agent did not get.
  Decisions from before this copy existed have none, and rows already stripped cannot be
  recovered. A server from before this copy ignores it, so results decided while such a server
  holds the broker port keep none: update the server with the plugin, or before it.

Keys are written once each under their own id (`gatekeeper.history.key.<id>`) and a pointer names
the one to use, so two tabs creating a key at once leave two valid keys, never a lost one. Every
envelope carries the id of its key. What this protects, and what it does not, is in
[`SECURITY.md`](../SECURITY.md#data-at-rest-and-in-flight).

The host-side Audit Trail reads the retained history in pages of 200 entries, scoped to the
current connection plus unscoped requests. `GET /activity` answers `{ activity, more }`, and
`?before=<decidedAt>&beforeId=<id>` continues strictly older than that entry, as an index range
seek in both scopes, so a deep page costs the same as the first. The plugin shows whole days
only: it holds back the oldest day of a page until a later page or the end of history proves it
complete, and loads the next days as the list end scrolls into reach. A folded day ships as its
header only; its rows are built the first time it opens. The PII, Value and Client flags come
from `policy_json.sensitivity`, three booleans the plugin freezes from its card analysis when
`/executing` or `/result` records the decision (while the request is executing, a later
`/result` never overwrites the `/executing` one), or from the SQL text alone when nothing was recorded, so opening the trail
never queries the connected database. Each entry says whether its sealed rows were kept
(`kept`) and, for a decline, who declined (`declinedBy`: a person, or the plugin's gate refusing
to run an approved statement); an unmarked older decline names no one. An entry opens in the same
detail as Recently resolved, its kept rows fetched and opened on demand. A separate partial index
covers results awaiting purge.

Recently resolved is the newest end of the same history: `GET /activity?limit=<count>` (clamped
to 1..200), read on load, after each decision, on return to the Queue and every 5 seconds while it
shows. A decision this tab just made is listed at once, without its rows, from the moment the
server acknowledges it until the server's page lists it; an ending the server did not acknowledge
(a lost lease, a result whose delivery is unconfirmed) stays in the open pane only, until the
server's own record of that request replaces it. The plugin holds rows only for what is open:
the selected entry of each list and a result being opened. See [`SECURITY.md`](../SECURITY.md)
for local data handling.
