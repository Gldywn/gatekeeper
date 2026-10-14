# Configuration

Everything Gatekeeper reads at runtime. There is nothing to configure for a normal install;
this is the reference for the cases that need it.

## Environment variables

Set on the MCP server process, so in your agent's MCP client config.

| Variable | Default | What it does |
|---|---|---|
| `GATEKEEPER_TOKEN` | generated | Use a fixed capability token instead of the generated `~/.gatekeeper/broker-token`. |
| `GATEKEEPER_BROKER_PORT` | `9999` | Broker port. The plugin always talks to `9999`, so changing this breaks pairing with no clear error. Leave it alone unless you are developing against a second instance. |
| `GATEKEEPER_DB` | `~/.gatekeeper/requests.db` | SQLite path for the queue and the audit trail. |
| `GATEKEEPER_NOTIFY` | `both` | Desktop notification mode: `both`, `banner`, `sound`, or `off`. |

## Desktop notifications (macOS)

A pending query nobody notices is a query nobody approves, so on macOS the server raises a
notification and plays a sound the moment a proposal arrives, wherever you are on your
desktop. A burst is collapsed into a single alert, and a retried submission raises none.

**Auto mode adds a second sound.** Every proposal still raises the submission alert. When a
query [Auto mode](AUTO-MODE.md) approved runs successfully, the server also plays a second,
different sound with no banner, as long as no other proposal is still waiting or running at
that moment. It answers a submission alert: it plays only if one rang since it last played,
and once it has played, the next proposal raises its own alert even inside the burst window.
So an agent sending automatically approved queries one at a time hears an alert and the
second sound for each, and an alert heard alone means something is left for you.
`both` and `sound` play it, `banner` and `off` do not. When agents run Gatekeeper with
different `GATEKEEPER_NOTIFY` values, this sound follows the setting of the one Gatekeeper
process that serves the plugin, not the agent's. The sound lives in a macOS folder Apple does
not document, so if it fails to play the server plays the system sound Hero instead.

**The first proposal asks for permission.** macOS shows "Gatekeeper would like to send you
notifications" the first time, in the middle of an agent session. Allow it, and you never see
it again. Decline it and banners stop for good, silently: the sound still plays, so the
symptom is a chime with nothing on screen. To change your mind, open System Settings,
Notifications, find **Gatekeeper**, and turn it back on. The server also logs a line to
stderr on every start where the permission is missing.

**Clicking the banner brings Beekeeper Studio forward**, launching it if needed. It cannot
switch to the Gatekeeper tab: Beekeeper gives plugins no way to select their own tab.

On Linux and Windows the feature is a no-op, and nothing else changes.
