# Security

Gatekeeper requires human approval by default for SQL statements an AI agent proposes,
and runs the approved statement through Beekeeper Studio's existing connection so the
agent never holds credentials. This document states what that guarantees, where the
trust boundaries are, and the limitations worth knowing before you rely on it.

## Threat model

Agents propose SQL on a connection the human controls. The agent is treated as untrusted
input. Explicitly enabled Auto mode beta delegates approval of a restricted read subset
to deterministic checks and an additional evaluator. See [Auto mode](docs/AUTO-MODE.md).

- **Human approval is the default boundary.** Auto mode is an explicit, ephemeral
  delegation that permits eligible reads without another click. Writes always require
  human approval. Confirming Write or Destructive disables Auto mode before arming that
  execution mode. Cancelling the confirmation preserves the current mode.
- **The agent never holds credentials.** Queries run through Beekeeper's already
  authenticated connection. For a hard backstop, point Beekeeper at a read replica or a
  role with only the privileges you are willing to approve.
- **Out of scope.** Gatekeeper does not defend against a compromised Beekeeper Studio, a
  malicious human approver, or another process running as the same OS user as the broker
  (see [Same-user trust boundary](#same-user-trust-boundary)).

## Access modes

Execution mode decides which risk classes can run. Manual approval is required unless
Auto mode is explicitly enabled and its stricter read-only conditions all pass.

- **Read** (default): only reads can be approved.
- **Write**: an `INSERT` / `UPDATE` can be approved, with a second confirmation by default.
- **Destructive**: a `DELETE` / `DROP` / `TRUNCATE` / `ALTER` can be approved, with a
  second confirmation by default.

The armed mode is in memory only. It is never persisted, and it resets to read-only on a
connection switch or a re-pair. The plugin re-classifies the statement and re-checks the
armed mode at the moment of execution, so arming and disarming take effect immediately.

### Read mode is not a zero-side-effect guarantee

Read mode limits the statement *shape* to a read, not its runtime effects. A `SELECT` can
still call a volatile or privileged function that writes or reads outside the row set, for
example `nextval()`, `pg_terminate_backend()`, or `pg_read_server_files()`. A static parse
cannot see that. These run under read mode with a single approval and no destructive
confirmation, so **the human approval on the visible SQL is the real backstop**: read the
statement, and use a least-privilege database role so such functions are simply not
available to the connection.

## Risk classification

Two classifiers agree on the read / write / destructive classes:

- The **plugin** classifier is authoritative, because the plugin is the only component
  that runs SQL. It parses each query in the connection's dialect with `node-sql-parser`,
  escalates the class on any embedded modifying node (a CTE, a subquery, `SELECT ... INTO`,
  `EXPLAIN ANALYZE` of a write, a locking read), and fails closed to **destructive** when a
  parse fails or a statement is unrecognized.
- **A failed parse raises the class; it does not block the query.** `node-sql-parser` knows
  no `DROP DATABASE`, `VACUUM`, or `ALTER SYSTEM`, and blocking them outright made the
  archetypal destructive statement unapprovable in the very mode built to gate it. Such a
  statement is classed destructive, so it still needs Destructive mode armed plus the
  confirmation where the human types the database name, and its card carries a standing
  warning that Gatekeeper could not read it and the judgement is theirs. What no mode can
  approve is unchanged: empty input, and anything holding more than one statement.
- The **server** classifier is advisory. It stamps the audit trail and refuses the two
  cases no mode may approve: empty and multi-statement input.

**MySQL executable comments.** MySQL and MariaDB run the body of a `/*! ... */` comment,
unlike an ordinary comment. Both classifiers keep that body when scanning, and the plugin
never lets a modifying keyword hidden inside such a comment ride in under a read verdict;
it escalates to destructive so a human must arm and confirm it explicitly.

**Trojan-source text.** Unicode bidirectional overrides and other invisible formatting
characters can make submitted SQL render in an order the reviewer never approved. The
plugin surfaces every such character as a visible `[U+XXXX]` marker in the card, the Audit
Trail, and every export, so the human sees exactly what was submitted. The executed SQL is
never altered by this display step.

## Stopping a running query

Beekeeper's plugin API cannot cancel a query it is running, so on PostgreSQL and MySQL the
plugin asks the database itself. On those connections the approved statement is sent behind
an ordinary leading comment, `/* gatekeeper <request id> <random token> */`, with a token
drawn fresh for each execution. The statement after it is the one the human approved and the
classifier read, byte for byte. The comment is visible to anyone who can see the database's
running queries or its logs.

A stop is triggered only by the operator: the Stop button, or an auto-stop limit they set per
connection in Settings. An agent cannot trigger one, and `cancel_query` still refuses an
executing query. The stop is fixed SQL built by the plugin, not by an agent, and runs
through `runQuery` outside the approval gate, like the endpoint read-only probe:

- **PostgreSQL 10 and later**: one `SELECT` that reads `pg_catalog.pg_stat_activity` and calls
  `pg_cancel_backend` only when exactly one active client session of the same login role is
  running a statement that starts with this execution's comment. Parallel workers report the
  leader's text, so they are left out of the count; cancelling the leader stops them.
- **MySQL 8.0.19 and later**: one batch that looks the session up in
  `information_schema.PROCESSLIST` the same way and prepares `KILL QUERY` for it, or a no-op
  when anything other than exactly one session matches. `KILL QUERY` stops the statement and
  leaves the connection open. Older MySQL, MariaDB, TiDB and MySQL connections in Beekeeper's
  read-only mode (which refuses `KILL`) do not offer Stop.
- PostgreSQL before 10 and every other database type do not offer Stop.

Both servers ignore a cancel that reaches a session sitting idle, and do not carry it over to
the session's next statement (PostgreSQL `postgres.c`, MySQL 8.0.19+ `sql_class.cc` and
`sql_parse.cc`). One case remains that no plugin can rule out: the cancel signal targets a
session, not a statement. If the query ends on its own between the moment the database finds
it and the moment the signal is sent, and that same session has already started another
statement, that other statement is cancelled instead. With a direct connection the other
statement can only come from the same Beekeeper connection pool; behind a pooling proxy
(PgBouncer in transaction mode, RDS Proxy, ProxySQL) it can belong to another application.
Beekeeper's own Cancel button has the same property, since it also cancels by session.

When a query fails after a stop was requested, the agent sees `failed` with an error that
starts with "Stop requested", says who asked, then quotes what the database returned.
Gatekeeper never claims the request caused the failure, and the effect of a write that failed
this way is unknown. A query that completes despite the request returns its result as usual,
since a stop that lands late changes nothing. Auto-stop is an attempt, not a guaranteed
time limit: it runs only while the Gatekeeper tab is open, and the stop itself waits for a free
connection in Beekeeper's pool.

## Load check

Before approval, the plugin estimates whether a proposal could load or lock the database and
shows a Heavy query alert on its card. It is a warning, not a guarantee. A read filtered on an
indexed column can still scan most of a table and shows no alert.

- **The proposal is never run, planned or explained before approval.** The PostgreSQL planner
  evaluates IMMUTABLE and STABLE functions while it plans, and `EXPLAIN` takes the locks of the
  statement it wraps, so an automatic `EXPLAIN` would let agent text reach the database before
  any decision.
- **What runs automatically** is one catalog read built by Gatekeeper, after the same search
  path check Auto mode uses. It reads row estimates from `pg_class.reltuples`, summed over its
  `pg_inherits` children. Autovacuum never analyzes an empty or tiny table, so for a table never
  analyzed it reads the statistics counter `pg_stat_get_live_tuples`, 0 included, while
  `track_counts` is on.
  Relation names travel as escaped literals, and none of these reads locks a user table. Index
  lists come from Beekeeper's `getTableIndexes` (Beekeeper 5.5 and later), for large tables only.
- PostgreSQL gets every rule. Other engines get only the rules that read the SQL alone, which
  flag `UPDATE` or `DELETE` without `WHERE` and sources that no join condition links.
- **Auto mode** holds a query with an alert before anything is sent to TypeSafe. History keeps
  the fixed reason `Heavy query`, never a table name. A check that could not finish (a view, an
  unknown size, a late catalog read) blocks nothing, with or without Auto mode, and shows
  nothing on the card.
- **Auto-deny heavy queries** (Settings, on by default) rejects a flagged query as soon as its
  card arrives, without a human in the loop. A finding that depends on a missing row estimate
  never auto-denies. The automatic rejection itself tells the agent that its query was judged
  heavy, so by trying variants an agent can learn whether a table holds over a million rows or
  whether a filtered column has no index. Turn the setting off to keep that signal behind a
  human decision.
- **On a rejection**, the agent receives the operator's note, then hints computed from the
  SQL text alone (no `WHERE` clause, missing join condition, DDL without `CONCURRENTLY`), the
  same whatever the database holds. Row estimates, index facts and sensitive-data flags never
  leave the plugin. The history detail shows the exact text sent.

## Same-user trust boundary

The broker requires an `Authorization: Bearer` capability token on every request. It is
generated on first run and stored at `~/.gatekeeper/broker-token` with mode `0600`, inside
a `~/.gatekeeper` directory created `0700`; the plugin keeps its copy in Beekeeper's
encrypted storage.

That token protects the broker from *other users* and from remote callers. It does **not**
create a boundary between the agent and the gate when both run as the **same OS user**: any
process running as that user can read the token file and call the broker. Such a process
could read other sessions' proposals and the audit feed (which carries raw SQL), post
fabricated results, or spoof the connection snapshot. Only the plugin executes SQL, after
human approval or an active Auto mode decision. A same-user process can also spoof broker
evaluation replies; Auto mode does not establish a new same-user security boundary. If you need the agent and
the gate isolated, run them under different OS users. Hardening this into a separate
plugin-side secret is planned for a later release.

## Pairing

The broker cannot distinguish its plugin from any web page the human happens to have open:
both are browser contexts issuing the same loopback requests. A route that handed out the
capability token without proof would hand it to every page too, so the token crosses over
on the one channel a page cannot observe, the human's eyes.

- **A 6-digit code**, single-use, valid five minutes, invalidated after five wrong guesses,
  and metered by a guess budget so a page cannot grind through the space by forcing fresh
  codes. No code exists at all while a plugin is actively authenticating.
- **The page that displays it carries no CORS headers**, so a cross-origin caller never
  gets to read the body. A top-level navigation needs none.
- **The exchange route keeps CORS**, because the plugin's iframe has to read its answer.
  Its defence is the code, the attempt cap and the budget; it is deliberately the only
  unauthenticated route that returns anything secret, and it returns it once.

The code reaches the human through the tool result of any Gatekeeper call made while
unpaired: harnesses funnel MCP stderr into logs nobody reads, and a tool result is the one
channel that surfaces everywhere. On clients that advertise elicitation, the server also
opens the pairing page through an MCP URL-mode elicitation, which the spec added for
exactly this (an out-of-band exchange that must not pass through the client); the code
itself is in neither the URL nor the prompt.

## Network

- **Loopback only.** The broker binds `127.0.0.1`.
- **DNS-rebinding defense.** It rejects any request whose `Host` header is not the
  expected loopback host (`421`).
- **One request beyond loopback, read-only.** A release build of the plugin asks GitHub
  for the latest Gatekeeper release once when it starts:
  `GET https://api.github.com/repos/Gldywn/gatekeeper/releases/latest`, a constant in
  `packages/plugin/src/version.ts`, with a 5-second timeout, no cookies and no referrer.
  Gatekeeper attaches no token, no session or build identifier, nothing about your
  connections and no SQL; GitHub receives the usual network and browser metadata (IP
  address, User-Agent, Origin). The plugin keeps only the release tag from the answer. No
  release asset or code is downloaded, nothing is installed, and Gatekeeper never updates
  itself: updating stays a manual step. Dev builds skip the request.

## Data at rest and in flight

- **Result caps.** The plugin caps the rows it forwards to the agent, by count and by
  serialized size, so a bulk read never floods the agent context or the LLM provider, and
  never overruns the broker body limit. The agent still learns the shape: the result
  carries `truncated` and the true `rowCount`, and the human sees the cap in the history
  row.
- **Cleartext local store.** Proposals live in a SQLite database under `~/.gatekeeper`
  (`0700`). That database holds proposal SQL, intent and engine errors, which can contain
  personal data. Returned rows and fields remain for the approved-result window. The
  database is local and owner-only, but it is not encrypted at rest by Gatekeeper.
- **Retention.** Approved result rows and fields are stripped 10 minutes after the
  decision. Decided requests remain indefinitely with SQL, intent, state, timestamps,
  referenced session metadata, Auto mode attribution and available `rowCount` and
  `affectedRows` scalars. Technical lifecycle events in `audit` and inactive sessions
  unreferenced by any request expire after 24 hours. The Audit Trail pages through the
  connection's whole retained history. There is no manual deletion feature yet. Versions
  up to 0.2.0 deleted decided requests after 24 hours, also when such a server kept running
  beside a newer one on the same database, so stop every server when upgrading (the
  `update-gatekeeper` skill does). Requests they deleted and counts they purged cannot be
  recovered.
- **Engine errors.** A failed query's engine error is returned to the agent and recorded
  in the audit trail. Engine errors can echo fragments of the query or schema; treat them
  as query-derived data, not as a trusted channel.
- **Connection check.** On PostgreSQL, MySQL and MariaDB the plugin runs one fixed scalar
  query on the connection, outside the approval gate, to read whether the endpoint is
  read-only: up to once every 15 seconds while Beekeeper's window is visible and the
  Gatekeeper view has a size on screen, plus right after an approved query fails. It can run
  alongside an approved query. It reads no table. Its result and any driver error stay in the plugin
  popover and are never sent to the broker or the agent.

## Audit trail

- The **agent-facing** surfaces never return another session's raw SQL: `poll_results`
  returns states only, and the server audit log stores a SQL *digest*, not the text.
- The **human-only** Audit Trail in the plugin (served host-side, under the same auth and
  connection scoping) does show the raw SQL, because it is the operator's own review view.
  Its Markdown, CSV, and JSON exports carry the SQL with formula-injection and
  trojan-source guards applied, and never include result rows.
- Its PII, Value and Client flags never query the connected database. The plugin posts them
  with the decision as three booleans (`policy_json.sensitivity`), never a table, column or
  value; requests decided before that, or never shown on a card, are
  flagged from their SQL text alone, which cannot see the columns behind a `SELECT *`.

## Supply-chain policy

- **Quarantine window.** No dependency version published less than 7 days ago is installed
  (`minimumReleaseAge`), so a freshly published malicious version cannot land immediately.
  Transitive deps caught inside the window are pinned to their newest >= 7-day-old release.
- **Blocked install scripts.** Post-install and build scripts are blocked by default; only
  a short, audited allowlist of native builds (`esbuild`, `better-sqlite3`) may run.
- **Pinned toolchain.** `pnpm` is version-pinned via `packageManager`, and the lockfile is
  committed, so every install resolves the same audited tree.
- **The macOS notification helper.** The package ships one executable, a small signed
  `.app` built from `packages/server/notifier/main.swift` in CI. It is ad-hoc signed, which
  carries no Team ID, so another ad-hoc binary claiming the same bundle identifier could
  post notifications under this name once you have granted the permission. A click on a
  banner relaunches the helper without arguments, and the shipped helper then opens Beekeeper
  Studio by its fixed bundle identifier, interpreting nothing from the notification.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through this repository's GitHub
Security Advisories ("Report a vulnerability"), rather than opening a public issue.
