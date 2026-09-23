# Development

## Build from source

Prerequisites: Node >= 22, pnpm, and Beekeeper Studio >= 5.4 to run the plugin.

```bash
pnpm install
pnpm build
```

On macOS `pnpm build` also builds and signs the notification helper, which needs the Xcode
command line tools; it is skipped with a printed reason when they are absent or when you are
on another platform, and rebuilt only when its sources change. If the helper is missing the
server says so at startup rather than staying quiet.

## Commands

```
pnpm build       # build both packages
pnpm test        # server + plugin test suites (vitest)
pnpm lint        # biome check
pnpm format      # biome format --write
pnpm ci          # typecheck + build + test
pnpm dev         # test databases + Vite hot reload + Gatekeeper server with watch
pnpm dev:server  # take over the broker and restart the server on source changes
pnpm dev:link    # symlink Beekeeper's plugin + the agent skill at this checkout (builds first)
pnpm dev:unlink  # remove those dev symlinks
pnpm dev:status  # show what points where (plugin, skill, broker, token)
pnpm dev:reset   # clear the pairing token (add -- --all to also wipe the results DB)
pnpm db:up       # start the Postgres and MySQL test containers
pnpm db:down     # stop them (add -- -v to wipe the data)
```

## Dev wiring

The repo ships its dev wiring, so a clone is ready without hand-editing config:

- **Full development:** `pnpm run dev` waits for the test databases, then uses pnpm's
  parallel runner to start Vite and the Gatekeeper server watcher together. Keep this
  terminal open. Stop any separately launched Vite instance first. Server takeover
  stops other detected Gatekeeper instances and may require reconnecting agent MCP
  sessions. The terminal server serves the plugin's broker requests, while each agent
  still needs its own configured MCP connection.
