import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { spawn, scan, connect, hold, mkdtemp } = vi.hoisted(() => ({
  spawn: vi.fn(),
  scan: vi.fn(),
  connect: vi.fn(),
  hold: vi.fn(),
  mkdtemp: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn, spawnSync: scan }));
vi.mock("node:net", () => ({ createConnection: connect }));
vi.mock("node:fs", () => ({ mkdtempSync: mkdtemp, rmSync: vi.fn() }));
vi.mock("../../../scripts/broker-proxy.mjs", () => ({ holdBrokerPort: hold }));

const launcher = fileURLToPath(new URL("../../../scripts/dev-server.mjs", import.meta.url));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.spyOn(process, "on").mockReturnValue(process);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "dev-server.mjs"]);
  scan.mockReturnValue({ status: 0, stdout: "" });
  spawn.mockReturnValue({ on: vi.fn(), kill: vi.fn() });
  hold.mockResolvedValue({});
  mkdtemp.mockReturnValue("/private/gk-dev-test");
  connect.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
    queueMicrotask(() => socket.emit("error", { code: "ECONNREFUSED" }));
    return socket;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("takes over compiled and watched servers, then watches this checkout's sources", async () => {
  scan.mockReturnValue({
    status: 0,
    stdout: [
      "900001 node /work/gatekeeper/packages/server/dist/index.js",
      "900002 node /deps/tsx/cli.mjs watch /work/gatekeeper/packages/server/src/index.ts",
      "900003 node /work/another-app/server/src/index.ts",
    ].join("\n"),
  });
  await import(launcher);
  expect(process.kill).toHaveBeenCalledTimes(2);
  expect(process.kill).toHaveBeenCalledWith(900001, "SIGTERM");
  expect(process.kill).toHaveBeenCalledWith(900002, "SIGTERM");
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    [
      expect.stringContaining("tsx"),
      "watch",
      "--clear-screen=false",
      fileURLToPath(new URL("./index.ts", import.meta.url)),
    ],
    expect.objectContaining({ stdio: "inherit" }),
  );
});

it("also takes over a build an OpenCode session started by a relative path", async () => {
  scan.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "ps") {
      return {
        status: 0,
        stdout:
          "900004 node packages/server/dist/index.js\n900005 node packages/server/dist/index.js",
      };
    }
    const cwd = args.includes("900004") ? "/work/gatekeeper-wt" : "/work/another-app";
    return { status: 0, stdout: `p0\nfcwd\nn${cwd}\n` };
  });
  await import(launcher);
  expect(process.kill).toHaveBeenCalledTimes(1);
  expect(process.kill).toHaveBeenCalledWith(900004, "SIGTERM");
});

it("holds the broker port before the server starts, and points the server at its relay", async () => {
  let held!: () => void;
  hold.mockReturnValue(new Promise<void>((resolve) => (held = resolve)));
  const launched = import(launcher);
  await vi.waitFor(() =>
    expect(hold).toHaveBeenCalledWith(9999, "/private/gk-dev-test/broker.sock"),
  );
  expect(spawn).not.toHaveBeenCalled();
  held();
  await launched;
  const env = spawn.mock.calls[0][2].env as Record<string, string>;
  expect(env.GATEKEEPER_BROKER_SOCKET).toBe("/private/gk-dev-test/broker.sock");
});

it("starts no server when it cannot hold the broker port", async () => {
  hold.mockRejectedValue(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }));
  await expect(import(launcher)).rejects.toThrow("EADDRINUSE");
  expect(spawn).not.toHaveBeenCalled();
});

it("hands the server a dev stamp, so a watched build never passes for a release", async () => {
  await import(launcher);
  const env = spawn.mock.calls[0][2].env as Record<string, string>;
  const identity = JSON.parse(env.GATEKEEPER_BUILD_IDENTITY);
  expect(identity.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(identity.dev).toBeTypeOf("object");
});

it("stops before takeover when process discovery fails", async () => {
  scan.mockReturnValue({ status: 1, stdout: "", error: new Error("EPERM") });
  await expect(import(launcher)).rejects.toThrow("Cannot list Gatekeeper processes");
  expect(process.kill).not.toHaveBeenCalled();
  expect(hold).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it("does not start alongside a broker whose port stayed occupied", async () => {
  vi.useFakeTimers();
  connect.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
    Promise.resolve().then(() => socket.emit("connect"));
    return socket;
  });
  const pending = expect(import(launcher)).rejects.toThrow("is still occupied");
  await vi.waitFor(() => expect(connect).toHaveBeenCalled());
  await vi.runAllTimersAsync();
  await pending;
  expect(hold).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
