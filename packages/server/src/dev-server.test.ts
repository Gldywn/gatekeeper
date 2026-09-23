import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { spawn, scan, connect, exists } = vi.hoisted(() => ({
  spawn: vi.fn(),
  scan: vi.fn(),
  connect: vi.fn(),
  exists: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn, spawnSync: scan }));
vi.mock("node:net", () => ({ createConnection: connect }));
vi.mock("node:fs", () => ({ existsSync: exists }));

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
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "dev-server.mjs", "--watch"]);
  exists.mockReturnValue(true);
  scan.mockReturnValue({ status: 0, stdout: "" });
  spawn.mockReturnValue({ on: vi.fn(), kill: vi.fn() });
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
    { stdio: "inherit" },
  );
});

it("keeps the existing compiled MCP launch when watch is absent", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "dev-server.mjs"]);
  await import(launcher);
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    [expect.stringContaining("/packages/server/dist/index.js")],
    { stdio: "inherit" },
  );
});

it("stops before takeover when process discovery fails", async () => {
  scan.mockReturnValue({ status: 1, stdout: "", error: new Error("EPERM") });
  await expect(import(launcher)).rejects.toThrow("Cannot list Gatekeeper processes");
  expect(process.kill).not.toHaveBeenCalled();
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
  expect(spawn).not.toHaveBeenCalled();
});
