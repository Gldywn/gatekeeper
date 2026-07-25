import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBroker } from "./broker.js";
import {
  BROKER_HOST,
  brokerPort,
  dbPath,
  MAX_PENDING_PER_SESSION,
  PROPOSAL_TTL_MS,
  REBIND_INTERVAL_MS,
  REBIND_JITTER_MS,
  RESULT_TTL_MS,
  SWEEP_INTERVAL_MS,
  tokenPath,
} from "./config.js";
import { createMcpServer } from "./mcp.js";
import { RequestStore } from "./store.js";

// ~/.gatekeeper holds the capability token and the results DB (with WAL side
// files), so keep the whole directory owner-only rather than chasing per-file
// modes that sqlite recreates.
function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir does not tighten an already-existing directory; enforce it explicitly.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on filesystems that do not support chmod
  }
}

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
    ensureSecureDir(dirname(file));
    writeFileSync(file, token, { mode: 0o600 });
    return token;
  }
}

async function main(): Promise<void> {
  const path = dbPath();
  if (path !== ":memory:") {
    ensureSecureDir(dirname(path));
  }
  const store = new RequestStore({
    path,
    proposalTtlMs: PROPOSAL_TTL_MS,
    maxPendingPerSession: MAX_PENDING_PER_SESSION,
    resultTtlMs: RESULT_TTL_MS,
  });
  const pluginId = `plugin_${randomBytes(6).toString("hex")}`;
  const token = loadOrCreateToken();

  const broker = createBroker(store, pluginId, token);
  const port = brokerPort();
  let brokerOwner = false;
  let shuttingDown = false;

  // Only one process can own the broker port; the others run MCP-only and share
  // the same SQLite queue, so a taken port is expected here, not fatal.
  const tryBind = (): Promise<boolean> =>
    new Promise((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code !== "EADDRINUSE") {
          console.error(`[gatekeeper] broker listen error: ${err.message}`);
        }
        resolve(false);
      };
      broker.once("error", onError);
      broker.listen(port, BROKER_HOST, () => {
        broker.off("error", onError);
        resolve(true);
      });
    });

  brokerOwner = await tryBind();
  if (brokerOwner) {
    // stdout is the MCP stdio channel, so all logs go to stderr.
    console.error(`[gatekeeper] broker on http://${BROKER_HOST}:${port} (db: ${path})`);
    if (!process.env.GATEKEEPER_TOKEN) {
      console.error(`[gatekeeper] pair the plugin with the token at ${tokenPath()}`);
    }
  } else {
    console.error(
      `[gatekeeper] ${BROKER_HOST}:${port} is owned by another instance; running MCP-only, will take over if it exits`,
    );
  }

  // Failover: a non-owner retries the port on a jittered cadence and takes over
  // if the current owner exits.
  const scheduleRebind = (): void => {
    if (brokerOwner || shuttingDown) {
      return;
    }
    const delay = REBIND_INTERVAL_MS + Math.floor(Math.random() * REBIND_JITTER_MS);
    const timer = setTimeout(() => {
      if (brokerOwner || shuttingDown) {
        return;
      }
      void tryBind().then((won) => {
        brokerOwner = won;
        if (won) {
          console.error(`[gatekeeper] took over the broker on ${BROKER_HOST}:${port}`);
        } else {
          scheduleRebind();
        }
      });
    }, delay);
    timer.unref();
  };
  scheduleRebind();

  // Only the broker owner sweeps, to avoid redundant cross-process writes.
  const sweep = setInterval(() => {
    if (brokerOwner) {
      store.sweep();
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  // Exit when the MCP client disconnects so we release the broker port.
  const shutdown = () => {
    shuttingDown = true;
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
