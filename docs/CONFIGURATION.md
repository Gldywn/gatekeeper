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

**The first proposal asks for permission.** macOS shows "Gatekeeper would like to send you
notifications" the first time, in the middle of an agent session. Allow it, and you never see
it again. Decline it and banners stop for good, silently: the sound still plays, so the
symptom is a chime with nothing on screen. To change your mind, open System Settings,
Notifications, find **Gatekeeper**, and turn it back on. The server also logs a line to
stderr on every start where the permission is missing.

On Linux and Windows the feature is a no-op, and nothing else changes.
