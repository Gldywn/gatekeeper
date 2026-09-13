---
name: install-gatekeeper
description: Install Gatekeeper end to end and leave it working, meaning the Beekeeper Studio plugin, the MCP server registered with the agent, the companion gatekeeper skill, and the one-time pairing. Do every part the environment allows, then hand the human a precise checklist for the rest. Use when someone asks to install, set up, finish setting up, update, uninstall or repair Gatekeeper, when the Gatekeeper MCP tools are missing or the server will not connect, or when the plugin has never been installed or paired.
version: 1.0.1
---

# Install Gatekeeper

Gatekeeper is a human-approved bridge between an agent and a live database: the agent proposes SQL, a human approves it in Beekeeper Studio, and the rows come back. Nothing runs unapproved, and the agent never holds the credentials.

Installing it means putting four pieces in place on one machine. Do every piece your environment lets you do, verify each against something you can observe, and finish with a short, exact list of what only the human can do.

| Piece | What it is | Who does it |
|---|---|---|
| Beekeeper Studio plugin | The approval UI, running inside Beekeeper | You download and extract it; the human restarts Beekeeper |
| MCP server | `@gldywn/gatekeeper-mcp-server`, launched by the agent's MCP client | You register it; it only comes alive in a fresh agent session |
| `gatekeeper` skill | Teaches an agent to drive the tools well | You install it |
| Pairing | A 6-digit code that hands the plugin its capability token | The human types the code, once per machine |

## How to run this install

- **Never fake a step.** Every step below ends with a check you can run. If the check fails or the step is blocked (no network, a sandbox, a refused permission, a path you cannot write), stop that step, keep going with the ones that do not depend on it, and record the blocked one for the handoff at the end with the exact command and what success looks like. A half-done install reported as done is worse than an honest checklist.
- **Never work around a refusal.** If the harness or the human declines a command, hand it over instead of rewording it.
- **Use the paths in this file verbatim.** Do not guess a plugins folder or a config location.
- **Merge configs, never overwrite them.** The MCP client config almost always holds other servers. Read it, add the one key, write it back, then read it again and confirm it still parses and the other entries survived.
- **Name the platform up front.** Step 0 has the one line to say for macOS, Linux or Windows. Say it before anything else; nobody should discover their platform is untested three steps in.
- **When something misbehaves, read [TROUBLESHOOTING.md](TROUBLESHOOTING.md)**, next to this file. It covers the plugin that never appears in Beekeeper, the server that will not start, pairing codes that come back refused, and approval prompts on every poll. Only read it when you hit one of those; the normal path never needs it.
- **Install for the agent you are running in**, unless the human names another one. If you cannot tell which harness you are in, ask rather than assume; step 2 depends on the answer.

The order below is not the README's. It does all the file work first, so the human restarts Beekeeper and the agent session once, at one moment, instead of three times.

## Step 0: prerequisites

**Platform.** `uname -s` gives `Darwin` (macOS), `Linux`, or a `MINGW`/`MSYS` string under Git Bash on Windows. Every table below has a row per OS: pick yours, stay in it, and say the matching line to the human now rather than later.

- **macOS**: supported. This is where Gatekeeper is developed and tested.
- **Linux**: **not tested.** Nothing in the code is macOS-specific, so it is expected to work, but expected is not verified. Say so, install anyway, and ask them to report back either way.
- **Windows**: **not tested**, same expectation, plus one practical catch: the snippets below are Unix shell. Run them under Git Bash or WSL, or translate them to PowerShell, and take the `%APPDATA%` rows in the path tables.

Off macOS the desktop notification is a no-op, so a pending query raises nothing on screen and the plugin tab is the only signal a human gets. Worth saying once, since a Gatekeeper nobody notices is a Gatekeeper nobody approves.

**Node 22 or newer**, because the MCP server runs on it: `node -v`. If it is missing or older, that is the human's to fix (any Node install works, the agent-facing side is just `npx`).

**Beekeeper Studio 5.4 or newer.** On macOS, both checks are one line each:

```bash
ls -d "/Applications/Beekeeper Studio.app" "$HOME/Applications/Beekeeper Studio.app" 2>/dev/null
defaults read "/Applications/Beekeeper Studio.app/Contents/Info" CFBundleShortVersionString
```

On Linux and Windows, ask the human for the version rather than hunting for it: Help, About in the app. If Beekeeper is not installed at all, say so and stop the install there. It is the piece that holds the database connection, so nothing downstream is useful without it. Point them at <https://www.beekeeperstudio.io/get> (the official download page, email required) or at the open-source releases on <https://github.com/beekeeper-studio/beekeeper-studio/releases>, and pick the install back up when they are ready.

## Step 1: the plugin

**The easy path, if it exists yet.** If the human already has Beekeeper open, one look at Manage Plugins settles it: a Gatekeeper entry there installs in one click and this whole step disappears. The registry submission was still in progress when this was written, so expect it to be absent. Do not block on the answer: the manual route below works either way.

