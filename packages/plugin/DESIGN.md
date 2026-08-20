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
Never introduce a colour that is not one of these, and never use amber as a
generic highlight.

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

One chip, built once (`connChipInner`) and used by both surfaces that need it:
the header and the audit-trail head. It reads database glyph, connection name,
dialect, database. Two rules hold it:

- **The database is always spelled out**, even when it repeats the connection
  name. Where a query is about to run is stated, never inferred.
- **No schema.** A proposal can target any schema, so the session's current one
  would describe the connection rather than the queries the queue governs.

The header wraps it as a bordered object. The audit-trail head renders the same
chip flat (no border, no fill, middot-separated, no amber on the dialect): its
seated title bar already frames it, and a bordered chip beside the title only
stacked edge on edge.

## Responsive

The shell is fluid, not a fixed 560px column: `.gk` caps at `min(94vw, 1180px)`
and centres, with fluid `padding-inline`. It stacks in one column: the header
(which carries the sole connection context: name, dialect, database, read-only),
then a full-width **band** (`.rail`, the connected-agents roster),
then the queue and history. The band is reference context read at a glance; the
queue owns the width, because the SQL blocks and result tables benefit from it.

The roster is a grid of agent cells (`repeat(auto-fill, minmax(19rem, 1fr))`) so
it flows into as many columns as fit and stays short. Each cell carries the
presence dot, tool icon (the tool is never spelled out, the icon is enough),
project, the active/idle meta, and the session task on its own wrapped line,
never truncated. The cryptic `sess_…` tag lives only on the queue group header,
where it maps a group of proposals back to its agent.

Two named **container query** contexts remain, each reacting to its own width
rather than the viewport:

- `gk-main` on `.main`: the history row reveals the who / SQL columns as `main`
  widens (`23.75rem`, then `40rem`), each tier keeping its grid track count equal
  to its visible spans.
- `gk-detail` on `.detail-card`: cell caps scale with the card width (`cqi`).

`.gk` itself gets no `container-type` on purpose: that would apply layout
containment and trap the fixed `.detail` overlay it wraps. A `@supports not
(container-type: inline-size)` block mirrors the `gk-main` breakpoints as viewport
media queries for browsers without container-query support (Beekeeper's Chromium
has it since 105).

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
  subtle: the active-agent dot and the connecting status dot pulse, the "waiting
  for a proposal" empty state breathes. Nothing decorative loops, and data never
  pulses (the expiry countdown shifts to amber under 45s, it does not pulse).
- Content is always visible by default. Never gate a card or control on an
  animation completing.
- Layout-tier changes are owned by CSS container queries (plus the one viewport
  media query for the shell split), never a JS resize/`matchMedia` listener that
  re-renders. A tier change must never retrigger `enter()` or `reveal()`; CSS
  alone decides visibility and cropping.

The primitives: the executing spinner; the resolved card sliding down into history
(`transform`, not opacity-to-0); a staggered fade-up of the panel blocks on mount
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
