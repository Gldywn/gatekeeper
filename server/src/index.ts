import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { RequestStore } from "./store.js";
import { createBroker } from "./broker.js";
import { createMcpServer } from "./mcp.js";
import {
  BROKER_HOST,
  MAX_PENDING_PER_SESSION,
  PROPOSAL_TTL_MS,
  SWEEP_INTERVAL_MS,
  brokerPort,
  dbPath,
  tokenPath,
} from "./config.js";

function loadOrCreateToken(): string {
  const fromEnv = process.env.GATEKEEPER_TOKEN;
  if (fromEnv) {
    return fromEnv;
  }
  const file = tokenPath();
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const token = randomBytes(32).toString("base64url");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, token, { mode: 0o600 });
    return token;
  }
}

async function main(): Promise<void> {
  const path = dbPath();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const store = new RequestStore({
    path,
    proposalTtlMs: PROPOSAL_TTL_MS,
    maxPendingPerSession: MAX_PENDING_PER_SESSION,
  });
  const pluginId = `plugin_${randomBytes(6).toString("hex")}`;
  const token = loadOrCreateToken();

  const broker = createBroker(store, pluginId, token);
  const port = brokerPort();
  await new Promise<void>((resolve, reject) => {
    broker.once("error", reject);
    broker.listen(port, BROKER_HOST, () => {
      broker.off("error", reject);
      // stdout is the MCP stdio channel, so all logs go to stderr.
      console.error(`[gatekeeper] broker on http://${BROKER_HOST}:${port} (db: ${path})`);
      if (!process.env.GATEKEEPER_TOKEN) {
        console.error(`[gatekeeper] pair the plugin with the token at ${tokenPath()}`);
      }
      resolve();
    });
  });

  const sweep = setInterval(() => store.sweep(), SWEEP_INTERVAL_MS);
  sweep.unref();

  // Exit when the MCP client disconnects so we do not hold the broker port.
  const shutdown = () => {
    clearInterval(sweep);
    broker.close();
    store.close();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const mcp = createMcpServer(store);
  await mcp.connect(new StdioServerTransport());
  console.error("[gatekeeper] MCP server ready on stdio");
}

main().catch((err) => {
  console.error("[gatekeeper] fatal:", err);
  process.exit(1);
});