- **Server, live:** run `pnpm run dev:server` from the checkout you want to test.
  It stops other detected Gatekeeper servers and watchers, then runs the local TypeScript
  sources with the installed `tsx watch`. Saving an imported source file restarts the
  server without a build. Keep the terminal open. Existing MCP connections may need
  reconnecting after takeover or restart. A client configured with `dev-server.mjs`
  takes control again when reconnected, replacing this watcher with its configured run.
  This command does not start Vite or change the plugin link. It fails if process
  discovery is blocked or the broker port remains occupied. See [tsx watch](https://tsx.is/watch-mode).
- **Claude Code and OpenCode** read the committed `.mcp.json` / `opencode.jsonc` when you run
  the agent inside the repo, spawning your local build automatically (Claude Code prompts
  once to trust the workspace). Both launch `scripts/dev-server.mjs`, which first kills any
  other running Gatekeeper server, so your build is the sole broker and the only writer of
  the shared `~/.gatekeeper/requests.db` (mixed builds corrupt it), then execs the local
  server. A reconnect re-runs it.
- **Codex** has no project-local config; add the server by hand to `~/.codex/config.toml`
  under `[mcp_servers.gatekeeper]` with `command = "node"` and an absolute `args` path to
  `packages/server/dist/index.js`.
- **Plugin:** `pnpm dev:link` symlinks `packages/plugin/` into Beekeeper's plugins folder, so
  a rebuild is picked up without reinstalling. Run it from any checkout or worktree; it
  targets that one. An installed release in the slot is moved to
  `gatekeeper-plugin.pre-dev` next to the plugins folder (outside it, so Beekeeper never sees
  two `gatekeeper` plugins) and put back by `dev:unlink`, so switching between the release
  and your checkout is one command each way. To also symlink the skill for live editing, list agent skills dirs in a
  gitignored `.dev-skills` at the repo root (one path per line), or set
  `GATEKEEPER_SKILLS_DIRS` to override; a real folder at a target is moved aside to
  `gatekeeper.pre-dev` and restored on `dev:unlink`. With neither, `dev:link` leaves skills
  alone.
- **Plugin UI, live:** `pnpm dev` starts Vite alongside the server watcher after the test
  databases are ready. Vite provides hot reload inside Beekeeper Studio, so UI work needs
  no `pnpm build` at all. The manifest keeps
  pointing at `dist/index.html`; in dev the Vite plugin rewrites that file into a shim whose
  assets resolve to `http://localhost:<port>`, with the HMR client injected. A CSS edit lands
  without even reloading the tab. Caveat: that shim stays on disk when the dev server stops,
  and it is inert without it, so run `pnpm build` before packaging or testing a real install.
- **Test databases:** `pnpm db:up` starts the Postgres and MySQL containers in
  `test-db/compose.yaml` (synthetic data, never a real target) and waits for both to pass
  their healthcheck, so nothing connects to a half-initialised server. Host ports are
  deliberately unusual (`54329`, `33069`) to avoid colliding with a real local install; both
  use `gatekeeper_test` as database, user, and password. `pnpm db:down` stops them, keeping
  the volumes; add `-- -v` to wipe the data too. `pnpm dev` runs `db:up` first, so use
  `pnpm --filter @gatekeeper/plugin dev` to start Vite alone when Docker is not running.
- **Auto mode catalog fixture:** `test-db/auto-catalog/` holds SQL applied by hand in
  Beekeeper to the synthetic Postgres database, never run automatically. It backs the
  human-driven "Real catalog check" in [Auto mode](AUTO-MODE.md). `cleanup.sql` removes it.

## Editing the agent skill

The skill is a single model-agnostic `SKILL.md` under
[`skills/gatekeeper/`](../skills/gatekeeper/SKILL.md), distributed through the
[skills.sh](https://skills.sh) CLI. To change it: edit `skills/gatekeeper/SKILL.md`, commit,
and re-sync installed copies with `npx skills update`. `pnpm dev:link` can symlink it into
your agents' skills folders for live editing (see Dev wiring above).

## Repo layout

```
packages/
  server/
    src/
      index.ts       broker + MCP wiring, token, shutdown
      broker.ts      loopback HTTP endpoints
      mcp.ts         MCP tools
      pairing.ts     pairing gate on every tool, agent-facing notice
      pairing-page.ts  the CORS-free page that shows the code
      service.ts     submit / get / cancel, ticket shaping, read-only preflight
      store.ts       durable SQLite lease queue + audit trail
      connection.ts  non-sensitive connection snapshot
      policy.ts      server-side advisory risk classifier (blocks empty/multi-statement)
      config.ts      environment and constants
  plugin/
    manifest.json
    index.html
    src/
      app.ts         UI, polling, lease renewal, approve / reject, history
      sql/classify.ts  dialect-aware risk classifier (the execution gate)
      sql/sanitize.ts  surfaces bidi/invisible chars in displayed SQL
      result.ts      result caps (local history + agent-bound)
      style.css
    DESIGN.md        plugin design system
  shared/
    src/index.ts     wire-contract types shared by server + plugin
    tokens.css       design tokens shared by plugin + landing
landing/             marketing site (not part of the shipped product)
skills/gatekeeper/   the agent skill, installed with `npx skills add`
docs/                architecture, MCP tools, configuration, release runbook
.github/workflows/   release-please, plugin release assets, npm publish
.mcp.json.example    MCP client stub
biome.json           lint + format
SECURITY.md          supply-chain policy + DB boundary
```

## Tech stack

- **Plugin:** TypeScript, Vite, `@beekeeperstudio/plugin`, `node-sql-parser`. Requires
  Beekeeper Studio >= 5.4.
- **Server:** TypeScript, `@modelcontextprotocol/sdk`, `better-sqlite3`, Node's built-in
  `http`. Published to npm as `@gldywn/gatekeeper-mcp-server`. Requires Node >= 22, the floor
  at which `better-sqlite3` ships a prebuilt binary so `npx` needs no C++ toolchain.
- **Tooling:** Biome (lint + format), Vitest, pnpm workspaces with an exact-pin, quarantined
  supply-chain policy.

## Releasing

Releases are conventional-commit driven. See [`RELEASING.md`](./RELEASING.md) for how a
version reaches the Beekeeper plugin manager and npm.

## References

- Beekeeper plugin API: https://docs.beekeeperstudio.io/plugin_development/api-reference/
- Beekeeper plugin architecture: https://docs.beekeeperstudio.io/plugin_development/
- MCP: https://modelcontextprotocol.io