**The manual route.** If a `gatekeeper/manifest.json` already sits in the plugins folder at the latest version, there is nothing to do here: go to step 2. Otherwise find the latest release, download the zip, and extract it straight into the plugins folder under the exact folder name `gatekeeper`:

```bash
tmp="${TMPDIR:-/tmp}"
version="$(curl -sS https://api.github.com/repos/Gldywn/gatekeeper/releases/latest | grep '"tag_name"' | head -1 | sed 's/.*"v\{0,1\}\([0-9][^"]*\)".*/\1/')"
curl -sSL -o "$tmp/gatekeeper-$version.zip" \
  "https://github.com/Gldywn/gatekeeper/releases/download/v$version/gatekeeper-$version.zip"
unzip -l "$tmp/gatekeeper-$version.zip"
```

Read that listing before extracting anything. It must show `manifest.json`, `LICENSE` and `dist/index.html` at the root of the archive, with no wrapping folder. If it looks like anything else, stop: you have the wrong asset.

The plugins folder, per OS:

| OS | Plugins folder |
|---|---|
| macOS | `~/Library/Application Support/beekeeper-studio/plugins/` |
| Linux | `~/.config/beekeeper-studio/plugins/` |
| Windows | `%APPDATA%\beekeeper-studio\plugins\` |

```bash
plugins="$HOME/Library/Application Support/beekeeper-studio/plugins"   # macOS; swap for the row above
mkdir -p "$plugins/gatekeeper"
unzip -o "$tmp/gatekeeper-$version.zip" -d "$plugins/gatekeeper"
```

Extracting with `-d .../plugins/gatekeeper` is the whole trick: the folder ends up named exactly `gatekeeper` and the manifest sits directly inside it, which is what Beekeeper requires. **Beekeeper matches the folder name against the plugin id and skips any folder that disagrees without a word**: no error, no entry in Manage Plugins, nothing to click. That silent skip is the single most common reason a manual install appears to do nothing. Double-clicking the zip in Finder is what produces the wrong shape, because macOS wraps a multi-file archive in a `gatekeeper-<version>/` folder; the command above avoids the rename entirely.

**Upgrading over an existing install.** `unzip -o` on its own leaves the old build behind: asset filenames carry a content hash, so a new bundle lands beside the previous one instead of replacing it, and `-o` only overwrites what the archive names. Clear `dist` first, with `rm -rf "$plugins/gatekeeper/dist"`, and let the archive restore it, but only after you have confirmed with your own eyes that the path ends in `/plugins/gatekeeper` and holds a Gatekeeper `manifest.json`. Never delete a path you have not just listed. `update-gatekeeper` carries the full sequence.

**Check:**

```bash
head -5 "$plugins/gatekeeper/manifest.json"   # id "gatekeeper", the version you downloaded
ls "$plugins/gatekeeper/dist/index.html"
```

Both must exist. The plugin does not load until Beekeeper restarts, which is a human step: hold it for the handoff rather than asking for it now.

## Step 2: register the MCP server with the agent

There is no service to install and nothing to start by hand. `npx` fetches and caches the server on first launch, and the agent's MCP client starts it when a session opens and kills it when the session ends.

Find the client config for the harness you are in, add the one entry, and leave everything else untouched.

**Claude Code:**

```bash
claude mcp add gatekeeper --scope user -- npx -y @gldywn/gatekeeper-mcp-server
```

`--scope user` makes it available in every project. Use `--scope project` instead if the human wants it only here, which writes a shared `.mcp.json` in the repo.

**Codex CLI**, in `~/.codex/config.toml`:

```toml
[mcp_servers.gatekeeper]
command = "npx"
args = ["-y", "@gldywn/gatekeeper-mcp-server"]
```

**OpenCode**, in `~/.config/opencode/opencode.json` for every project, or `opencode.json` at the project root for one:

```json
{
  "mcp": {
    "gatekeeper": {
      "type": "local",
      "command": ["npx", "-y", "@gldywn/gatekeeper-mcp-server"],
      "enabled": true
    }
  }
}
```

**Cursor**, in `~/.cursor/mcp.json` for every project or `.cursor/mcp.json` for one, and **anything else that reads a `.mcp.json`** at the project root, share one shape:

```json
{
  "mcpServers": {
    "gatekeeper": {
      "command": "npx",
      "args": ["-y", "@gldywn/gatekeeper-mcp-server"]
    }
  }
}
```

Two choices worth putting to the human rather than deciding for them. **Pinning:** unpinned, `npx` re-resolves the latest release at every agent launch, which keeps them current but means a process with a path to their database changes under them; `@gldywn/gatekeeper-mcp-server@<version>` trades that for an upgrade they audit. **pnpm:** `pnpm dlx @gldywn/gatekeeper-mcp-server` is the direct equivalent of the `npx` line, and `pnpm add -g @gldywn/gatekeeper-mcp-server` resolves it once and puts a `gatekeeper-mcp-server` binary on `PATH` to point the client at. If the human is on a machine where installs go through their own review, hand them the command instead of running it.

**Check:** read the config file back, confirm it parses, confirm the `gatekeeper` entry is there and every pre-existing server still is. For Claude Code, `claude mcp list` shows it. Do not expect the tools to work yet: a server registered mid-session is not connected in that session.

## Step 3: the companion skill

The `gatekeeper` skill is what teaches an agent to use the tools well: name the session, wait properly for a human decision instead of ending the turn on a pending query, write an intent a reviewer can approve at a glance. Without it an agent has the tools and none of the protocol, which mostly shows up as queries abandoned while the human was still deciding.

It probably arrived with this one, since `npx skills add Gldywn/gatekeeper` offers both. Check first with `npx skills list`, which reports what is installed where. Failing that, look for a `gatekeeper` folder in the agent's skills directory: per project it is `.claude/skills/` for Claude Code and `.agents/skills/` for Codex, Cursor, OpenCode and most others, while the user-level folder differs per agent (`~/.claude/skills/`, `~/.cursor/skills/`, `~/.config/opencode/skills/`), which is exactly why `npx skills list` is the reliable check.

If it is missing:

```bash
npx skills add Gldywn/gatekeeper                  # interactive, for a human at a keyboard
npx skills add Gldywn/gatekeeper -s gatekeeper -a claude-code -g -y   # non-interactive
```

The agent id for `-a` is `claude-code`, `codex`, `opencode`, `cursor` or `gemini-cli`; `-g` installs for the user rather than the project, `-y` skips the prompts. Pick the id for the harness you are in, and never run the interactive form yourself: it will sit waiting for a keypress that never comes.

**Check:** the skill folder exists and its `SKILL.md` starts with `name: gatekeeper`.

## Step 4: hand over the restarts, then pair

Two restarts, and they cannot be worked around: Beekeeper loads plugins at startup, and the MCP client only spawns the server when a session opens.

Tell the human, in this order:

1. **Restart Beekeeper Studio.** Then Tools, Gatekeeper, and the plugin tab should open. If it is not there, read [TROUBLESHOOTING.md](TROUBLESHOOTING.md) before anything else.
2. **Restart the agent session.** In this session the Gatekeeper tools do not exist yet, whatever the config says.

Then pairing, which is a one-off per machine. In the new session, call any Gatekeeper tool (`get_connection_info` is the cheapest) or simply ask for something that needs the database. Until the plugin is paired, every tool answers with a 6-digit code. Give that code to the human and ask them to type it into the Gatekeeper tab in Beekeeper. It is single use, lasts about five minutes, and `http://127.0.0.1:9999/pair` always shows the current one. **Do not open that page yourself**: the code has to cross a channel a web page cannot observe, which is exactly what makes the pairing safe, and the human reading it with their own eyes is the point.

