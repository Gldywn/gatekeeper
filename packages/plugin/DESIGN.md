# Gatekeeper plugin design system

The plugin renders inside Beekeeper Studio, so it should read as native to it.
This is the studied DNA (from beekeeperstudio.io) and the rules that keep future
changes coherent. Keep to the tokens; do not improvise values.

## Identity in one line

Amber-on-dark, theme-aware, terse. Two signature moves carry it: a subtle
honeycomb texture and an amber corner-frame on the SQL.

## Surfaces are theme-driven

The plugin is not a fixed dark theme. Surfaces map to Beekeeper's injected
`--theme-*` variables so it follows the user's light or dark theme; the dark
values in `style.css` are only fallbacks for a standalone preview.

| Token | Source | Role |
| --- | --- | --- |
| `--ground` | `--query-editor-bg` | page background |
| `--surface` | `--theme-bg` | cards, header |
| `--text` | `--text-dark` | primary text |
| `--amber` | `--theme-primary` (~`#e8c435`) | the accent |
| `--ok` / `--danger` | `--brand-success` / `--brand-danger` | approved / rejected |
| `--edge` / `--hi` | derived from `--text` at low opacity | self-colored edges |

## Colour rule: it only ever means something

`--amber` is the primary action and the "held" state, nothing decorative.
Green means approved, red means rejected or blocked, blue means executing.
`--auto`, an electric cyan kept brighter and greener than `--exec`, means Auto mode
and nothing else. It never gets a component of its own: the active state is the
armed chip in cyan, the entry is the Schema access hint with a cyan dot, and the
card note and history glyph reuse theirs.

Versions follow the same rule: amber only when the plugin and the server are out of step,
on the side that has to act. A newer release while both agree is good news: green, with an
up arrow that nudges in the corner indicator now and then; the installed version stays plain.

Feature hints (Schema access, Auto mode) share one shape: an icon with a pulsing
dot while off, and a popover on hover or keyboard focus with one direct action,
filled to enable and tinted to disable. Clicking the icon opens its Settings section,
so the popover carries no Settings link. Explanations stay short there, full detail
lives in Settings.

## Secondary sentences

