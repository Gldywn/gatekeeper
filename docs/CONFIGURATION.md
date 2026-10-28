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
notification and plays a sound when a proposal needs you, wherever you are on your desktop. A
burst is collapsed into a single alert, and a retried submission raises none.

**Only what needs you rings.** With the plugin not running, a proposal alerts the moment it
arrives. While it runs, a proposal first waits for the plugin's [load check](../SECURITY.md#load-check)
when Auto-deny heavy queries is on, as it is by default: a heavy query the plugin rejects on
its own never rings, and any other rings once the check is done, at most about 7 seconds
after it arrived (the check stops waiting at 5 seconds). With [Auto mode](AUTO-MODE.md) on,
a read then waits silently for its evaluation: if Auto mode approves it, nothing rings; if Auto
mode holds it, refuses it, or its evaluation fails or times out, the alert rings then. A write
or destructive statement, which Auto mode never approves, rings as soon as nothing else can
decide it. Switching Auto mode or auto-deny off rings for what they had not decided yet. If the
plugin stops reporting for 15 seconds (Beekeeper closed, the tab unpaired or no longer
polling), the server stops waiting and rings for them, so a read Auto mode approves after such
a gap may still have rung.

**A query still waiting rings once more** when half its life has passed, about 7 minutes 30
seconds after it arrived. The reminder is the sound alone, never a second banner, and comes
once per query; queries that come due together share one sound, and it never keeps a new
query from raising its own alert. A read Auto mode still has at that point, for instance
because long queries hold all its runs, rings then for the first time, and that alert is its
reminder. `banner` mode has no reminder.

The alerts raised after submission (a read Auto mode leaves to you, the 15-second fallback
and the reminder) come from the one Gatekeeper process that serves the plugin, and follow its
`GATEKEEPER_NOTIFY`, not the submitting agent's. They need that process up to date: restart
the agent sessions still running an older server after an update. Until then, a proposal
may alert at submission as before, and if an older server takes over the plugin while
proposals wait on it, their alerts and reminders may never come.

**The first proposal asks for permission.** macOS shows "Gatekeeper would like to send you
notifications" the first time, in the middle of an agent session. Allow it, and you never see
it again. Decline it and banners stop for good, silently: the sound still plays, so the
symptom is a chime with nothing on screen. To change your mind, open System Settings,
Notifications, find **Gatekeeper**, and turn it back on. The server also logs a line to
stderr on every start where the permission is missing.

**Clicking the banner brings Beekeeper Studio forward**, launching it if needed. It cannot
switch to the Gatekeeper tab: Beekeeper gives plugins no way to select their own tab.

On Linux and Windows the feature is a no-op, and nothing else changes.
