# AGENTS.md

How any coding agent works in this repository. Build steps, commands and the repo layout
are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). This file only adds what an agent must
know on top of it.

## What this is

Gatekeeper lets an AI agent propose SQL that a human approves and runs in Beekeeper Studio.
`packages/server` is the MCP server plus a loopback broker (published to npm).
`packages/plugin` is the Beekeeper Studio plugin: the approval UI and the only component that
executes SQL. `packages/shared` holds the wire types and the design tokens.
`skills/gatekeeper` is the agent skill. `landing/` is the marketing site, not the product.

Read before changing:

- data flow or behaviour: `docs/ARCHITECTURE.md`
- risk classification, pairing, access modes, data handling: `SECURITY.md`
- any plugin UI: `packages/plugin/DESIGN.md`. Reuse its tokens and existing components
  before adding a new treatment.

## Toolchain

pnpm only (the version in `packageManager`), Node >= 22. Never npm, yarn or bun.
Dependencies are exact-pinned and quarantined for 7 days (`.npmrc`, `pnpm-workspace.yaml`).
Ask before adding or bumping one.

## Checks before handing work back

```bash
pnpm typecheck
pnpm test        # Vitest, no database needed
pnpm lint        # Biome
```

One package at a time: `pnpm --filter @gatekeeper/plugin test` or
`pnpm --filter @gldywn/gatekeeper-mcp-server test` (the server keeps its npm name, so
`@gatekeeper/server` matches nothing and exits 0 without running a test).

## Seeing a plugin change

Agents judge UI work in the fixture preview: the real plugin, with its stylesheet and
Tabulator, over a fake Beekeeper host and an in-memory broker fed with synthetic data
(`packages/plugin/preview/`, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)). It touches none
of the machine-wide state below. It listens on port 5199 and refuses a taken port, so a second
worktree adds `--port 5200` (any free port) and uses that port in its URLs.

1. `pnpm --filter @gatekeeper/plugin preview:fixtures`, then open
   `http://127.0.0.1:5199/preview/index.html` in a browser you can capture (in Orca, the
   embedded browser and `orca-screenshot`).
2. Render before calling it done. Capture the change wide and in
   `preview/frame.html?w=440&h=760`, with the scenario that exercises it (`agents=20`,
   `queue=0`, `history=0`...). Capture once the rows are in and the reveal animation is over;
   a capture right after a load can show the page still fading in. A case the fixtures do not
   cover gets its own synthetic fixture in `preview/fixtures.ts`.
3. Check alignment on a magnified capture (a CSS transform on the page), against the
   elements next to it: a count on its label's baseline, an icon centred in its button, row
   edges on one line. Magnifying shows alignment; it does not test browser zoom or reflow.
4. Drive interactions in the page (clicks, a narrow frame) and read the DOM state back.
   Check keyboard paths with real key presses (`orca keypress`) and `document.activeElement`:
   a scripted click or Escape proves nothing about the keyboard.
5. For a substantive UI change, compare the behaviour with `origin/main` so nothing is lost
   (features, keyboard paths, live updates), and have an agent of another model family
   cross-read the diff before committing.

The human checks the real plugin inside Beekeeper Studio once before merging:

1. `pnpm dev:link` builds, then points Beekeeper's plugin slot at this checkout. An installed
   release is moved aside and `pnpm dev:unlink` puts it back. `pnpm dev:status` shows what
   points where.
2. `pnpm --filter @gatekeeper/plugin dev` starts Vite with hot reload inside Beekeeper
   (`pnpm dev` also starts the Docker test databases first). Restart Beekeeper once after
   linking.
3. Connect Beekeeper to the test databases from `pnpm db:up` (synthetic data), never to a
   real database.

Never set `BKS_FORCE_INSTALL=1`: the Beekeeper Vite plugin then deletes whatever sits in the
slot, installed release included, with no backup. When Vite stops, `dist/index.html` is still
the dev shim, so run `pnpm build` before testing a real install.

## The MCP server and the shared queue

`.mcp.json` and `opencode.jsonc` start this checkout's `packages/server/dist/index.js` whenever
an agent session opens in the repo. It takes over nothing: while the human's `pnpm dev` holds
the broker port it runs MCP-only and shares `~/.gatekeeper/requests.db` with it. Your MCP tools
are therefore this branch's last build, not its current sources: an MCP change reaches you only
after `pnpm --filter @gldywn/gatekeeper-mcp-server build` and a reconnect, so tell the user
before reconnecting. A worktree with no build has no Gatekeeper tools.

`pnpm dev` and `pnpm dev:server` run `scripts/dev-server.mjs`, which kills every other
Gatekeeper server on the machine, then keeps the broker port until it stops. Never run them,
nor the script, yourself.

## Conventions

- English for code, comments, docs and commits. Comments explain why, not what.
- Conventional Commits: release-please derives versions and changelogs from them
  (`docs/RELEASING.md`).
- `packages/plugin/src/sql/classify.ts` is the execution gate. A change there comes with a
  test for the new case and never relaxes an existing one.
- Credentials, pairing tokens and result rows never go to logs, fixtures or MCP payloads
  beyond what `SECURITY.md` allows.
- Throwaway experiments go in `.scratch/` (gitignored).
