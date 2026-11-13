# Auto mode

Policy `auto-v10` pairs the dependency-resolving PostgreSQL analysis (`shared-read-3`)
with four Jev questions and fixed cutoffs. It permits commercial amounts without personal
or company identity when every check passes. Its questions and cutoffs were measured live
on authored synthetic cases only (see "Verification and limits"), which is not a
calibration. The [evaluation bench](../packages/server/evals/README.md) holds those cases
and replays recorded probabilities against thresholds without further inference.

Auto mode is off after loading Gatekeeper. Hover or focus the lightning icon beside the
Schema access icon, or use the Auto mode switch in Settings. The popover names who receives
the evaluator input and offers activation with what is already set up. Clicking the icon
opens the Auto mode section of Settings. Activating while something is missing (a key, a
server URL, a cutoff) opens the evaluator page on the first missing field, without a message:
the evaluator line already says what it needs. Credentials are entered only on the evaluator
page, never in the compact popover. A key field saves as you type, whether Auto mode is on or
off, and a running Auto mode uses a replaced key from its next evaluation.
The installed Beekeeper SDK supports
`appStorage.getItem/setItem(..., { encrypted: true })`. Keys and the evaluator choice are
stored there, scoped to the plugin. A key is never placed in MCP arguments, broker storage,
logs or result records.
No account or live inference is
configured by the repository.

## Evaluator

Settings' Auto mode box names the evaluator in one line: the model, its provider, and the
state of its cutoffs (Built-in cutoffs, Your cutoffs, Cutoffs needed). Change opens the
evaluator page in the same dialog; Escape or the back arrow returns to Settings.

| Provider | Models | Address | Key |
| :--- | :--- | :--- | :--- |
| TypeSafe | `jev-1.13.0` | `https://api.typesafe.ai/v1/systemone` | required |
| Custom server | any System One model | `<server URL>/v1/systemone` | optional |

