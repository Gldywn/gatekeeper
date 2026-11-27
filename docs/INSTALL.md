# Install

The fastest route is the `install-gatekeeper` skill (see the [README](../README.md#getting-started)).
This page is the manual route, step by step, and what to check when something does not show up.

Gatekeeper has three pieces, released together under one version:

| Piece | What it does | Where it runs |
|---|---|---|
| **Beekeeper Studio plugin** | Shows each proposed query, classifies its risk, runs Auto mode, executes the query on your connection once approved | Inside Beekeeper Studio |
| **MCP server** | The tools an agent calls to propose a query and collect its result | On your machine, started by your agent |
| **Agent skill** | Teaches an agent how to use those tools | In your agent's skills folder |

## Requirements

Beekeeper Studio 5.4 or later and Node 22 or later. There is no background service to install.
Your agent starts the server when its session opens, and the server exits when that session
ends.

Gatekeeper is developed and tested on macOS. Windows and Linux are not tested yet. Both are
expected to work, without desktop notifications. Reports from either platform are welcome.

## 1. The plugin

Gatekeeper is listed in Beekeeper's community plugin registry. How to reach it depends on your
Beekeeper Studio version.

| Beekeeper Studio | How to install Gatekeeper |
|---|---|
| 6.2 and later | Community plugins are off by default, so first turn on **Community Plugins** in **Tools > Manage Plugins > Configure**. Then open **Tools > Manage Plugins > Browse**, find Gatekeeper and click Install. |
| 5.7 to 6.1 | The plugin system ships turned off. Add the two settings under [If the plugin never shows up](#if-the-plugin-never-shows-up) to your user config, restart Beekeeper, then install from **Tools > Manage Plugins**. |
| 5.4 to 5.6 | Install from **Tools > Manage Plugins** if it lists Gatekeeper. Versions 5.4 and 5.5 only list Beekeeper's own plugins, so use the release zip there. |

To install from the release zip instead, download `gatekeeper-<version>.zip` from the
[latest release](https://github.com/Gldywn/gatekeeper/releases/latest). Extract its contents
into a folder named exactly `gatekeeper` inside Beekeeper's plugins folder, so that
`manifest.json` sits directly in `gatekeeper/`. Then restart Beekeeper.

| OS | Plugins folder |
|---|---|
| macOS | `~/Library/Application Support/beekeeper-studio/plugins/` |
| Linux | `~/.config/beekeeper-studio/plugins/` |
| Windows | `%APPDATA%\beekeeper-studio\plugins\` |

Beekeeper skips a folder whose name differs from the plugin id, without any error. If Finder
creates an outer `gatekeeper-<version>/` folder when you open the zip, rename it to
`gatekeeper`.

On 6.2 and later, Beekeeper treats a hand-installed Gatekeeper as a community plugin once it can
match the folder to its registry entry, which needs Community Plugins on and a restart. Until
then the plugin manager lists it as unlisted. If it is still unlisted after that restart,
Beekeeper could not reach its registry, and turning on **Unlisted Plugins** lets it load. On
5.7 to 6.1, this route needs only `disabled = false` from the settings below.

## 2. The MCP server

Register the server with your agent. This also installs it, since `npx` downloads and caches
it on first launch.

```bash
# Claude Code
claude mcp add gatekeeper --scope user -- npx -y @gldywn/gatekeeper-mcp-server
```

```toml
# Codex CLI, in ~/.codex/config.toml
[mcp_servers.gatekeeper]
command = "npx"
args = ["-y", "@gldywn/gatekeeper-mcp-server"]
```

For OpenCode, in `~/.config/opencode/opencode.json`:

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

Any client that reads `.mcp.json` can use [`.mcp.json.example`](../.mcp.json.example) as is.
`pnpm dlx @gldywn/gatekeeper-mcp-server` works in place of `npx`. Pin a version
(`@gldywn/gatekeeper-mcp-server@<version>`) if you want to control updates. Without a pin, a
later launch can pick up a new release.

## 3. The agent skill

```bash
npx skills add Gldywn/gatekeeper
```

The CLI asks which agents to install for and whether to install globally. It works with Claude
Code, Codex, Cursor and others. It offers three skills, `gatekeeper` (how to use the tools),
`install-gatekeeper` and `update-gatekeeper`.

## 4. Pairing, once per machine

Start your agent and ask it for anything that needs the database. Until the plugin is paired,
Gatekeeper sends you to its pairing page. Some agents open the page for you. Others answer with
a link to it, usually with the 6-digit code as well. Type the code into the plugin
(Tools > Gatekeeper). The code is single-use and lasts about five minutes. While the plugin is
unpaired and your agent has started the server, `http://127.0.0.1:9999/pair` shows the current
code.

## 5. First query

Ask your agent for something that needs the database. The query appears in the plugin, you
approve it, and the result goes back to the agent. Reads can be approved in Read mode, the
default. A write needs Write or Destructive mode armed, and each write still needs your
approval. To turn on Auto mode, use the lightning icon in the plugin header or the switch in
Settings.

On Beekeeper Studio 6.2 and later, the plugin manager also has a **Read-Only** box for each
plugin, ticked by default. While it is ticked, Beekeeper refuses every write Gatekeeper runs,
whatever mode you armed. To use Write or Destructive mode, untick Read-Only for Gatekeeper in
Tools > Manage Plugins.

## If the plugin never shows up

Check the folder name first if you installed from the zip. Then check your Beekeeper Studio
version.

- **6.2 and later.** Turn on **Community Plugins** in Tools > Manage Plugins > Configure, then
  restart. If a hand-installed Gatekeeper still shows as an unlisted plugin after the restart,
  Beekeeper could not reach its registry, so turn on **Unlisted Plugins** too. Without an
  Ultimate licence, these versions allow at most two plugins besides the two bundled with
  Beekeeper, and a plugin you turned off still counts. If Install refuses because that limit is
  reached, or Gatekeeper shows as disabled for that reason, uninstall another plugin first.
- **5.7 to 6.1.** The plugin system and community plugins ship turned off. Add both settings to
  your user config, then restart Beekeeper. A hand-installed Gatekeeper needs only
  `disabled = false`.
- **5.4 and 5.5.** Their plugin manager only lists Beekeeper's own plugins. Install from the
  release zip.

```ini
[pluginSystem]
disabled = false
communityDisabled = false
```

| OS | User config file |
|---|---|
| macOS | `~/Library/Application Support/beekeeper-studio/user.config.ini` |
| Linux | `~/.config/beekeeper-studio/user.config.ini` |
| Windows | `%APPDATA%\beekeeper-studio\user.config.ini` |

More cases (the server does not start, pairing refused, a lost pairing) are in the install
skill's [troubleshooting](../skills/install-gatekeeper/TROUBLESHOOTING.md).
