---
name: update-gatekeeper
description: Check whether an existing Gatekeeper install is current and bring it up to date across all three pieces (the Beekeeper Studio plugin, the MCP server, the skills), acting only on what is actually behind. Use when someone asks to update or upgrade Gatekeeper, asks whether they are running the latest version, mentions a new Gatekeeper release, or wants to know which version of Gatekeeper they have.
version: 1.0.1
---

# Update Gatekeeper

Three pieces can be out of date independently, and each one updates differently. Report the state of all three, even the ones that are current, then act only on what is behind. An update that touches nothing and says so plainly is a good outcome, not a wasted run.

**If nothing is installed**, this is the wrong skill: hand it to `install-gatekeeper` and stop.

**Pairing survives an update.** The plugin keeps its token in Beekeeper's encrypted storage under the plugin id, not in its folder, so replacing the folder does not cost a new 6-digit code. Say that up front, because the opposite is what people expect.

## The latest version

One call, and it covers two of the three pieces: the plugin and the MCP server ship under one version and are meant to match.

```bash
version="$(curl -sS https://api.github.com/repos/Gldywn/gatekeeper/releases/latest | grep '"tag_name"' | head -1 | sed 's/.*"v\{0,1\}\([0-9][^"]*\)".*/\1/')"
echo "$version"
```

The snippets below reuse that `$version`.

## Piece 1: the plugin

Read the installed version straight out of the manifest:

| OS | Manifest |
|---|---|
| macOS | `~/Library/Application Support/beekeeper-studio/plugins/gatekeeper/manifest.json` |
| Linux | `~/.config/beekeeper-studio/plugins/gatekeeper/manifest.json` |
| Windows | `%APPDATA%\beekeeper-studio\plugins\gatekeeper\manifest.json` |

No manifest there means the plugin was never installed manually. Check Beekeeper's Manage Plugins before concluding, since a registry install updates itself from there and is not yours to touch.

If it is behind, replace it in place. The folder keeps its exact name and nothing moves outside it.

`unzip -o` alone is not enough, though, and the reason is worth knowing. The build stamps a content hash into every asset filename, so a new version ships `dist/assets/index-<newhash>.js` rather than overwriting the old bundle: `-o` replaces what the archive names and never removes what it does not, which strands the previous version's bundle in place. It is dead weight, `dist/index.html` only ever references the current hash, but it is roughly 3 MB per release and it accumulates. Clear `dist` first and the whole directory comes back from the archive.

Order matters here. Delete only after `unzip -l` has proved the archive is the right shape, so a bad download never costs a working plugin:

```bash
tmp="${TMPDIR:-/tmp}"
plugins="$HOME/Library/Application Support/beekeeper-studio/plugins"   # macOS; swap for the row above
curl -sSL -o "$tmp/gatekeeper-$version.zip" \
  "https://github.com/Gldywn/gatekeeper/releases/download/v$version/gatekeeper-$version.zip"
unzip -l "$tmp/gatekeeper-$version.zip"                                # manifest.json at the root, no wrapper folder
rm -rf "$plugins/gatekeeper/dist"                                      # only once the listing above checks out
unzip -o "$tmp/gatekeeper-$version.zip" -d "$plugins/gatekeeper"
head -5 "$plugins/gatekeeper/manifest.json"                            # the new version
ls "$plugins/gatekeeper/dist/assets/"                                  # only the new build's assets
```

The root files (`manifest.json`, `LICENSE`, `README.md`) keep stable names across releases, so `-o` handles those on its own. `dist` is the only part that needs clearing.

This one needs **a Beekeeper restart**, which is the human's. Beekeeper loads plugins at startup.

## Piece 2: the MCP server

There is nothing to compare here, because what matters is how it is registered rather than what is on disk. Read the entry, then answer for the setup you actually find. It lives in `~/.claude.json` for Claude Code at user scope (`claude mcp list` shows it), `~/.codex/config.toml` for Codex, `~/.config/opencode/opencode.json` for OpenCode, `~/.cursor/mcp.json` for Cursor, or a `.mcp.json` at the project root.

- **Unpinned** (`npx -y @gldywn/gatekeeper-mcp-server`): nothing to do. It re-resolves the latest release at the next agent launch, so it is current by construction. Say that instead of inventing an action.
- **Pinned** (`@gldywn/gatekeeper-mcp-server@0.1.1`): edit that version string to the latest, in place, leaving every other server in the file untouched. This is the one case where an update means editing a config.
- **Installed globally** (a `gatekeeper-mcp-server` binary on `PATH`, from `pnpm add -g` or equivalent): the client points at a binary that only changes when it is reinstalled. Hand the human the command rather than running it, since a global install is theirs to approve: `pnpm add -g @gldywn/gatekeeper-mcp-server@<version>`.

Either of the last two needs **an agent session restart** to take effect. The first does too, but it happens on its own at the next launch.

**Mismatch worth flagging:** a pinned server at one version and a plugin at another. They ship together and are meant to match, so if you bumped one, bump the other.

## Piece 3: the skills

The `gatekeeper` and `install-gatekeeper` skills carry their own version in their frontmatter, on their own scale, which does not map to the release version. Do not compare those numbers to the release and do not report a verdict from them: let the CLI do it.

```bash
npx skills list                                              # what is installed, and where
npx skills add Gldywn/gatekeeper -s '*' -a <agent-id> -g -y  # re-adds both, overwriting in place
```

The agent id is `claude-code`, `codex`, `opencode`, `cursor` or `gemini-cli`; `-g` for the user-level install, `-y` to skip the prompts. Never run the interactive form yourself, it waits for a keypress that never comes. `npx skills update` is the shorter form and worth trying first, but re-adding is the one that is always correct, so fall back to it rather than trusting a run whose output you cannot read clearly.

A skill change is picked up at **the next agent session**, same restart as above.

## Report, then hand over

Always print all three lines, even when they are all current, and keep the restarts to the end so the human does them once:

```
Gatekeeper, latest release 0.2.0

- Plugin      0.1.1 -> 0.2.0, updated in place
- MCP server  npx unpinned, current at your next agent launch, nothing to do
- Skills      updated (gatekeeper 1.4.0, install-gatekeeper 1.0.0)

Your turn
1. Restart Beekeeper Studio to load the new plugin.
2. Restart this agent session.

Your pairing is untouched, no new code needed.
```

The numbers above are a shape, not values to repeat: report the versions you actually read. Anything you could not do goes underneath with the exact command and what success looks like. A blocked step reported honestly beats a report that claims an update nobody made.
