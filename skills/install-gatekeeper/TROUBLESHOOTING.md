# Gatekeeper install troubleshooting

Read this only when something misbehaves during an install. It is the companion to `SKILL.md` next to it, and nothing here is part of the normal path.

## When the plugin never shows up

Beekeeper ships with its plugin system locked down, so a fresh install can ignore a third-party plugin entirely. Three checks, in order.

**1. The folder name.** Exactly `gatekeeper`, not `gatekeeper-0.1.1`, with `manifest.json` directly inside it. A mismatch is skipped in silence.

**2. The plugin system is enabled.** The shipped default is `pluginSystem.disabled = true`, with an allowlist holding only Beekeeper's own two plugins. Add to the user config, then restart:

```ini
[pluginSystem]
disabled = false
```

**3. Community plugins are enabled.** `communityDisabled = true` is a shipped default too. If the plugin manager says "Community plugins are disabled via configuration", add `communityDisabled = false` in the same block.

| OS | User config file |
|---|---|
| macOS | `~/Library/Application Support/beekeeper-studio/user.config.ini` |
| Linux | `~/.config/beekeeper-studio/user.config.ini` |
| Windows | `%APPDATA%\beekeeper-studio\user.config.ini` |

## Other things that go wrong

- **No Gatekeeper tools in the agent at all.** The session predates the config change: restart it. If a fresh session still has none, the config edit did not land where that harness reads it. Read the file back and check the key name matches the shape in step 2 exactly (`mcpServers` versus `mcp_servers` versus `mcp` is per-harness, not a matter of taste).
- **The server fails to start.** Run `npx -y @gldywn/gatekeeper-mcp-server` in a terminal and read the error. Node older than 22 and a proxy blocking the npm registry are the two usual causes. A correct start prints `[gatekeeper] broker on http://127.0.0.1:9999` and `[gatekeeper] MCP server ready on stdio` on stderr, then waits on stdin, which looks like a hang and is not one: Ctrl-C out. To check the broker is up without reading the pairing code, `lsof -i :9999` (or `nc -z 127.0.0.1 9999`) tells you something is listening, which is all you need.
- **`NOT_PAIRED` again after it worked.** The plugin keeps its token in Beekeeper's encrypted storage under the plugin id, not in the plugin folder, so replacing that folder for an upgrade keeps the pairing. What does break it: a fresh Beekeeper profile, cleared plugin storage, or a deleted `~/.gatekeeper` on the server side, since the server then generates a different token. Re-pair, it costs one code.
- **The code is refused.** It is single use and expires in about five minutes, and five wrong guesses kill it. Fetch a fresh one by calling a Gatekeeper tool again.
- **`connected: false` or a stale `capturedAt` in `get_connection_info`.** Beekeeper is closed, or the plugin tab is not open. No approval can arrive: say so plainly rather than waiting.
- **Approvals prompt on every poll.** Some harnesses confirm each MCP call. Ask the human once to auto-allow the low-stakes read-only tools (`poll_results`, `get_query_result`, `get_schema`, `get_connection_info`, `set_session_label`) and leave `submit_query` and `run_query` on manual approval, since Gatekeeper already gates those with a human.
