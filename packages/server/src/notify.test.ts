import { describe, expect, it } from "vitest";
import { NOTIFY_PROMPT_TIMEOUT_MS, NOTIFY_TIMEOUT_MS } from "./config.js";
import {
  bannerArgs,
  createNotifier,
  type NotifyDeps,
  type NotifyMode,
  parseMode,
  sanitizeLabel,
} from "./notify.js";

interface Call {
  cmd: string;
  args: string[];
  timeoutMs: number;
}

// The OS is never touched: every spawn is recorded, so the tests assert the argv shape
// rather than whether a banner appeared.
function harness(
  overrides: Partial<NotifyDeps> = {},
  stdout = "authorization=authorized result=ok",
) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const deps: NotifyDeps = {
    run: async (cmd, args, timeoutMs) => {
      calls.push({ cmd, args, timeoutMs });
      return { stdout };
    },
    platform: "darwin",
    mode: "both" as NotifyMode,
    bundle: "/pkg/notifier.noindex/Gatekeeper.app",
    helper: "/pkg/notifier.noindex/Gatekeeper.app/Contents/MacOS/gatekeeper-notify",
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { calls, logs, notifier: createNotifier(deps) };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const isHelper = (c: Call) => c.cmd.includes("gatekeeper-notify");
const isRegister = (c: Call) => c.cmd.includes("lsregister");

// Built from code points so this file stays plain ASCII: a literal control character
// makes it binary to git and unreadable to review tooling.
const ctl = (code: number) => String.fromCharCode(code);

describe("sanitizeLabel", () => {
  it("keeps an ordinary label untouched", () => {
    expect(sanitizeLabel("Support SUP-1042")).toBe("Support SUP-1042");
  });

  it("returns empty for a missing label", () => {
    expect(sanitizeLabel(null)).toBe("");
    expect(sanitizeLabel(undefined)).toBe("");
    expect(sanitizeLabel("   ")).toBe("");
  });

  it("flattens control characters and collapses the whitespace they leave", () => {
    expect(sanitizeLabel("a" + ctl(10) + "b" + ctl(9) + "c" + ctl(0) + "d")).toBe("a b c d");
  });

  it("drops bidirectional overrides, which could reorder the banner text", () => {
    expect(sanitizeLabel("safe" + ctl(0x202e) + "evil")).toBe("safe evil");
  });

  it("drops invisible format characters that would pad the banner", () => {
    expect(sanitizeLabel("a" + ctl(0x200b) + "b" + ctl(0xfeff) + "c" + ctl(0x061c) + "d")).toBe(
      "a b c d",
    );
  });

  it("caps the length so a long label cannot flood the banner", () => {
    const capped = sanitizeLabel("x".repeat(500));
    expect(capped).toHaveLength(80);
    expect(capped.endsWith("...")).toBe(true);
  });
});

describe("parseMode", () => {
  it("defaults to both, including for an unknown value", () => {
    expect(parseMode(undefined)).toBe("both");
    expect(parseMode("nonsense")).toBe("both");
  });

  it("accepts the three explicit modes", () => {
    expect(parseMode("off")).toBe("off");
    expect(parseMode("banner")).toBe("banner");
    expect(parseMode("sound")).toBe("sound");
  });
});

describe("bannerArgs", () => {
  // The label is agent-controlled: as its own argv item it can never be read as an
  // option or as part of another value, whatever it contains.
  it("passes every value as a separate argument", () => {
    expect(bannerArgs("body text", "a label")).toEqual([
      "post",
      "--title",
      "Gatekeeper",
      "--body",
      "body text",
      "--subtitle",
      "a label",
    ]);
  });

  it("omits the subtitle rather than passing an empty one", () => {
    expect(bannerArgs("body text", "")).not.toContain("--subtitle");
  });

  it("keeps a hostile label as one inert argument", () => {
    const hostile = '--title=pwned" && touch /tmp/pwned #';
    const args = bannerArgs("body", hostile);
    expect(args.filter((a) => a === hostile)).toHaveLength(1);
    expect(args[args.length - 1]).toBe(hostile);
  });

  // The helper reads the first occurrence of each flag, and ours come first.
  it("shadows a label that impersonates the body flag", () => {
    const args = bannerArgs("real body", "--body");
    expect(args.indexOf("--body")).toBeLessThan(args.lastIndexOf("--body"));
    expect(args[args.indexOf("--body") + 1]).toBe("real body");
  });
});

describe("active", () => {
  it("is false off macOS and when switched off, so callers skip the work entirely", () => {
    expect(harness({ platform: "linux" }).notifier.active).toBe(false);
    expect(harness({ mode: "off" }).notifier.active).toBe(false);
    expect(harness().notifier.active).toBe(true);
  });
});

describe("notify", () => {
  it("does nothing off macOS", async () => {
    const { calls, notifier } = harness({ platform: "linux" });
    notifier.notify("label");
    await settle();
    expect(calls).toEqual([]);
  });

  it("does nothing when switched off", async () => {
    const { calls, notifier } = harness({ mode: "off" });
    notifier.notify("label");
    await settle();
    expect(calls).toEqual([]);
  });

  // Ordering matters only between these two: the sound deliberately does not wait for
  // the registration, so it lands first and is not asserted on here.
  it("registers with LaunchServices before posting, since the API refuses an unknown app", async () => {
    const { calls, notifier } = harness();
    notifier.notify("label");
    await settle();
    const register = calls.findIndex(isRegister);
    const post = calls.findIndex(isHelper);
    expect(register).toBeGreaterThanOrEqual(0);
    expect(post).toBeGreaterThan(register);
    expect(calls[register].args).toEqual(["-f", "/pkg/notifier.noindex/Gatekeeper.app"]);
  });

  it("registers only once across repeated alerts", async () => {
    const { calls, notifier } = harness();
    notifier.notify("one");
    await settle();
    notifier.notify("two");
    await settle();
    expect(calls.filter(isRegister)).toHaveLength(1);
  });

  // A latch set before the call would leave every later alert running unregistered,
  // which the notification centre refuses without ever prompting.
  it("retries the registration after a failure instead of latching it", async () => {
    const calls: Call[] = [];
    let failNext = true;
    const notifier = createNotifier({
      run: async (cmd, args, timeoutMs) => {
        calls.push({ cmd, args, timeoutMs });
        if (cmd.includes("lsregister") && failNext) {
          failNext = false;
          throw new Error("transient");
        }
        return { stdout: "authorization=authorized result=ok" };
      },
      platform: "darwin",
      mode: "banner",
      bundle: "/pkg/Gatekeeper.app",
      helper: "/pkg/Gatekeeper.app/Contents/MacOS/gatekeeper-notify",
      log: () => {},
    });
    notifier.notify("one");
    await settle();
    notifier.notify("two");
    await settle();
    expect(calls.filter(isRegister)).toHaveLength(2);
    expect(calls.filter(isHelper)).toHaveLength(1);
  });

  // The first proposal on a machine waits for a human to answer the permission dialog.
  it("gives the banner a timeout long enough to outlast the permission prompt", async () => {
    const { calls, notifier } = harness();
    notifier.notify("label");
    await settle();
    expect(calls.find(isHelper)?.timeoutMs).toBe(NOTIFY_PROMPT_TIMEOUT_MS);
    expect(calls.find(isRegister)?.timeoutMs).toBe(NOTIFY_TIMEOUT_MS);
    expect(calls.find((c) => c.cmd === "afplay")?.timeoutMs).toBe(NOTIFY_TIMEOUT_MS);
  });

  it("plays the sound through its own command, not through the banner", async () => {
    const { calls, notifier } = harness();
    notifier.notify("label");
    await settle();
    expect(calls.find((c) => c.cmd === "afplay")?.args).toEqual([
      "/System/Library/Sounds/Glass.aiff",
    ]);
    expect(calls.find(isHelper)?.args.join(" ")).not.toContain("Glass");
  });

  it("plays the sound even when the banner fails", async () => {
    const calls: Call[] = [];
    const notifier = createNotifier({
      run: async (cmd, args, timeoutMs) => {
        calls.push({ cmd, args, timeoutMs });
        if (cmd.includes("gatekeeper-notify")) {
          throw new Error("helper missing");
        }
        return { stdout: "" };
      },
      platform: "darwin",
      mode: "both",
      bundle: "/pkg/Gatekeeper.app",
      helper: "/pkg/Gatekeeper.app/Contents/MacOS/gatekeeper-notify",
      log: () => {},
    });
    notifier.notify("label");
    await settle();
    expect(calls.some((c) => c.cmd === "afplay")).toBe(true);
  });

  it("skips the helper in sound mode and afplay in banner mode", async () => {
    const soundOnly = harness({ mode: "sound" });
    soundOnly.notifier.notify("label");
    await settle();
    expect(soundOnly.calls.map((c) => c.cmd)).toEqual(["afplay"]);

    const bannerOnly = harness({ mode: "banner" });
    bannerOnly.notifier.notify("label");
    await settle();
    expect(bannerOnly.calls.some((c) => c.cmd === "afplay")).toBe(false);
  });

  it("reports a denied grant, which the API otherwise accepts in silence", async () => {
    const { logs, notifier } = harness({}, "authorization=denied result=ok");
    notifier.notify("label");
    await settle();
    expect(logs.join(" ")).toContain("not authorized");
  });

  // The real helper exits non-zero when the grant is missing, so the state arrives on a
  // rejected spawn that still carries stdout.
  it("reports a denied grant even though the helper exits non-zero", async () => {
    const logs: string[] = [];
    const notifier = createNotifier({
      run: async (cmd) => {
        if (cmd.includes("gatekeeper-notify")) {
          return { stdout: "authorization=denied result=ok" };
        }
        return { stdout: "" };
      },
      platform: "darwin",
      mode: "banner",
      bundle: "/pkg/Gatekeeper.app",
      helper: "/pkg/Gatekeeper.app/Contents/MacOS/gatekeeper-notify",
      log: (m) => logs.push(m),
    });
    notifier.notify("label");
    await settle();
    expect(logs.join(" ")).toContain("not authorized");
  });

  it("warns once rather than on every proposal", async () => {
    const { logs, notifier } = harness({}, "authorization=denied result=ok");
    notifier.notify("one");
    await settle();
    notifier.notify("two");
    await settle();
    expect(logs).toHaveLength(1);
  });

  it("stays quiet when the grant is in place", async () => {
    const { logs, notifier } = harness();
    notifier.notify("label");
    await settle();
    expect(logs).toEqual([]);
  });

  it("never throws when every command fails", async () => {
    const notifier = createNotifier({
      run: async () => {
        throw new Error("sandboxed");
      },
      platform: "darwin",
      mode: "both",
      bundle: "/pkg/Gatekeeper.app",
      helper: "/pkg/Gatekeeper.app/Contents/MacOS/gatekeeper-notify",
      log: () => {},
    });
    expect(() => notifier.notify("label")).not.toThrow();
    await settle();
  });
});

describe("probe", () => {
  it("asks the helper for the grant at startup and stays quiet when it holds", async () => {
    const { calls, logs, notifier } = harness();
    notifier.probe();
    await settle();
    expect(calls.find(isHelper)?.args).toEqual(["status"]);
    expect(logs).toEqual([]);
  });

  it("reports a missing grant at startup rather than leaving it to be found as silence", async () => {
    const { logs, notifier } = harness({}, "authorization=notDetermined result=ok");
    notifier.probe();
    await settle();
    expect(logs.join(" ")).toContain("not authorized");
  });

  it("does nothing off macOS or when no banner is wanted", async () => {
    const off = harness({ platform: "linux" });
    off.notifier.probe();
    const soundOnly = harness({ mode: "sound" });
    soundOnly.notifier.probe();
    await settle();
    expect(off.calls).toEqual([]);
    expect(soundOnly.calls).toEqual([]);
  });

  it("never throws when the helper is missing", async () => {
    const notifier = createNotifier({
      run: async () => {
        throw new Error("no such file");
      },
      platform: "darwin",
      mode: "both",
      bundle: "/pkg/Gatekeeper.app",
      helper: "/pkg/Gatekeeper.app/Contents/MacOS/gatekeeper-notify",
      log: () => {},
    });
    expect(() => notifier.probe()).not.toThrow();
    await settle();
  });
});
