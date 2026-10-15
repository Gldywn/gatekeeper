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

// Mirrors the two process arms of scripts/dev-server.mjs findServers(): npx and global
// installs, and checkout builds with their tsx watcher.
export const STOP_COMMAND =
  "pkill -f 'gatekeeper-mcp-server|gatekeeper[^ ]*/server/(dist/index\\.js|src/index\\.ts)'";

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

function pluginAdvice(r: Extract<VersionRow, { kind: "behind" }>): string {
  const lead =
    r.tone === "warn"
      ? `Older than the server (${escapeHtml(r.peer)}).`
      : `Gatekeeper ${escapeHtml(r.latest)} is available.`;
  return `${status(r.tone === "warn" ? alertTriangleIcon : arrowUpCircleIcon, `${lead} Update the plugin in Beekeeper Studio.`)}
              <span class="ver-then">Then restart Beekeeper Studio.</span>`;
}

// Windows has no pkill; closing every session stops the servers they started.
function serverAdvice(r: Extract<VersionRow, { kind: "behind" }>, windows: boolean): string {
  const lead =
    r.tone === "warn"
      ? `Older than the plugin (${escapeHtml(r.peer)}).`
      : `Gatekeeper ${escapeHtml(r.latest)} is available.`;
  const icon = r.tone === "warn" ? alertTriangleIcon : arrowUpCircleIcon;
  if (windows) {
    return `${status(icon, `${lead} Update it if its version is pinned.`)}
              <span class="ver-then">Then close and reopen every agent session.</span>`;
  }
  const which = r.tone === "warn" ? "old" : "running";
  const tone = r.tone === "warn" ? "tonal" : "quiet";
  return `${status(icon, `${lead} Update it if its version is pinned, then stop the ${which} servers.`)}
              <span class="ver-fix"><button class="sa-enable ${tone}" type="button" data-copy-stop>${copyIcon}<span>Copy stop command</span></button></span>
              <span class="ver-then">Then restart your agent sessions.</span>`;
}

function rowHtml(name: "Plugin" | "Server", r: VersionRow, windows: boolean): string {
  let detail = "";
  if (r.kind === "ok") detail = status(checkIcon, "Up to date", "ok");
  else if (r.kind === "unknown")
    detail = status(helpCircleIcon, "Couldn't determine the version.", "unknown");
  else if (r.kind === "dev" && r.branch) detail = status(gitBranchIcon, escapeHtml(r.branch));
  else if (r.kind === "behind")
    detail = name === "Plugin" ? pluginAdvice(r) : serverAdvice(r, windows);
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

export function versionGroupHtml(s: VersionStatus, windows: boolean): string {
  return `
          <div class="set-group-head with-link">
            <span class="set-group-name">Version</span>
            <button class="pair-link" type="button" data-releases>Releases on GitHub ${externalLinkIcon}</button>
          </div>
          ${rowHtml("Plugin", s.plugin, windows)}
          ${rowHtml("Server", s.server, windows)}`;
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
