import type { BuildIdentity } from "@gatekeeper/shared";
import { escapeHtml } from "../html";
import {
  alertTriangleIcon,
  arrowUpCircleIcon,
  checkIcon,
  copyIcon,
  externalLinkIcon,
  gitBranchIcon,
  helpCircleIcon,
} from "../icons";
import { compareVersions, type VersionDock, type VersionRow, type VersionStatus } from "../version";

export const UPDATE_SKILL_URL =
  "https://github.com/Gldywn/gatekeeper/tree/main/skills/update-gatekeeper";

// Plain instructions rather than a slash command, so any harness can follow them; the
// versions spare the agent a round of checks the plugin has already done.
export function updatePrompt(
  plugin: BuildIdentity,
  server: BuildIdentity | null,
  latest: string | null,
): string {
  return [
    "Update Gatekeeper on this machine.",
    "Run every command below through whichever package runner I use.",
    "",
    "What the Gatekeeper plugin in Beekeeper Studio sees right now:",
    `- Plugin: ${describe(plugin)}`,
    `- Server answering the plugin: ${describe(server)}`,
    `- Latest release on GitHub: ${latest ?? "unknown"}`,
    "",
    "1. Run skills list to see whether the update-gatekeeper skill is installed for you.",
    "2. Install it globally, or refresh it if it is already there so you follow its latest",
    "   steps. Ask me before running:",
    "   skills add Gldywn/gatekeeper -s update-gatekeeper -a <your agent id> -g -y",
    "3. Run the update-gatekeeper skill to bring the plugin, the server and the skills to the",
    "   latest release. It stops the old Gatekeeper servers, so tell me which agent sessions to",
    "   restart and whether Beekeeper Studio needs a restart.",
    "",
    `Skill: ${UPDATE_SKILL_URL}`,
  ].join("\n");
}

function value(r: VersionRow): string {
  if (r.kind === "unknown") return `<span class="ver none">unknown</span>`;
  if (r.kind === "dev") {
    const sha = r.sha ? `<span class="ver">${escapeHtml(r.sha)}</span>` : "";
    return `<span class="set-ex reads">dev</span>${sha}`;
  }
  return `<span class="ver">${escapeHtml(r.version)}</span>`;
}

function status(icon: string, text: string, cls = ""): string {
  return `<span class="set-desc ver-status${cls ? ` ${cls}` : ""}">${icon}<span>${text}</span></span>`;
}

const ADVICE = {
  Plugin: {
    peer: "server",
    fix: "Update the plugin in Beekeeper Studio.",
    restart: "Beekeeper Studio",
  },
  Server: {
    peer: "plugin",
    fix: "Update it if its version is pinned.",
    restart: "your agent sessions",
  },
};

function advice(name: "Plugin" | "Server", r: Extract<VersionRow, { kind: "behind" }>): string {
  const { peer, fix, restart } = ADVICE[name];
  const lead =
    r.tone === "warn"
      ? `Older than the ${peer} (${escapeHtml(r.peer)}).`
      : `Gatekeeper <span class="ver-new">${escapeHtml(r.latest)}</span> is available.`;
  return `${status(r.tone === "warn" ? alertTriangleIcon : arrowUpCircleIcon, `${lead} ${fix}`)}
              <span class="ver-then">Then restart ${restart}.</span>`;
}

function rowHtml(name: "Plugin" | "Server", r: VersionRow): string {
  let detail = "";
  if (r.kind === "ok") detail = status(checkIcon, "Up to date", "ok");
  else if (r.kind === "unknown")
    detail = status(helpCircleIcon, "Couldn't determine the version.", "unknown");
  else if (r.kind === "dev" && r.branch) detail = status(gitBranchIcon, escapeHtml(r.branch));
  else if (r.kind === "behind") detail = advice(name, r);
  const tone = r.kind === "behind" ? ` ${r.tone}` : "";
  return `
          <div class="set-row${tone}">
            <div class="set-text">
              <span class="set-name">${name}</span>
              ${detail}
            </div>
            <span class="set-control">${value(r)}</span>
          </div>`;
}

// The skill does every step above for both sides, old servers included, so it closes the
// group once, tinted like the rows it would fix, rather than repeating in each row.
function agentHtml(tone: "warn" | "info"): string {
  return `
          <div class="ver-agent ${tone}">
            <span class="ver-agent-text">
              <span class="ver-agent-title">Update to the latest version</span>
              <span>Ask your agent to run the <button class="ver-skill" type="button" data-skill-link>update-gatekeeper</button> skill. It updates the plugin, the server and the skills, and stops the old servers.</span>
            </span>
            <button class="sa-enable quiet" type="button" data-copy-prompt>${copyIcon}<span>Copy prompt</span></button>
          </div>`;
}

export function versionGroupHtml(s: VersionStatus): string {
  const rows = [s.plugin, s.server];
  const tone = rows.some((r) => r.kind === "behind" && r.tone === "warn")
    ? "warn"
    : rows.some((r) => r.kind === "behind")
      ? "info"
      : null;
  return `
          <div class="set-group-head with-link">
            <span class="set-group-name">Version</span>
            <button class="pair-link" type="button" data-releases>Releases on GitHub ${externalLinkIcon}</button>
          </div>
          ${rowHtml("Plugin", s.plugin)}
          ${rowHtml("Server", s.server)}${tone ? agentHtml(tone) : ""}`;
}

function describe(b: BuildIdentity | null): string {
  if (!b) return "unknown";
  if (!b.dev) return b.version;
  const branch = b.dev.branch ? ` (${b.dev.branch})` : "";
  return `dev${b.dev.sha ? ` ${b.dev.sha}` : ""}${branch}`;
}

// Plain text for title / aria-label; the caller assigns it, never as HTML.
export function versionDockTitle(
  plugin: BuildIdentity,
  server: BuildIdentity | null,
  latest: string | null,
): string {
  const behind =
    latest !== null &&
    [plugin, server].some((b) => b && !b.dev && compareVersions(b.version, latest) < 0);
  return `Plugin ${describe(plugin)} · Server ${describe(server)}${behind ? ` · Latest ${latest}` : ""}`;
}

export function versionDockHtml(dock: VersionDock): { cls: string; html: string } {
  switch (dock.kind) {
    case "ok":
      return {
        cls: "ok",
        html: `${checkIcon}<span class="num">${escapeHtml(dock.version)}</span>`,
      };
    case "mismatch":
      return { cls: "warn", html: `${alertTriangleIcon}<span>Version mismatch</span>` };
    case "update":
      return {
        cls: "info",
        html: `${arrowUpCircleIcon}<span class="num">${escapeHtml(dock.latest)}</span>`,
      };
    case "unknown":
      return { cls: "unknown", html: `${helpCircleIcon}<span>Version unknown</span>` };
    case "dev":
      return { cls: "dev", html: `${gitBranchIcon}<span>dev</span>` };
  }
}