A setting says what it does in its description; anything secondary (its default, its scope,
a consequence) goes in `.set-note`: italic, faint, a full sentence ending with a period, on
its own line under the description, or inline at its end when it is a two-word tail ("Off by
default."). Status lines that only time something, like the database popover's "Checking
again in 8s.", use the same voice.

## Unavailable features and errors

A feature a database cannot offer is a warning, not an error: its control stays visible but
disabled, and the reason rides in the amber variant of the blocked-Approve popover
(`.approve-pop.warn`), worded as the requirement it misses: `<what> is required to <action>.`
(`STOP_NEEDS` in `sql/stop.ts`, "PostgreSQL 10 or later is required to stop a query."). Blockers
use the same form ("Write mode is required to approve this query."), so a reason states what
would unlock the action instead of reading as a bug.

An action that failed is an error: the card's boxed note (`.cs-unparsed`) with the red
failed-outcome mark (`xCircleIcon`), one short sentence in the UI face, then the raw error
from the host on its own mono line under it (`.stop-raw`), the way the detail pane shows a
failed query. No narration of the cause in the sentence; the raw text carries the specifics.

## Running row

Once a query is approved, Stop takes Approve's place from the first frame, beside "Running"
and the elapsed clock (mono, data). Blue means executing, so the button and the SQL frame
take `--exec`; from 45 s the clock, the button and the frame turn amber and the button
breathes with the armed-mode pulse, the cue that the run is long. An auto-stop limit shows
as a quiet countdown after the clock. The expiry clock leaves the card's top row while the
query runs, since it no longer means anything.

## Type: two roles

- **Sans (system-ui)** carries all prose: intents, section labels, buttons, the
  blocked note.
- **Monospace carries data only**: SQL, the expiry clock, request ids, row
  counts, the connection identifier. Mono is never the voice for labels; that is
  the "monospace as house voice" slop tell.

Headings are always roman (no italic display).

## The signatures (keep these)

1. **Amber corner-frame** on every SQL block: two 12px amber brackets at the
   top-left and bottom-right corners (`.sql::before/::after`). It turns red on a
   blocked (non-SELECT) card. This is a bespoke bracket, not an accent bar.
2. **Honeycomb cluster**: a faint hexagon cluster behind the header content,
   Beekeeper's motif kept subtle (~10% opacity). It carries the brand alone: the
   header shows no logo and no wordmark, because inside Beekeeper the plugin is
   already named by its tab, and the row is more useful starting on the
   connection.
3. **Tonal edges**: containers get a self-colored 1px edge at low opacity plus a
   faint top highlight (`inset 0 1px 0`), never a hard contrasting hairline.

## Connection identity

One chip, built once (`connChipInner`) for the header. It reads database glyph, connection name,
dialect, database. Two rules hold it:

- **The database is always spelled out**, even when it repeats the connection
  name. Where a query is about to run is stated, never inferred.
- **No schema.** A proposal can target any schema, so the session's current one
  would describe the connection rather than the queries the queue governs.

The header wraps it as a bordered object and makes its database glyph live: a dot on
the glyph is the last endpoint check (green passed and still, amber failed and pulsing, red
three failures in a row, none when the engine has no check), and hovering or focusing the
glyph opens the popover, headed "Database", with that check, then the read-only layers. The header shows no other check or read-only word; the detail
lives in the popover.

Right after the chip, the link to the Gatekeeper server follows the same pattern in its own
place: a bare robot glyph with no fill, so it never reads as one of the buttons on the right,
with the same dot bottom right (green and still while answering; amber connecting or retrying,
pulsing; crossed-out red robot once unreachable), no word in
any state, and a popover with the status alone. Statuses sit on the left, settings (Auto
mode, Schema access, the gear) on the right. Only one status popover shows at a time, and
Escape hides the server one.

## Layout

The shell fills the tab's height (`.gk`, `height: 100vh`, capped at 1440px wide) in three
rows: the top (the header, then the agents strip), the Inbox, and the status line. Only the
Inbox panes scroll; the header and the status line stay on screen.

The header carries the sole connection context (name, dialect, database, connection
check). Under it, the agents strip is one line of chips, one per agent: presence dot, tool
icon (the tool is never spelled out, the icon is enough), project and the active/idle meta,
ordered by presence then recent activity. It shows no count of what waits: the queue owns
that, with its own definition. Chips that do not fit fold into "+N more", which opens the
full roster in a popover with the same facts; the session task shows on hover only, in both.
The strip never grows a second line. With no agent, it says so in one line, with what makes
one appear.

The Inbox puts the list and the open item side by side. The list pane has two tabs, Queue
(Pending approval, then Recently resolved) and Audit Trail, and each tab keeps its own
selection. A row opens in the right pane: a pending proposal as its full card, a decided
request as its detail, the same detail for Recently resolved and the Audit Trail. Nothing
opens by itself; with nothing selected, the right pane says what waits. Rows span the pane's
full width, and the open row is marked by tone, never by a coloured bar.

The status line holds the version on the left and the star and feedback buttons on the
right, docked in the layout rather than floating over the panes.

Two named **container query** contexts, each reacting to its own box rather than the
viewport:

- `gk-inbox` on `.inbox` (size): at 640px wide or less the panes take turns, the list or
  the open item with "Back to the list".
- `gk-detail` on `.detail-card`: cell caps scale with the card width (`cqi`).

`.gk` itself gets no `container-type` on purpose: that would apply layout containment and
trap the fixed overlays it wraps (Settings, the confirm and notice dialogs).

## Motion

Motion is centralised. JS animation goes through `src/anim.ts` (a thin wrapper on
the `motion` library, Web Animations API, CSP-safe); animation on a pseudo-element
goes through a gated CSS keyframe. Both draw on the same `style.css` tokens:
`--ease-out` for entrances, `--ease-in` for exits, `--ease-in-out` for toggles, and
the `--dur-micro/short/long` buckets. Exits run at roughly 75% of the enter.

Rules:
- Animate `transform` and `opacity` only. Nothing that triggers layout.
- Everything is gated behind `prefers-reduced-motion` (the `anim.ts` helpers no-op
  under reduce; CSS keyframes live inside `@media (prefers-reduced-motion:
  no-preference)`).
- Infinite loops are for functional liveness or waiting indicators only, kept
  subtle: the active-agent dot, the server dot while connecting and a failed connection check
  dot pulse, the "waiting for a proposal" empty state breathes. A green status dot holds still:
  all being well needs no motion. Nothing decorative loops, and data never
  pulses (the expiry countdown shifts to amber under 45s, it does not pulse).
- Content is always visible by default. Never gate a card or control on an
  animation completing.
- Layout-tier changes are owned by CSS container queries (plus the two viewport
  media queries that rehang header popovers), never a JS resize/`matchMedia` listener that
  re-renders. A tier change must never retrigger `enter()` or `reveal()`; CSS
  alone decides visibility and cropping.

The primitives: the executing spinner; the decided row fading down out of the queue list
(`.leaving`); a staggered fade-up of the panel blocks on mount
(`reveal`); a fade-up entrance for a fresh proposal card (`enter`); and the
functional `pulse`/`breathe` loops above.

To add one, reach for an `anim.ts` helper (or a gated CSS keyframe for a
pseudo-element), reuse the tokens, and keep it only if you can say what it
communicates. If you cannot, cut it.

## Anti-slop rules that shaped this (from pols.dev/slop.md)

- One solid action (`Approve`) with a quiet text action (`Reject`); never the
  filled-plus-outlined button pair.
- No status pill chips. The count is plain amber text; only the rare blocked
  card is marked, with a red note.
- Self-colored tonal edges, not hard hairline borders on every box.
- No accent bar down a card edge.
- Terse copy. Buttons do not move on hover.

## Extending the panel

Add new state through the existing tokens and the three signatures. If something
needs emphasis, use weight, tone, or the amber accent (sparingly), not a new
colour, a chip, a glow, or a hairline. When in doubt, run the change through
`pols.dev/slop.md` before shipping.
