# Gatekeeper plugin design system

The rules the plugin UI keeps, for anyone about to change it. The plugin renders inside
Beekeeper Studio and should read as native to it: amber on dark, terse, every element there for
a reason. Values live in `packages/shared/tokens.css` and `packages/plugin/src/style.css`; reuse
them and the existing treatments before adding one. How to render and check a change is in
`AGENTS.md`.

## Core rules

- One fact, one place, one definition. Never show the same count twice with two meanings.
- Show only what was recorded. Unknown stays unknown: a count that was not recorded is left
  out, never shown as zero; no invented actor, time or delivery claim. A reason or an error is
  shown verbatim.
- Say it in one quick, clear sentence. More facts are not an improvement by default; prefer the
  clearer state.
- No speculative controls: nothing is added for a problem that has not happened yet.
- No colour is the only sign of anything: a state is a glyph, a word and its facts.

## Palette

The palette is pinned and dark-committed (`tokens.css`, `color-scheme: dark`): it does not
follow Beekeeper's theme, so the plugin reads the same on any of them.

| Token | Role |
| --- | --- |
| `--ground`, `--surface`, `--sunken` | page, cards and panes, wells (SQL, inputs) |
| `--text`, `--muted`, `--faint` | primary text, secondary text, hints and metadata |
| `--edge`, `--edge-strong`, `--hi` | tonal edges and the top highlight, derived from `--text` |
| `--amber` | the accent (see below) |
| `--ok`, `--danger` | approved and passing, destructive and failing |
| `--exec` | executing |
| `--client` | client-confidential data, a violet kept apart from the red of PII |
| `--auto` | Auto mode, and nothing else |

Colour always means something, read in its context. Amber is the primary action, the held
state, SQL keywords, the write class, an open Audit Trail day, a declined outcome and a reason
you typed yourself; it is never decoration. Red marks the destructive class, failures and
possible PII; a value in the SQL is never marked, since the agent wrote it. `--auto` reuses the existing shapes (the armed
chip, the hint, the note, the row bolt) and adds only what evaluation needs: the evaluating row
dot and the ring around the SQL. Versions follow the same rule: amber only when the plugin and
the server are out of step, on the side that has to act; a newer release while both agree is
green.

## Signatures

- **SQL corner frame**: two 12px brackets at the top-left and bottom-right of every SQL block
  (`.sql::before/::after`), neutral by default. On a pending card and in the run confirm they
  take the class (amber for a write, red for a destructive query); on an executing card they
  turn blue, then amber past 45 seconds; a decided request keeps them neutral. A bespoke
  bracket, never an accent bar.
- **Honeycomb**: Beekeeper's hexagon motif, kept faint, on its own clipped layer that never
  takes a pointer or clips a popover. It sits behind the header content (the header shows no
  logo and no wordmark: inside Beekeeper the tab already names the plugin) and carries the
  empty lists.
- **Tonal edges**: a container gets a self-coloured 1px edge at low opacity and a faint top
  highlight (`inset 0 1px 0`), never a hard contrasting hairline. Overlay windows are the
  exception (see Overlays).

## Type

- **Sans (system-ui) carries all prose**: intents, labels, buttons, notes. Labels such as
  Read, Write and Delete are prose.
- **Mono carries data only**: SQL, clocks, ids, counts, table and column names. Mono is never
  the voice of a label.
- Headings are roman, never italic.

Inside prose, things are named in their own style:

- **SQL keywords** (`code.kw`): uppercase, mono, amber, as in "Eligible `SELECT` reads". Not the
  query block, which has its own highlighter.
- **Names** (`code.name`): table and column names in plain mono.
- **Agent tools and skills** (`code.tool`, `.ver-skill`): a neutral mono chip, never amber, so
  a tool name never reads as SQL.
- **The connection** (`.em-conn`, from `connTag`): the database glyph and the connection name,
  wherever a sentence names the connection.

## Words