Both receive the same input and the same four questions and answer with one probability of
yes per question. A Custom server is any server speaking TypeSafe's System One protocol, such
as [Kev](https://github.com/jaredpalmer/kev); its URL is https, or plain http only to
`127.0.0.1` or `[::1]` (a typed `localhost` is saved as `127.0.0.1`), with no credentials,
query or fragment. Its path is kept, and the record keeps only its origin. A Custom server
must refuse a request too long for it rather than cut it; Gatekeeper cannot verify that.

**Cutoffs.** Gatekeeper's built-in cutoffs (the table under "Provider boundary") exist only
for `jev-1.13.0`, as policy `auto-v10` measured them, and are checked by default. Every
other model starts with empty cutoffs: Auto mode cannot turn on until all four are set, and
an empty cutoff never counts as zero. A read passes when every probability is at or below its
cutoff. Cutoffs the user sets are the user's delegation, not a Gatekeeper measurement; the
record keeps them and whether they were built in, and the detail says "with your cutoffs".
The four questions stay Gatekeeper's and are not configurable.

**Measuring cutoffs.** The evaluator page copies a prompt for the user's agent, which runs the
[evaluation bench](../packages/server/evals/README.md) against the chosen evaluator: a live
development run, `--propose` to derive four cutoffs, then one validation run replayed with
those cutoffs unchanged. The prompt carries no key and the agent never edits Settings.

**Changes.** Any edit of the provider, model, URL, a cutoff or the built-in box turns Auto
mode off at the first keystroke, and the evaluation in flight can no longer approve anything:
Auto mode freezes the evaluator and cutoffs it is switched on with and judges each answer
against them. Replacing a key does not turn it off. Each key is stored for the destination it
was typed for (TypeSafe, a Custom server's full URL) and never sent to another one. A damaged stored choice leaves Auto mode without an evaluator
rather than falling back to TypeSafe.

**Clef.** Cloudflare's Clef models are not offered. Workers AI cuts a text state longer than
the model reads instead of refusing it (Cloudflare's model pages say so), and an answer about
a cut state is not about the read. Our development requests left no evidence of where that cut
falls, since their four questions outweigh their state, so no size check could keep a cut
read from approving itself (operator decision, 2026-11-13).

**Connection test.** Test connection, and each activation, use a metadata call only: TypeSafe's
`GET /v1/models` (any 2xx accepted, as before), and a Custom server's `GET /v1/models`, which
must list the model.

**Versions.** An older plugin's request still evaluates with TypeSafe and the built-in
cutoffs. A newer plugin on an older server says "Restart the Gatekeeper server to choose an
evaluator. It predates this plugin." Records from before this change carry no cutoffs; they
display as before.

Enabling first forces Read only and cancels an open mode confirmation. Write and
Destructive remain selectable. Confirming either mode disables Auto mode before granting
the selected authority, invalidating in-flight evaluations and pending activation.
Cancelling that confirmation leaves Auto mode active. Destructive still requires typing
the database name. Disabling Auto mode directly leaves Read only.
Enabling delegates the approvals to come, never the ones already waiting: proposals
already in the queue at that moment stay manual for as long as this activation lasts,
so one click can never execute a request a human was still weighing up.
While enabled, the header shows an AUTO MODE chip in the slot Write and Destructive use,
and the Settings switch reflects the same in-memory boolean. The chip's close button
disables immediately and returns focus to the Auto icon. The chip's ring pulse and the
icon's discovery dot respect reduced motion. There is no Pause
state. Reload, re-pair, tab takeover, connection identity or default-schema change, and
schema-change notifications invalidate automatic authority. Disabling stops future
automatic execution, including decisions awaiting a host or broker response. It cannot
cancel SQL already running.

## Supported SQL

The shared read analysis supports a successfully parsed single PostgreSQL `SELECT`
over explicit ordinary `schema.table` relations. It walks the whole statement with
PostgreSQL scoping and resolves every function, operator and cast it uses against the
live catalog, instead of accepting a fixed list of names. Projections, aliases, filters,
joins (including `USING`), grouping, HAVING, ordering, DISTINCT, LIMIT and OFFSET combine
with CASE, COALESCE, NULLIF, GREATEST, LEAST, casts, aggregates with DISTINCT, ORDER BY or
FILTER, window functions with an inline `PARTITION BY`/`ORDER BY`, non-recursive CTEs,
derived tables, and scalar, `IN` and `EXISTS` subqueries, correlated or not. For example,
both of these reach Jev when their sources and catalog resolve:

```sql
SELECT pi.id, pi."updatedAt", pi.metadata ->> 'orderRef' AS order_ref,
  array_agg(pa.payment_method_kind || ':' || pa.status || ':' || pa.captured_amount_cents::text
            ORDER BY pa.payment_method_kind) AS attempts
FROM payment_orchestrator.payment_intent pi
JOIN payment_orchestrator.payment_attempt pa ON pa.payment_intent_id = pi.id
WHERE pi.status = 'AUTHORIZED'
  AND EXISTS (SELECT 1 FROM payment_orchestrator.payment_attempt c
              WHERE c.payment_intent_id = pi.id AND c.status = 'CAPTURED')
GROUP BY pi.id, pi."updatedAt", pi.metadata
ORDER BY pi."updatedAt";

SELECT status, count(*) AS n FROM payment_orchestrator.payment_intent GROUP BY status ORDER BY status;
```

Reaching Jev is not approval: its four cutoffs still decide.

The analysis reads the query with PostgreSQL 18's grammar (`libpg_query`, PostgreSQL's
parser compiled to WebAssembly), whatever the server's version, so names, strings,
comments and statement boundaries split as PostgreSQL 18 splits them with
`standard_conforming_strings` on; the string restrictions below cover the other setting. Unquoted ASCII names fold to
lowercase, while quoted names retain their exact case and may contain spaces, accents
and escaped double quotes. Catalog comparisons use exact decoded names, and catalog
lookup values use escaped PostgreSQL E strings. Names are limited to the standard
63-byte catalog length. Non-ASCII unquoted names and Unicode escape notation (`U&`)
remain manual. An ordinary string containing a backslash remains manual because its
value depends on `standard_conforming_strings`. An ordinary string with a backslash
before a quote is blocked at the gate: under either setting it ends at a different place,
so no single reading of the statement exists. Stars expand from each referenced table's catalog, or from the
columns of a CTE or derived table. `COUNT(*)` reads relation membership without
projecting unrelated fields. Resolution respects the nearest query scope and alias
shadowing. The subset is capped at 16 relation occurrences and eight nested levels.

Every column the query reads, anywhere, becomes a dependency with a usage: `output` when
its value is returned or shapes a returned value (including through a CASE condition,
an aggregate ORDER BY or a subquery inside the projection), `control` when it only
filters, joins, groups or orders rows, `both` when it does both. A CTE or derived table
passes its sources through: renaming `email` inside a CTE still reads `email`, and a CTE's
own filters count as control dependencies. Usage describes the data flow for Jev. It never
makes a dependency less sensitive, and every dependency passes the same local checks.

JSON documents are opaque. `->>` and `#>>` with a static key return one scalar, `?` and
`jsonb_exists` test one key, and `jsonb_typeof` returns a type name. Every other use keeps
the document opaque, including casts to text, `->` subtrees, aggregation and functions
such as `jsonb_pretty` or `length(metadata::text)`. An opaque or unresolved value in the
output stays manual. Grouping, filtering or joining on a whole document is allowed as a
control dependency. Keys and paths stay visible to the evaluator and pass the shared
sensitive-key checks. Only ASCII identifier keys and `{a,b}` paths are accepted.

Set operations are supported: UNION, INTERSECT and EXCEPT, each with or without ALL or
DISTINCT, mixed and parenthesized as PostgreSQL groups them. Each operation has exactly
two inputs in PostgreSQL's tree, so INTERSECT binds tighter than UNION and EXCEPT and
parentheses keep their meaning. Each branch is walked in the outer scope, output names
come from the first branch, and each output position is resolved pair by pair from the
innermost operation outwards, as PostgreSQL does, checking the casts at each step (two
untyped literals become text before a later typed branch, so a custom implicit cast from
text is caught). Every form except UNION ALL compares rows, so it requires sortable types.
The right operand of EXCEPT becomes a control dependency. A WITH, ORDER BY or LIMIT
written around a set operation applies to its combined result, and that ORDER BY may only
name an output column or ordinal.

A set-operation branch may select constants or catalog-checked functions without a
FROM clause when another branch supplies an explicit ordinary relation. A standalone
SELECT without a relation remains manual. A sensitive-looking alias on a bare string
constant does not by itself hold the read; sensitive source columns and nonconstant
aliases still do.

Bare literal projections (`'transfer_out' AS kind`, numbers, NULL, booleans, typed
literals) are returned after the shared sensitive-literal screening. Strings and numbers,
typed or not, are withheld from Jev like any other value; NULL and booleans carry no value
and stay visible. They reveal nothing the requester did not write; the filters and joins
around them still count.

Spellings that PostgreSQL's grammar maps to one tree node are one shape for the analysis.
A typed literal `type 'value'` and `value::type` are both casts, checked against the
catalog with the type name PostgreSQL resolves. `FETCH FIRST|NEXT n ROWS ONLY` is a
LIMIT and `OFFSET n ROWS` an OFFSET, under the same bound. `IS [NOT] DISTINCT FROM`
compares through `=` like PostgreSQL, unless one side is a bare NULL, which makes it a
null test. `DISTINCT ON` keys and `ORDER BY` with `NULLS FIRST|LAST` are supported. A
join's `USING` key is one merged column, taken once from each input, and an unqualified
reference to it resolves to that column. `EXTRACT(unit FROM value)` keeps its unit
visible only when it is one of the units PostgreSQL documents; any other text holds.
`E''` and dollar-quoted strings are literals like any other.

Jev receives SQL rendered from the redacted tree by `pgsql-deparser`, then parsed again
with PostgreSQL's grammar: the rendering is sent only when it yields the same tree,
positions aside. The rendering normalizes the spelling (casts become `CAST(... AS ...)`,
names lose quotes they do not need), while PostgreSQL executes the submitted SQL
unchanged.

Still manual: recursive CTEs, LATERAL, functions in FROM, VALUES, locking clauses,
`SELECT ... INTO`, named windows and window frames, grouping sets, array constructors,
subscripts and `= ANY (...)` over an array, row comparisons, `COLLATE`, bind parameters,
`ORDER BY ... USING`, `FETCH ... WITH TIES`, relation aliases that rename columns, a bare
star over a `USING` join, schema-qualified calls outside `pg_catalog`, whole-row
references and anything the walker does not model. Unknown node types and unknown node
keys hold instead of being skipped. LIMIT and OFFSET must be nonnegative integers at most 1000000.
Existing source/output-alias/JSON/literal detections run before sharing, over the whole query,
filters and joins included (`analyzeSql`, `sensitiveLiterals`). The reviewer's annotation is a
separate reading of the output alone (`sql/output.ts`): narrowing it never narrows these checks.
IP addresses receive stricter treatment than display annotations.
There is no automatic fallback for parse failures and no function is implicitly trusted.

### Deliberate limitation: identifier names

Identifier names use the existing display-detector exemption: `id`, names ending in
`_id`, `Id` or `ID` do not trigger a local sensitive-name hold. This includes personal
and company references such as `customer_id` and `company_id`, in projections, aliases,
predicates, joins and catalog-expanded stars. Other detectors and source checks still
apply. Renaming `email` to `customer_id` does not hide the sensitive source.

This is a usability tradeoff, not evidence that identifiers are anonymous. Returned IDs
can identify people or organizations, and Jev can miss that risk. No result rows are sent
to Jev. The exemption does not extend SQL syntax support or change evaluator questions
or thresholds.

### Relation context and operational metadata

Schema names, table names and table aliases do not independently trigger a local
sensitive-name hold. A read of thresholds from `company`, or statuses and creation
timestamps from `accounts`, does not return identities merely by referencing those
tables. Generic entity words such as `account`, `customer` or `user` are not
independent sensitive-name rules for columns or output aliases either. For example,
`account_created_at` is operational metadata, while `birth_date` remains locally held.
Explicit sensitive column names, output aliases, JSON keys and literals still count,
including dependencies in predicates and joins and fields expanded from stars.
System schemas remain outside the automatic subset.

Jev receives relation context to assess actual disclosure, including membership and
boolean results. This deliberately leaves more contextual decisions to the evaluator,
which can miss risk. It is not a guarantee that dates or status fields are anonymous.
Quoted camel-case columns are supported through the shared identifier adapter. Other
unsupported SQL still requires manual review.

### Bare name columns

A column, output alias or JSON key whose only sensitive word is a bare `name` does not hold
locally: `name`, `display_name`, `event_name`, `holder_name` or
`legal_name` stay visible in the SQL sent to Jev, alongside the relation context and the
typed source dependencies. The same word names a product as often as a person, and only the
relation tells them apart: `catalog.products.name` should pass, `app.users.name` should be
held on personal disclosure. Explicit person and
company names still hold locally through the shared fragments (`first_name`, `last_name`,
`full_name`, `surname`, `owner_name`, `company_name`, `customer_name`, `client_name`,
`account_name`), as do every other sensitive fragment, literal and JSON key check. The
display annotations a reviewer sees never flagged a bare `name` and are unchanged.

This moves a deterministic local decision to Jev, which can miss risk. The 17 authored
cases in `packages/server/evals/auto-name-cases.json` (seven allow, eight review, two
local) were run live on 2026-11-06: no review case was approved automatically and one allow
case (`name-campaign-template`) was held. Seventeen synthetic cases are not a calibration.

### PostgreSQL catalog resolution

The PostgreSQL specifics live in `packages/plugin/src/sql/pg/`: `parse.ts` loads
PostgreSQL's grammar, `plan.ts` walks the statement and renders Jev's SQL, `catalog.ts`
builds the metadata query and applies the resolution rules. `read-analysis.ts` is the shared entry point and refuses every other
dialect before any catalog SQL. Before inference, the plugin runs two catalog-only reads
through Beekeeper's existing connection, never the proposal itself:

1. `SELECT pg_catalog.array_to_json(pg_catalog.current_schemas(true))` checks that
   `pg_catalog` is searched first (the temporary schema is ignored, since PostgreSQL never
   searches it for functions or operators). Only qualified calls run before this check.
2. One query reads the referenced relations and columns, every visible function and
   operator with a name the proposal uses, the cast targets it names (through
   `to_regtype`), the types involved with their bases, elements and arrays, the implicit
   casts from those types, the implementation of each candidate operator and cast, and
   any non-built-in default operator class. Every type, operator and function name in it
   is `pg_catalog`-qualified or compares exact built-in types, and names travel as escaped
   literals. Its first row carries per-kind row counts, so a truncated or partial result
   holds instead of reading as an empty set. Rows are validated field by field.

A built-in object is one with an OID below `FirstNormalObjectId` (16384) in the
`pg_catalog` namespace. Objects created later count as user objects, even inside
`pg_catalog`. Resolution follows PostgreSQL's
[function](https://www.postgresql.org/docs/current/typeconv-func.html) and
[operator](https://www.postgresql.org/docs/current/typeconv-oper.html) type resolution
without reimplementing its ranking:

- Candidates are the visible objects with that name, with every arity reachable through
  defaults or VARIADIC. A parser label such as an aggregate call does not narrow them.
  With `pg_catalog` first, an object with an identical signature later in the path is hidden.
- An exact signature match is taken as PostgreSQL takes it. For operators only, one
  unknown literal takes the other operand's type, and against a domain the base type is
  tried next. Domain identity is kept for the exact check.
- Otherwise a candidate is dropped only with proof that an argument cannot reach its
  parameter: a concrete type, a concrete non-domain parameter and no implicit `pg_cast`
  path. Domains, arrays, composites, polymorphic parameters, unknown literals and missing
  metadata keep the candidate. When an argument has several possible types, each
  combination is resolved separately (up to 64 combinations, jointly beyond that).
- Every candidate still standing must be built in, and so must its implementation, its
  aggregate support functions and the implicit casts that coerce its arguments.
  Polymorphic arguments are checked for the casts that bring them to one common type.
  So are the branches of CASE, COALESCE, GREATEST, LEAST and IN lists, and conditions
  coerced to boolean. Set-returning, volatile and procedure candidates hold, and so do
  candidates whose parameters or result are object identifiers or other server-internal
  types.
- IMMUTABLE built-ins are admitted. STABLE alone is not proof of harmlessness, because it
  does not exclude configuration or catalog reads such as `current_setting` or
  `pg_get_viewdef`. Two exceptions are admitted. The first is a short list of built-in
  functions reviewed as formatting, time zone or clock dependent transformations:
  `now`, `statement_timestamp`, `transaction_timestamp`, `date_trunc`, `date_part`,
  `extract`, `age`, `timezone`, `to_char`, `to_date`, `to_timestamp`, `to_number`, the
  `date`/`timestamp`/`timestamptz`/`time`/`timetz` conversions, `anytextcat`,
  `textanycat`, `concat`, `concat_ws` and `format`. The second is built-in arithmetic and
  comparison operators (`+ - = <> < <= > >=`) whose declared operands and result are
  all native date/time, interval, numeric or boolean types, such as
  `timestamptz - interval` or `timestamp < timestamptz`, whose only other input is the
  session time zone. This rule was written from PostgreSQL's documented
  operator families and has not been audited against every `pg_operator` row of a live
  server. Any other STABLE built-in stays manual.
- Explicit casts need a built-in target that is not a domain or an internal type, and a
  built-in conversion function, or text I/O to or from a string type.
- Sorting, grouping, DISTINCT and window partitions use the type's default operator class
  rather than a name lookup, so they only require readable types and no non-built-in
  default operator class.

Readable types are built-in scalar, range and array types with built-in I/O, enums,
arrays of readable types, and domains over readable types. Reading a domain does not run
its constraints, but casting to a domain does, so casts to domains stay manual. Custom
base and composite types, views, foreign tables, RLS, inherited or partitioned tables,
generated columns and non-built-in collations stay manual, together with missing
metadata and introspection errors. Extension operators and casts on types the query
never reaches do not block unrelated reads: a vector or geometry equality operator
cannot compete with `status = 'AUTHORIZED'` on an enum, because no implicit cast leads
there.

This is a conservative approximation, not the planner. It can hold reads PostgreSQL
would resolve harmlessly. Every uncertainty keeps a candidate, and any user-defined
candidate left standing holds the read. The analysis assumes PostgreSQL 12 or later
(`prokind`, `attgenerated`).
`SchemaAnnotator.inspectRead` builds the `ReadSnapshot` Auto mode evaluates; the reviewer's
annotation does not use it. It records incomplete analysis explicitly. `filterSchema` only
affects display. Auto mode obtains a fresh snapshot and checks activation, connection and lease
authority across asynchronous calls. This analysis is independent of schema access and
every detection display toggle.
Auto mode has no table or field editor. Any future Sensitive tables policy belongs
to the whole plugin.

## Load check

Before the read analysis, and so before anything is sent to the evaluator, Auto mode waits for
the card's [load check](../SECURITY.md#load-check). A read with a Heavy query alert stays for
manual review with the reason `Heavy query`. A check that could not finish (no row estimate,
index list unavailable, statistics late or unavailable) holds nothing, and the read goes on to
the usual evaluation. Passing the check does not make a read cheap, because a range on an
indexed column can still scan most of a table.

## Provider boundary

The plugin detects known sensitive literals before sharing, then serializes the parsed
query without comments. String, typed and numeric literal values anywhere in the statement
(predicates, projections, function arguments such as the `':'` separators above) are
replaced with positional parameters only in evaluator input, explicitly marked
`withheldLiterals: true`. Typed literals keep their type as a cast (`DATE '2026-01-01'`
becomes `CAST($1 AS DATE)`); numeric literals keep their type as a cast too. Equal values
of the same literal kind share a parameter. Structural numbers such as `ORDER BY 1`,
`GROUP BY 1`, `LIMIT 5` and `OFFSET 2` stay visible, as do JSON keys and paths after
screening. The original SQL remains unchanged
for execution. Only that SQL structure and the
referenced schema/table/column names, types and usages go to the evaluator.
No query result rows, agent intent, connection name, database name or unreferenced column
metadata are sent. Names themselves can still contain confidential information. These
checks do not guarantee anonymization. The activation disclosure is explicit consent
to this sharing and to returning automatically approved results to the requesting agent.

Each activation first runs the connection test described under "Evaluator", which evaluates
nothing, so it carries only the key. A 401 or 403 opens the evaluator page with "The evaluator
refused this API key." under the key. A Custom server that does not list the model opens the
page on the model with "<model> is not available with these settings." Any other failure leaves
Auto mode off and says the evaluator could not be reached. For TypeSafe, the route and the
meaning of 401/403 come from TypeSafe's JavaScript SDK (v0.6.0), not from a live call.

Inference uses the authenticated local plugin channel and native `fetch` in the broker.
The broker accepts one evaluation at a time, caps input size, uses a 12-second timeout,
disallows redirects, checks the live request/lease/connection before and after inference,
and never forwards provider error bodies. The plugin aborts outstanding evaluation on
deactivation and applies its own 15-second deadline. There is no retry or provider fallback.

TypeSafe's native endpoint is `POST https://api.typesafe.ai/v1/systemone`, using Bearer auth
and `model`, `state`, `questions`; every evaluator receives that same body. With TypeSafe,
model `jev-1.13.0` and policy `auto-v10`'s built-in cutoffs are the default.
Four focused Noul questions are batched: personal disclosure, organization disclosure,
access secret disclosure and insufficient context. Noul is a probability of yes, not a
Choice/Score confidence value. All four conditions must pass:

| Axis | Required probability |
| :--- | :--- |
| `personal_disclosure` | <= 0.20 |
| `organization_disclosure` | <= 0.15 |
| `secret_disclosure` | <= 0.15 |
| `insufficient_context` | <= 0.45 |

Jev is not asked about read-only behavior. Auto mode's read-only eligibility is decided by
the local deterministic analysis: it checks the supported SQL expressions, resolves their
functions, operators and casts against the catalog, and holds unsupported or unresolved
queries before calling Jev. A future database engine gets Auto mode only with its own local
read-only analysis.

Missing, malformed, out-of-range, wrong-model and uncertain answers require manual
review. The plugin independently checks the same cutoffs before execution. Model concern
never rejects a manually reviewable request. These are conservative operating cutoffs,
not calibrated probabilities of privacy loss.

The questions interpret selected source columns in their relation context. A reassuring
alias does not remove a source value's access authority. Ordinary commercial amounts
without identity are not prohibited solely for commercial confidentiality. Withheld rows
and unselected sensitive columns alone do not imply insufficient context.

The disclosure questions separate identity from opaque references: names, contacts, government, tax or bank
identifiers and private facts identify a person, while UUIDs, foreign keys and account,
wallet or provider references are pseudonymous and add no identity when combined with
dates, statuses or amounts. Private facts stay sensitive even when keyed only by an
opaque identifier. A named JSON key is read like a column name, and a JSON value cast to
boolean, number or date can only return that type. Prices, tariffs and pay bands are
business values, not an individual's salary, and hardware models, credential formats and
record identifiers describe access without granting it. They also state that
withheld literals include projection and function arguments, and that a control
dependency can still disclose through row presence, counts or booleans. Jev cannot
verify side effects or hidden sources. Those stay local and deterministic, and Jev never
overrides an unresolved local dependency.

The current questions and cutoffs were run live on 2026-11-06 with the `shared-read-3`
analysis over `auto-cases.json`, `auto-export-cases.json` and `auto-name-cases.json`, both
splits: 272 provider observations, no provider error, all 126 expected review cases held,
no local regression, and 139 of 146 expected allow cases passed. The seven unnecessary holds
are a consultation tariff on personal disclosure, four access-hardware or format
descriptions on secret disclosure, provider request paths on personal and organization
disclosure, and a campaign template name on organization disclosure. Each case was observed
once, so this is not a stability measurement: a borderline case can change decision from
one run to the next. These authored, correlated synthetic cases informed the choice of
questions and cutoffs and do not establish a general privacy error rate. They are mostly
single-table projections with a LIMIT, plus a few filters, orderings, joins, GROUP BY,
count, sum, min and max, UNION and INTERSECT, uncorrelated `IN` subqueries, one CTE and JSON
key reads. Live evidence covers only the exact SQL forms in these corpora: the rest of the
supported subset, the first example under "Supported SQL" included, has no live evidence.
Full provenance and method are in the evaluation bench documentation.

The export cases are synthetic versions of 15 distinct exported investigations, with
inferred catalog types that have not been checked against a real database. One of them
reads an untyped JSON key (`legalRepresentative`) whose meaning is ambiguous from the SQL
alone. It stays manual review, with no deterministic exception for that field. A
requester-written cast of that value would only clarify the returned type; every local and
evaluator check would still apply, and Gatekeeper never rewrites the submitted SQL.

Decisions recorded under an earlier policy cannot authorize automatic execution, but remain
readable in history and can accompany a human approval. Reload the plugin and reconnect the
MCP server after updating both components, then activate Auto mode again. Mixed policy
versions fail to manual review.

Sources checked for this implementation: [API](https://docs.typesafe.ai/api),
[primitives](https://docs.typesafe.ai/primitives), [models](https://docs.typesafe.ai/models),
[Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
OpenRouter's native multi-question transport is not implemented.

## Execution and history

Manual and automatic approval reserve the same card synchronously before awaiting the
host. Both use the existing broker `executing` transition and final connection check.
Automatic execution additionally rechecks activation, connection generation, tab ownership,
SQL, lease, deadline, model and policy. A stopped reservation is withdrawn before the card
returns to manual review. The broker only accepts an automatic decision it recently issued
for that lease and SQL digest. The plugin remains the execution authority. Broker snapshots
are a further consistency check, not independently trusted connection evidence.

Evaluation does not wait for an automatically approved read to finish: the next read is
evaluated while the previous one runs. Auto mode starts no new evaluation while three
automatic reads are still running, which keeps it from filling Beekeeper's connection pool
(8 connections by default for PostgreSQL) on its own. It reserves nothing: the operator's
own work can still take the remaining connections.

History records Approved automatically or Approved by you. Available evaluator output,
provider, pinned model, policy, evaluation time and SQL digest are retained in `policy_json`
and shown in details and Audit Trail, together with the cutoffs in force, which grade the
displayed probabilities rather than appear as numbers. They survive result-row purging and
remain indefinitely with the decided request. Older records without attribution
are not retroactively labelled as human approvals. A detail grades each probability against
the cutoffs its record carries; a record from before cutoffs were kept is graded against
`auto-v10`'s only when it names that exact provider, model and policy, and malformed recorded
cutoffs leave the numbers ungraded. Recorded cutoffs never grant authority: the plugin and the
broker still require the issued evaluation and the cutoffs they enforce themselves.

On macOS, a read submitted while Auto mode is on raises no alert until Auto mode leaves it to
you: a hold, a refusal, a failed or timed-out evaluation, or Auto mode switched off. The plugin
reports Auto mode and those reads on its `/pending` poll, and the server alerts then; a read
Auto mode approves stays silent, unless the plugin stopped reporting for 15 seconds first or
the read was still waiting at half its life (for instance behind long automatic runs). See
[Desktop notifications](CONFIGURATION.md#desktop-notifications-macos).

The plugin can attach `autoHold: { sent: boolean, reason: string }` to `POST /result`
when a read held by Auto mode is resolved. The broker stores it atomically alongside
approval and evaluation in `policy_json` and exposes it only in the host-side
`ActivityEntry`, independently of result-row purging. The record is optional for
older plugins. Its presence records a hold, not authority to execute.

Disabling Auto mode preserves completed local and evaluator review reasons. An
unfinished evaluation records `Auto mode disabled while evaluating`, retaining whether
provider submission was attempted. Late evaluator responses cannot approve the read.

`sent` reports whether the plugin attempted provider submission. It is not proof of
provider receipt. The reason is limited to 200 characters, restricted to known
diagnostics, and stripped of source-name suffixes. Unknown wording becomes
`Automatic review required`, so this field does not retain literals, rows or provider
error text. A server test reads the plugin's hold sites and fails when one of their reasons
is missing from that list. A catalog query the host rejects is recorded as
`Metadata query failed`; catalog SQL the analysis cannot build, or main catalog rows that
fail validation, stay `Metadata unavailable`. This result-time record does not cover a card
lost to a crash, cancellation or expiry before the plugin posts its outcome.

## Verification and limits

The measured evidence is the live run described under "Provider boundary". Those
correlated synthetic examples do not establish a general error rate. The questions
explicitly consider what the requester can infer from counts, booleans and row presence
while knowing the original predicate. Redaction and aggregation are not treated as
evidence of privacy.
Catalog unit tests use a hand-written synthetic subset of built-in catalog rows
(`pg/catalog-fixture.ts`), not a live PostgreSQL connection. They prove the resolution
rules, not that the metadata query returns what a real server holds.

### Real catalog check

This check has not been run yet. It needs a human with Beekeeper on the synthetic test
database, never a real one, and no Auto mode or evaluator call:

1. Start the synthetic databases with `pnpm db:up` if they are not running. Do not recreate
   volumes.
2. In Beekeeper, connected to `gatekeeper_test`, run `test-db/auto-catalog/fixture.sql`.
   It adds the `payment_orchestrator` schema with enums, and extension-like operators,
   an implicit cast and a `count` aggregate on a `public.gk_vector` type.
3. Print the three catalog-only statements for the acceptance queries:
   `GK_REAL_CATALOG_PRINT=1 pnpm --filter @gatekeeper/plugin exec vitest run src/sql/pg/real-catalog.test.ts --silent=false`.
4. An agent submits each statement through Gatekeeper and a human approves it in
   Beekeeper. Save the returned rows as
   `{ "variant": "fixture", "searchPath": [...], "attempts": [...], "statuses": [...] }`
   in `.scratch/`.
5. Run `GK_REAL_CATALOG=<absolute path> pnpm --filter @gatekeeper/plugin exec vitest run src/sql/pg/real-catalog.test.ts`.
   Both acceptance queries must be locally eligible.
6. Run `test-db/auto-catalog/negative.sql`, capture again as `"variant": "negative"` and
   rerun the test: the attempts query must hold on the user `array_agg(text)` and the
   status count on row level security.
7. Run `test-db/auto-catalog/cleanup.sql`.

Deterministic regression tests cover sensitive dependencies and unsupported SQL. Mocked
provider tests cover the native contract and errors. Race tests cover manual/automatic
contention, disable, schema and tab changes, lease loss and late answers. Broker tests
cover authentication, cancellation, concurrency and durable attribution. These synthetic
tests do not calibrate Jev. Each evaluator reason marks a failed cutoff, not an equally
strong concern: the probabilities shown with it say how far each one went. The evaluator receives no
assertion that the source is a synthetic test database. Adversarial names can still mislead
the model, and prompts are not immune to injection. Jev's privacy judgments have been
measured on synthetic cases only, and broadening this subset needs a separately authorized
labeled evaluation first.

Final row/byte caps bound transmitted results, not privacy or database work. Metadata and
connection checks are separate host calls, not an atomic database transaction: external
DDL or connection changes in the final host dispatch interval cannot be ruled out by
JavaScript checks. Use a database role with only the privileges you intend to delegate.

Regression tests cover missing keys, stale credential lookups, immediate disable, matching
server/plugin probability cutoffs, and old-policy invalidation without blocking human
approval. The plugin integration tests mock catalog
metadata and the evaluator. They do not execute database queries or call an evaluator.
