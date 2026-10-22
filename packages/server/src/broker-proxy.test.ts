import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const proxyModule = fileURLToPath(new URL("../../../scripts/broker-proxy.mjs", import.meta.url));

const listen = (server: Server, ...target: [string] | [number, string]) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(...target, () => resolve());
  });

const close = (server: Server | undefined) =>
  new Promise((resolve) => (server?.listening ? server.close(resolve) : resolve(undefined)));

// Real sockets on an ephemeral port and a private temp dir: nothing shared with a live broker.
it("keeps the broker port held while the server behind it restarts", async () => {
  const { holdBrokerPort } = await import(proxyModule);
  const dir = mkdtempSync(join(tmpdir(), "gk-proxy-"));
  const socketPath = join(dir, "broker.sock");
  let backend: Server | undefined;
  // Replies only after the caller has half-closed, as a slow handler would.
  const startBackend = async () => {
    backend = createServer({ allowHalfOpen: true }, (s) => {
      let got = "";
      s.on("data", (d) => {
        got += d;
      });
      s.on("end", () => setTimeout(() => s.end(`echo:${got}`), 20));
    });
    await listen(backend, socketPath);
  };
  const proxy: Server = await holdBrokerPort(0, socketPath);
  const port = (proxy.address() as AddressInfo).port;
  const roundTrip = (text: string) =>
    new Promise<string>((resolve) => {
      const client = createConnection({ port, host: "127.0.0.1", allowHalfOpen: true });
      let out = "";
      client.on("data", (d) => {
        out += d;
      });
      client.on("error", () => {});
      client.on("close", () => resolve(out));
      client.end(text);
    });

  try {
    await startBackend();
    const head =
      "GET /sessions HTTP/1.1\r\nHost: 127.0.0.1:9999\r\nAuthorization: Bearer synthetic\r\n\r\n";
    expect(await roundTrip(head)).toBe(`echo:${head}`);

    await close(backend);
    expect(await roundTrip("ping")).toBe("");
    await expect(listen(createServer(), port, "127.0.0.1")).rejects.toMatchObject({
      code: "EADDRINUSE",
    });

    await startBackend();
    expect(await roundTrip("ping")).toBe("echo:ping");
  } finally {
    await close(backend);
    await close(proxy);
    rmSync(dir, { recursive: true, force: true });
  }
});