Nothing answers on port 9999 until an agent has started the server at least once, so the order matters: open the plugin before that and it says so, rather than showing a pairing field it cannot honour.

## Step 5: prove it works end to end

Pairing proves the channel. One approved query proves the whole loop, and it walks the human through the card they will be approving from now on. With the `gatekeeper` skill loaded:

1. `set_session_label` with something like `Gatekeeper install check`.
2. `get_connection_info`: expect `connected: true` and the connection the human has open in Beekeeper.
3. Propose `SELECT 1` with the intent `Install check: confirm the approval loop end to end.` It appears in the plugin, the human approves, one row comes back.

Then set expectations before handing back: reads are always allowed, a write only runs once the human arms Write mode in the plugin, and a destructive statement only under Destructive mode. Those modes are ephemeral and reset on a connection switch. On macOS the first pending query also raises a desktop notification, and macOS asks for permission the first time: allow it, or banners stop for good and the only symptom is a chime with nothing on screen.

## Always finish with the handoff

Whatever happened, close with a short report the human can act on without re-reading the session. Keep it to what you actually observed:

```
Gatekeeper install

Done
- Plugin 0.1.1 extracted to ~/Library/Application Support/beekeeper-studio/plugins/gatekeeper
- MCP server registered in ~/.claude.json (user scope), other servers untouched
- gatekeeper skill present at ~/.claude/skills/gatekeeper

Your turn, in this order
1. Restart Beekeeper Studio, then Tools > Gatekeeper. The tab should open.
2. Restart this agent session.
3. Say "finish the Gatekeeper pairing" and I will get you the 6-digit code.

I could not do
- Nothing.
```

Anything you were blocked on goes under the last heading with the exact command, where to run it, and what success looks like, so the human is never left guessing what "do it yourself" means.

## Updating and removing

**Update:** the `update-gatekeeper` skill does it across all three pieces, and knows which ones need nothing. The short version: re-run step 1 against the new release and restart Beekeeper, since an unpinned `npx` line picks the matching server up on its own at the next agent launch while a pinned one needs its version bumped by hand. Plugin and server ship under one version and are meant to match, and an in-place plugin update keeps the pairing.

**Remove:** delete the `gatekeeper` folder from the plugins directory, drop the `gatekeeper` entry from the MCP client config, and delete `~/.gatekeeper` (the capability token and the local SQLite queue). The skills come out with `npx skills remove gatekeeper install-gatekeeper`, or by deleting their folders. Nothing else was ever written outside those three places.
