# Security

Gatekeeper puts a human approval in front of every SQL statement an AI agent proposes,
and runs the approved statement through Beekeeper Studio's existing connection so the
agent never holds credentials. This document states what that guarantees, where the
trust boundaries are, and the limitations worth knowing before you rely on it.

## Threat model

Gatekeeper is designed for one job: an agent can *propose* SQL, but only a human can
*run* it, on a connection the human controls. The agent is treated as untrusted input.

- **The human approval is the security boundary.** Every statement, including a read, is
  approved by a human click on its visible SQL text, before it runs. Nothing an agent
  sends executes on its own.
- **The agent never holds credentials.** Queries run through Beekeeper's already
  authenticated connection. For a hard backstop, point Beekeeper at a read replica or a
  role with only the privileges you are willing to approve.
- **Out of scope.** Gatekeeper does not defend against a compromised Beekeeper Studio, a
  malicious human approver, or another process running as the same OS user as the broker
  (see [Same-user trust boundary](#same-user-trust-boundary)).

## Access modes

Every query is approved by a human click; the *armed mode* decides which risk classes
that click is allowed to approve.

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

## Same-user trust boundary

The broker requires an `Authorization: Bearer` capability token on every request. It is
generated on first run and stored at `~/.gatekeeper/broker-token` with mode `0600`, inside
a `~/.gatekeeper` directory created `0700`; the plugin keeps its copy in Beekeeper's
encrypted storage.

That token protects the broker from *other users* and from remote callers. It does **not**
create a boundary between the agent and the gate when both run as the **same OS user**: any
process running as that user can read the token file and call the broker. Such a process
could read other sessions' proposals and the audit feed (which carries raw SQL), post
fabricated results, or spoof the connection snapshot. It still **cannot make SQL execute**,
because only the plugin, driven by a human click, runs queries. If you need the agent and
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

## Data at rest and in flight

- **Result caps.** The plugin caps the rows it forwards to the agent, by count and by
  serialized size, so a bulk read never floods the agent context or the LLM provider, and
  never overruns the broker body limit. The agent still learns the shape: the result
  carries `truncated` and the true `rowCount`, and the human sees the cap in the history
  row.
- **Cleartext local store.** Proposals live in a SQLite database under `~/.gatekeeper`
  (`0700`). Until retention, that database holds the raw SQL of each proposal (which can
  contain PII literals), and, for the approved-result window, the returned rows and any
  engine error. It is local and owner-only, but it is not encrypted at rest by Gatekeeper.
- **Retention.** Approved result rows are stripped 10 minutes after the decision.
  Terminal requests, the audit log, and dead sessions are dropped after 24 hours.
- **Engine errors.** A failed query's engine error is returned to the agent and recorded
  in the audit trail. Engine errors can echo fragments of the query or schema; treat them
  as query-derived data, not as a trusted channel.

## Audit trail

- The **agent-facing** surfaces never return another session's raw SQL: `poll_results`
  returns states only, and the server audit log stores a SQL *digest*, not the text.
- The **human-only** Audit Trail in the plugin (served host-side, under the same auth and
  connection scoping) does show the raw SQL, because it is the operator's own review view.
  Its Markdown, CSV, and JSON exports carry the SQL with formula-injection and
  trojan-source guards applied, and never include result rows.

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
  post notifications under this name once you have granted the permission.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through this repository's GitHub
Security Advisories ("Report a vulnerability"), rather than opening a public issue.