- A setting says what it does in one sentence ("Which statements can run once you
  approve."). Anything secondary (a default, a scope, a consequence) goes on its own line under
  it in `.set-note`: italic, faint, a full sentence ("Resets to read-only on load or a
  connection switch."), or a two-word tail ("Off by default.").
- Never make "Gatekeeper" the subject of a sentence. State the fact ("This statement could not
  be parsed."); name the product only where it identifies something (the server, the skill).
- A blocker states the requirement it misses ("Write mode is required to approve this query.",
  "PostgreSQL 10 or later is required to stop a query."), never a statement of fact about the
  connection.
- A note states its reason as the sentence, never a generic lead plus a chip. A hold or review
  note that hands a decision back ends with "Waiting for your review." No lecturing.
- Counts are numbers, zero included ("returning 0 rows"). A write reports rows affected, the
  database's count, never rows "changed".
- A limit is stated affirmatively with its purpose ("Only the first 10,000 rows were sent to
  the agent to avoid context pollution.").
- On a card or a detail, timers say what they measure ("Expires in 4:26", "Requested 40s
  ago"). A list row keeps its compact clock, which its place in the row explains.

## Shell and context

The shell (`.gk`) fills the tab's height, capped at 1440px wide, in three rows: the top (the
header, then the agents strip), the Inbox, the status line. Only the Inbox panes scroll.

- **Header**: the connection chip (database glyph, connection name, dialect, database; the
  database spelled out whenever it is known, never invented; no schema, since a proposal can
  target any), the server glyph, then the settings. Statuses sit on the left, settings on the
  right. The glyphs carry a status dot and a popover with the detail; the header shows no
  other check or read-only word. Each read-only layer's help is the same outline mark as the
  legend's (`helpCircleIcon`, 15px, faint, brighter on hover, an amber focus ring), drawn rather
  than a font "?" so it is centred whatever the system font.
- **Feature hints** (Auto mode, Schema access) share one shape: an icon with a pulsing dot
  while off, a popover on hover or keyboard focus with one direct action (filled to enable,
  tinted to disable), and the icon itself opening its Settings section.
- **Agents strip**: one line of chips (presence dot, tool icon, project, active or idle). No
  count of what waits: the Queue owns that. Chips that do not fit fold into "+N more", whose
  popover shows the same facts; the session task shows on hover in both.
- **Inbox**: the list pane and the open item side by side. The list has two tabs, Queue
  (Pending approval, then Recently resolved) and Audit Trail, each with its own selection.
  Recently resolved is the newest end of the Audit Trail's own history, the same decisions
  however many tabs or sessions made them, not a list kept by this tab. A
  pending row opens its card, a decided row its detail, the same detail in both tabs. The
  Queue never selects by itself; the Audit Trail opens on its newest decision when nothing is
  selected there, without taking the focus or leaving a narrow list. A human approval that
  completes, or a decline, opens the next request still waiting for a human (below it, else
  from the top), as a click on it would; with none left, the decided request stays open as
  its outcome. Failures, expiries, Auto mode approvals and the load check's own rejections
  never move the selection, and nor does a decision landing after the human went back to a
  narrow list, or one the server did not acknowledge (its open outcome is the only place it
  shows until the server's record arrives).
- **Status line**: the version on the left, star and feedback on the right, docked in the
  layout.

Container queries own the layout tiers, never a resize listener: `gk-inbox` (size, on
`.inbox`) makes the panes take turns at 640px or less, the list or the item with "Back to the
list". `.gk` itself gets no `container-type`: layout containment would trap the fixed overlays.

Layering and scrolling hold a few invariants a change can break:

- The Inbox is isolated (`isolation: isolate`), so nothing inside it, a grid header or a
  scroll thumb included, can cover a header menu.
- Panes scroll with a thin overlay thumb over a hidden native bar, so rows and bands reach the
  pane's edge; wheel, trackpad and keyboard scrolling stay native.
- A pane body is positioned: its absolutely positioned descendants (every `.sr-only` word)
  must scroll and clip with it, or they stretch the page below the Inbox.
- The pending card's decision bar stays reachable at the pane's foot while the SQL scrolls.

## Lists and rows

- A row carries a closed set of facts; the detail carries everything else. No free text
  (reasons, errors) in a row, no middle-dot chains, no decorative side markers.
- Recently resolved and the Audit Trail share one anatomy: the status glyph and title, then
  the marks and the time on the right of line 1; the project bottom left and one fact bottom
  right. Under an Audit Trail session head, rows do not repeat the agent or project, and the
  fact takes that slot.
- Row outcomes: Completed (shown as its fact), Declined, Not run (the gate refused to run an
  approved statement), Failed, Unconfirmed (a question-mark glyph), Expired, Cancelled.
- Marks: a pencil for a write, a trash for a destructive query, the PII and Client flags, and
  Value on a decision recorded before literals stopped being flagged (its stored flags are never
  rewritten). The class icon and the flags show only where the query ran (Completed, Unconfirmed); a
  pending row keeps its icon. Auto mode shows as one bolt, never twice; a decline by the load
  check takes its gauge as the row's glyph.
- The open row is marked by tone, never by a coloured bar. Rows span the pane's full width.
- Pending approval carries the count awaiting a decision; Recently resolved has no count.
- The Audit Trail shows the current month day by day and folds earlier months. Each day is a
  calendar tile with its query and session totals, amber while open; Today opens when there is
  one, otherwise the newest day. Month and session heads carry no count and no export: the
  whole trail exports from one icon in the list pane's head, shown on the Audit Trail tab
  unless the trail has loaded empty.

## The pending card

Flat sections, read top to bottom: who asked, the intent with the risk badge centred on its
first line, the tables, what the SQL marks, the SQL, then the decision.

- **Tables**: an access matrix, one row per table, Read, Write and Delete columns. Delete is
  only for what removes data (DELETE, DROP, TRUNCATE); any other change is Write.
- **Sensitive data**: a legend just above the SQL flagging only what the statement returns to
  the agent, never a column it filters, joins or sorts on, nor a value it carries. A JSON key
  read in a filter counts when a document of the same table column is returned, unchanged or
  wrapped, since the key may reach the agent inside it (operator decision, 2026-10-29); a key
  read through a column that cannot be told apart from another counts too, with the untraced
  line. Each category
  is written as it is marked in the query, with its count (Possible PII, Client data), then the
  outline help mark (`helpCircleIcon`, 12px, faint, its category's colour on hover and focus,
  centred one pixel below the line box, between the cap and lowercase middles). Hover or focus
  opens the exact names and nothing else, no heading, above that entry itself: from its left
  edge, slid left only as far as the pane requires (`placeLegendPop`). No list that repeats
  what the SQL shows. The legend sits 16px under the tables and 10px above the SQL it explains.
- When part of what a statement returns cannot be traced (a table function, recursion, `SHOW`,
  a star over columns that could not be read), one standing line heads the legend in the
  analysis-limit box: "Gatekeeper cannot tell every column this statement returns. The flags
  may be incomplete." Such a decision records the flags found and nothing else; with none found
  it records nothing, so a row never shows an all-clear the analysis could not vouch for.
- A returned name is tinted wherever it appears in the SQL, a filter included: the tint is
  name-based, so a same-name column of another relation is tinted too. A known limit.
- A limit of the analysis sits just above the SQL it qualifies; the state of Auto mode just
  above the decision it hands back. No catch-all findings table.
- **Heavy query**: the load check is a second assessment, never the operation's class. Its badge
  follows Write or Destructive on the intent line (alone on a read), solid amber with its ink
  and a gauge where the class badges are tinted, so it leads the line without reading as a
  class. Its reason sits just above the SQL, before the legend, on a faint warm surface drawn
  from the badge's amber: one sentence, or one point per finding when there are several. There,
  tables and columns stand out on the faint ground of tool names, unlike plain `code.name`. A
  table's estimated rows open on hover or focus of its name in the matrix, or in the reason when
  the card has no matrix. What the check could not establish is not shown: no estimate, no claim.
- An Auto mode hold says where it happened, on this machine before evaluation or at Jev, then
  "Waiting for your review."; a hold on this machine adds "Nothing was sent to TypeSafe." No
  reason chips.
- A blocking reason sits above the actions, tied to the disabled action it blocks
  (`aria-describedby`), not only in a tooltip. Nothing ever says "nothing blocks".
- While Auto mode evaluates, the row's dot turns `--auto` and pulses, with no word, and a ring
  runs around the SQL block at the brackets' width, radius and position, so its fill covers
  them cleanly as it passes.
- The detection toggles (PII, client data) are display preferences for the
  requests still to decide, applied live. Settings and its quick menu show each with a sample
  of what it surfaces, in that detection's own accent.

**Running.** Once execution starts, Stop takes Approve's place, beside "Running" and the
elapsed clock; the expiry clock leaves, since it no longer means anything. Executing is blue on
the button and the SQL frame; from 45 seconds the clock, the button and the frame turn amber
and the button breathes. An auto-stop limit is a quiet countdown after the clock. A failed
Stop gets its own boxed note under the controls: the error glyph, one short sentence ("Stop
could not be confirmed."), then the database's raw error on its own mono line. A Stop the
database cannot offer stays disabled, with its requirement in an amber popover
(`.approve-pop.warn`).

## The decided detail

The outcome comes first, then what was asked.

- **Status**: the outcome word with its glyph (Completed, Declined, Failed, Not run, Expired,
  Cancelled, Result delivery unconfirmed, Execution outcome unknown), then who decided and
  when, as the record states it ("Approved by you", "Declined by you" only where the record
  says a person declined; a decline from before that was recorded names no one). A cancelled request reads "Withdrawn by the agent"; an expired one "Not decided in
  time", or its approver when it had been approved. No count there.
- **Receipt**: a completed query gets one sentence, reads and writes alike: the operation in
  SQL style, its tables, then what it reported, numbers and verbs in bold ("`SELECT` on
  invoices completed, returning **39** rows.", "`UPDATE` on invoices completed, affecting **2**
  rows."). A DDL's conventional zero and a write's empty result are left out. This is the one
  place for the outcome's count; counts that were not recorded add no sentence of their own.
- **Rows**: only a real table of rows gets a framed surface. Its top bar holds Copy and Export
  on the left, on the data they act on (the rows kept for this request, exactly what the agent
  was sent), then Enlarge, the position in those rows ("1–50 of 2,000", "11 of 11") and the pages
  on the right; no footer. Values keep their type: a real null is not the string NULL, numbers
  align right. While kept rows open, the same frame shows with its tools (Enlarge included)
  dimmed and inert and three breathing bars, so the grid lands without moving anything.
- **Enlarge** is an icon-only square at the height of Copy and Export, with their fill and
  edge, named on hover and to readers ("Enlarge", "Enlarge the results"). Its icon is the
  outward arrows, never a magnifier: in a table's bar a magnifier reads as searching the rows.
  It shows wherever rows show, and opens them in the results dialog (see Overlays).
- **Rows that cannot show** get one quiet sentence in their place, whatever the cause (decided
  before rows were kept, a key Beekeeper no longer holds, rows not sealed at execution, a read
  that failed): "These rows are not available." No cause-specific wording: the reader can do
  nothing different about any of them. It shows where rows are owed (a count above zero, or a
  read whose count was never recorded), never for a known zero or a write's empty result.
- **Message**: every outcome that did not complete explains itself in one box headed
  "Message", whose tone carries the difference: neutral for an automatic explanation, the error
  tone for an execution error, amber for a reason a person typed (as the record says). A
  statement the gate refused to run reads "Not run" with the gate's own sentence, neutral. A
  completed query has its receipt instead.
- **Request**: folded under one thin line, "Show request" or "Hide request" followed by the
  intent cut to one line. It starts closed on each item, keeps its state while that item
  updates, and opens in place without touching the grid's page or sort. Open, it shows the same
  matrix, legend and SQL as the pending card.
- A decided request shows every detection, whatever the display toggles say now; its row flags
  are the ones recorded at decision time.

## Overlays

Every overlay window (Settings, the export, the confirms, the database notice, the enlarged
rows) is a modal dialog: `role="dialog"`, `aria-modal`, the visible elements beside it inert
while open (`takeOver` in `src/modal.ts`), the focus inside, then back on the control that opened
it, or on a fallback when that control is gone (the gear for Settings opened from its menu, the
open tab for the notice, which opens on its own, and for the export). Every action in it is a real
button, reachable by keyboard. The database notice opens on Continue and stays until one of its
own buttons: Escape does not dismiss it. Their frame reads solid over the Inbox's veil: a dark
outer line, a light inner line, a shadow, and an engraved Settings head (`.detail > .detail-card`).

Escape removes one layer per press: an open confirm first, then the export, then an open menu or
popover, then the enlarged rows, then Settings, then the Queue's open item.

**Enlarged rows.** Enlarge moves the decided request's own result bar and grid into a dialog
over the whole tab, past the shell's width cap: the grid keeps its sort, page, page size and
column order both ways, uses the height left under its bar up to its last row, and refits its
column widths to the room; its scroll may start again at the top. The head names the request
as its fold does, then the Queue's own label and amber count while something waits (the tab is
under the veil; the button closes the dialog onto the Queue tab and selects nothing), then the
X. It opens with the focus on the rows, so the arrows and Page Down scroll at once, and closes
back to Enlarge. A new selection, a reset or the database notice puts the rows back first.

**Confirms.** An arm confirm says what the mode lets you approve and opens on its action; a
typed challenge (Destructive) opens on its input. When arming turns Auto mode off, one plain
line under the text says so, led by the bolt ("Enabling Write mode automatically turns off Auto
mode."), never an alert box. The run confirm (the double confirmation) is titled by the
operation ("Run this UPDATE?"), says what it does where in one sentence ("It changes rows of
invoices on <db>, once, when you confirm."; an upsert "adds or changes rows of"), then shows the
table matrix and the SQL, its button naming the operation ("Run UPDATE"). It opens on Cancel,
so Enter twice from Approve never runs a write, and it closes itself when its request expires
or goes away.

**Export.** The Audit Trail export picks a period first, each with its dates (Today, Last 7
days by default, This month, Everything, Choose days), then a format, then names what it saves
("Export 31 queries"). It reads the trail only as far as the period needs, and states the scope
as facts only once every day in it has been read; until then the line above the action says
how far reading got. Choose days lists whole days in the trail's anatomy, month by month; a
ticked month means the calendar month, days not read yet included. Its radios and checkboxes
are neutral (a muted fill): picking is not a decision, so no colour stands for it. One sentence
says what the file holds and that result rows never are.

**SQL formatting** is for display only: SET, RETURNING and each top-level AND or OR of a
condition start a line; subqueries and parenthesised groups stay on one; a canonical token check
falls back to the original text on any drift.

## Empty states

An empty list draws the honeycomb under a plain title ("Queue is empty", "Audit Trail is
empty"); an empty Pending approval above resolved rows takes its compact form. The Queue's
right pane shows three steps while no agent is connected, and the waiting mark with "N agents
connected" otherwise. The empty Audit Trail's right pane says what it keeps for the
connection.

## Keyboard and focus

- A rebuild that removes the focused control (Approve, Stop, a sent reason) hands the focus to
  the open item's row, now its outcome row; to Back in a narrow tab, where the list is hidden;
  to the open tab when the row is gone or folded away. When a human decision opens the next
  request, the focus follows to its row (to Back, narrow) if it was on the decided request or
  nowhere; anywhere else, an overlay or another row, it stays. A decision made in the
  background never moves the focus. An Escape from the page body still reaches the Inbox.
- The Queue's open item closes with its X (on the item's first line, never sticky; wide only)
  or Escape, with the same focus fallbacks. The Audit Trail has no close.
- In a narrow tab, opening an item focuses "Back to the list"; Back returns to the row, or to
  the open tab when the row is gone.
- Polling and the request fold never remount a decided result, so its grid keeps its page and
  sort.

## Motion

Motion serves a purpose and respects `prefers-reduced-motion`; content is visible by default
and never waits on an animation.

- Durations and easings come from `tokens.css` (`--ease-out` in, `--ease-in` out,
  `--ease-in-out` toggles, `--dur-micro/short/long`); `src/anim.ts` mirrors them for JS.
- JS entrances go through the `anim.ts` helpers: `reveal` staggers the panel at mount, `enter`
  brings in a fresh row, `pulse` drives the waiting mark. CSS keyframes handle the rest (the
  executing spinner, the overlay entrance, the evaluating dot, skeletons, a decided row leaving
  Pending approval).
- Animate `transform` and `opacity` by default. Two properties are exceptions, each with a
  purpose: the Auto ring's fill and the star's halo.
- Infinite loops are for liveness and waiting: an active agent, a connecting or failing status,
  an evaluation, the waiting mark. Two invitations also loop, the star's halo and the release
  arrow's nudge; add no other decorative loop or glow. A green dot holds still; data never
  pulses.
- A layout tier change never retriggers an entrance.

## Anti-slop

After `pols.dev/slop.md`:

- One solid action (Approve) with quiet text actions beside it; never the filled-plus-outlined
  pair.
- No gratuitous pills: the risk and heavy query badges, agent chips and tool chips each carry a
  meaning; a status needs no chip.
- No accent bar down a card edge, no coloured rail as the only signal.
- No middle-dot separators chaining facts; separate them by position and alignment.
- No new glow and no new colour for emphasis. Terse copy. Buttons do not move on hover.

## Extending the panel

Add state through the existing tokens, styles and signatures. If something needs emphasis, use
weight, tone or the amber accent sparingly, not a new colour, a chip, a glow or a hairline.
When in doubt, run the change through `pols.dev/slop.md`.
