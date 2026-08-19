import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NOTIFY_PROMPT_TIMEOUT_MS, NOTIFY_TIMEOUT_MS } from "./config.js";

export type NotifyMode = "both" | "banner" | "sound" | "off";

const SOUND = "/System/Library/Sounds/Glass.aiff";
// UNUserNotificationCenter refuses an app LaunchServices has never seen, with no
// prompt and no way to recover, so registration is a prerequisite and not a polish.
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const MAX_LABEL = 80;
const UNAUTHORIZED = /authorization=(?!authorized)/;

export interface RunResult {
  stdout: string;
}

export interface NotifyDeps {
  run: (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;
  exists: (path: string) => boolean;
  platform: string;
  mode: NotifyMode;
  bundle: string;
  helper: string;
  log: (message: string) => void;
}

export function parseMode(raw: string | undefined): NotifyMode {
  return raw === "off" || raw === "banner" || raw === "sound" ? raw : "both";
}

// Control characters break the banner's layout, and bidirectional overrides or invisible
// format characters can make it render in an order nobody wrote, the trojan-source concern
// SECURITY.md already takes on the SQL side. The label is agent-controlled, so drop both.
function isUnsafe(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

export function sanitizeLabel(raw: string | null | undefined): string {
  if (!raw) {
    return "";
  }
  const flat = Array.from(raw)
    .map((ch) => (isUnsafe(ch.codePointAt(0) ?? 0) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 3)}...` : flat;
}

export function bannerArgs(body: string, subtitle: string): string[] {
  const args = ["post", "--title", "Gatekeeper", "--body", body];
  return subtitle ? [...args, "--subtitle", subtitle] : args;
}

function defaultRun(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const out = String(stdout);
      // The helper exits non-zero when the grant is missing and says so on stdout, so a
      // non-zero exit carrying output is an answer, not a failure. Only a spawn that
      // produced nothing (missing binary, sandbox, timeout) is a real error.
      if (err && !out) {
        reject(err);
        return;
      }
      resolve({ stdout: out });
    });
  });
}

function bundlePath(): string {
  return fileURLToPath(new URL("../notifier.noindex/Gatekeeper.app", import.meta.url));
}

export function defaultDeps(): NotifyDeps {
  const bundle = bundlePath();
  return {
    run: defaultRun,
    exists: existsSync,
    platform: process.platform,
    mode: parseMode(process.env.GATEKEEPER_NOTIFY),
    bundle,
    helper: `${bundle}/Contents/MacOS/gatekeeper-notify`,
    // stdout is the MCP stdio channel, so every log goes to stderr.
    log: (message: string) => console.error(`[gatekeeper] ${message}`),
  };
}

export function createNotifier(deps: NotifyDeps = defaultDeps()) {
  const active = deps.platform === "darwin" && deps.mode !== "off";
  let registered = false;
  let warned = false;
  let warnedMissing = false;

  // `lsregister -f` on a path that does not exist still exits 0, and the helper then
  // fails with ENOENT into the catch-all, so without this check a package built without
  // its bundle is indistinguishable from one working in silence.
  function bundleMissing(): boolean {
    if (deps.exists(deps.bundle)) {
      return false;
    }
    if (!warnedMissing) {
      warnedMissing = true;
      deps.log(
        `the notification helper is missing at ${deps.bundle}; run \`pnpm build\` in packages/server`,
      );
    }
    return true;
  }

  async function register(): Promise<void> {
    if (registered) {
      return;
    }
    await deps.run(LSREGISTER, ["-f", deps.bundle], NOTIFY_TIMEOUT_MS);
    // Latched only on success: a transient failure would otherwise leave every later
    // alert running against an app the notification centre refuses.
    registered = true;
  }

  // A denied grant still accepts the notification, so the helper reports the state back
  // rather than letting a silent drop look like a delivery.
  function reportGrant(stdout: string): void {
    if (!warned && UNAUTHORIZED.test(stdout)) {
      warned = true;
      deps.log(
        "desktop notifications are not authorized for Gatekeeper; allow them in System Settings, Notifications",
      );
    }
  }

  async function banner(body: string, subtitle: string): Promise<void> {
    if (bundleMissing()) {
      return;
    }
    await register();
    // Generous: the first proposal on a machine raises the macOS permission dialog and
    // waits for a human. Killing it there would lose the prompt, and nothing awaits us.
    const { stdout } = await deps.run(
      deps.helper,
      bannerArgs(body, subtitle),
      NOTIFY_PROMPT_TIMEOUT_MS,
    );
    reportGrant(stdout);
  }

  function swallow(task: Promise<unknown>): void {
    task.catch(() => {
      // A sandboxed harness, a missing binary, a headless session: none of these may
      // turn a successful submit_query into an error.
    });
  }

  return {
    /** False when this platform or this configuration raises nothing, so callers can skip the work. */
    active,

    /** Report at startup whether banners will actually appear. Never throws. */
    probe(): void {
      if (!active || deps.mode === "sound" || bundleMissing()) {
        return;
      }
      swallow(
        register()
          .then(() => deps.run(deps.helper, ["status"], NOTIFY_TIMEOUT_MS))
          .then(({ stdout }) => reportGrant(stdout)),
      );
    },

    /** Raise one desktop alert. Never throws, never blocks the caller. */
    notify(label: string | null | undefined): void {
      if (!active) {
        return;
      }
      const subtitle = sanitizeLabel(label);
      if (deps.mode !== "sound") {
        swallow(banner("A query is waiting for your approval", subtitle));
      }
      // Deliberately a separate command: the banner rides a permission and an API the
      // sound does not, so a refused or broken banner still leaves an audible alert.
      if (deps.mode !== "banner") {
        swallow(deps.run("afplay", [SOUND], NOTIFY_TIMEOUT_MS));
      }
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
