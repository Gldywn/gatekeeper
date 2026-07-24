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

## Motion

Three purposeful primitives, all gated behind `prefers-reduced-motion`:
- the executing spinner,
- the resolved card sliding down into history (`transform`, not opacity-to-0),
- the live expiry countdown (a number that counts; it shifts to amber under 45s,
  it does not pulse).

Content is always visible by default. Never gate a card or control on an
animation completing.

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
