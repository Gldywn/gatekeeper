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

- **Sans (system-ui)** carries all prose: the wordmark, intents, section labels,
  buttons, the blocked note.
- **Monospace carries data only**: SQL, the expiry clock, request ids, row
  counts, the connection identifier. Mono is never the voice for labels; that is
  the "monospace as house voice" slop tell.

Headings are always roman (no italic display).

## The signatures (keep these)

1. **Amber corner-frame** on every SQL block: two 12px amber brackets at the
   top-left and bottom-right corners (`.sql::before/::after`). It turns red on a
   blocked (non-SELECT) card. This is a bespoke bracket, not an accent bar.
2. **Honeycomb-cell mark**: a hexagon with a smaller filled hexagon inside, plus
   a faint honeycomb cluster in the header. Beekeeper's motif, kept subtle
   (~10% opacity).
3. **Tonal edges**: containers get a self-colored 1px edge at low opacity plus a
   faint top highlight (`inset 0 1px 0`), never a hard contrasting hairline.

## Responsive

The shell is fluid, not a fixed 560px column: `.gk` caps at `min(94vw, 1180px)`
and centres, with fluid `padding-inline`. Above `56.25rem` it becomes a two-zone
layout, a fixed-width `rail` (roster + connection card) beside a fluid `main`
(the pending queue and history), placed by grid areas. The two zones are a
first-class decision: the rail is reference context, the queue is the work.

Breakpoints are **CSS container queries**, not viewport media, because a zone's
width diverges from the viewport once the layout splits: at a 1200px viewport the
rail is ~240px and `main` is ~900px, so each must react to its own width. Three
named container contexts carry this:

- `gk-roster` on `.rail`: shows the per-agent task line only when the rail is
  stacked full-width, hides it in the compact ~220-260px rail.
- `gk-main` on `.main`: the history row reveals the who / SQL columns as `main`
  widens (`23.75rem`, then `40rem`), each tier keeping its grid track count equal
  to its visible spans.
- `gk-detail` on `.detail-card`: cell caps scale with the card width (`cqi`).

The one exception is the shell split itself, which is a viewport media query
(`@media (min-width: 56.25rem)`) rather than a shell container: giving `.gk` a
`container-type` would apply layout containment and trap the fixed `.detail`
overlay it wraps, and an element cannot query its own container. The shell width
tracks the viewport at `94vw`, so the viewport query is the right owner there.

A `@supports not (container-type: inline-size)` block mirrors the `gk-main`
breakpoints as viewport media queries for browsers without container-query
support (Beekeeper's Chromium has it since 105).

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

Add new state through the existing tokens and the two signatures. If something
needs emphasis, use weight, tone, or the amber accent (sparingly), not a new
colour, a chip, a glow, or a hairline. When in doubt, run the change through
`pols.dev/slop.md` before shipping.
