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
`pnpm --filter @gatekeeper/server test`.

## Seeing a plugin change in Beekeeper Studio

Judge UI work in the real plugin inside Beekeeper Studio, not in a standalone page or a
mocked host.

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

`.mcp.json` and `opencode.jsonc` start `scripts/dev-server.mjs` whenever an agent session
opens in the repo. It kills every other Gatekeeper server on the machine, including those
other sessions rely on, so that one build owns the broker port and `~/.gatekeeper/requests.db`.
Never run it by hand, and tell the user before reconnecting the MCP server. A server change
reaches the broker only after `pnpm --filter @gatekeeper/server build` and a reconnect.

## Conventions

- English for code, comments, docs and commits. Comments explain why, not what.
- Conventional Commits: release-please derives versions and changelogs from them
  (`docs/RELEASING.md`).
- `packages/plugin/src/sql/classify.ts` is the execution gate. A change there comes with a
  test for the new case and never relaxes an existing one.
- Credentials, pairing tokens and result rows never go to logs, fixtures or MCP payloads
  beyond what `SECURITY.md` allows.
- Throwaway experiments go in `.scratch/` (gitignored).
