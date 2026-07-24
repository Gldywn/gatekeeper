import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StoreError, type Outcome, type RequestStore } from "./store.js";
import { BROKER_HOST, LEASE_MS, brokerPort } from "./config.js";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export function createBroker(store: RequestStore, pluginId: string, token: string): Server {
  const port = brokerPort();
  const allowedHosts = new Set([`${BROKER_HOST}:${port}`, `localhost:${port}`]);
  return createServer((req, res) => {
    handle(store, pluginId, allowedHosts, token, req, res).catch((err) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handle(
  store: RequestStore,
  pluginId: string,
  allowedHosts: Set<string>,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // DNS-rebinding defense: only serve loopback Host headers.
  const host = req.headers.host;
  if (host && !allowedHosts.has(host)) {
    send(res, 421, { error: "unexpected Host header" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, baseHeaders());
    res.end();
    return;
  }

  // Any local process can reach loopback, so require the shared capability
  // token on every non-preflight request.
  if (req.headers.authorization !== `Bearer ${token}`) {
    send(res, 401, { error: "unauthorized" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${BROKER_HOST}`);

  if (req.method === "GET" && url.pathname === "/pending") {
    const proposal = store.claimNext(pluginId, LEASE_MS);
    if (!proposal) {
      res.writeHead(204, baseHeaders());
      res.end();
      return;
    }
    send(res, 200, {
      id: proposal.id,
      sql: proposal.sql,
      intent: proposal.intent,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      leaseId: proposal.leaseId,
      leaseExpiresAt: proposal.leaseExpiresAt,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/executing") {
    const body = await readJson(req);
    guarded(res, () => {
      store.markExecuting(String(body.id), String(body.leaseId));
      send(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/result") {
    const body = await readJson(req);
    guarded(res, () => {
      store.resolve(String(body.id), String(body.leaseId), toOutcome(body));
      send(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/lease/renew") {
    const body = await readJson(req);
    guarded(res, () => {
      const renewed = store.renewLease(String(body.id), String(body.leaseId), LEASE_MS);
      send(res, 200, { leaseExpiresAt: renewed.leaseExpiresAt });
    });
    return;
  }

  send(res, 404, { error: "not found" });
}

function guarded(res: ServerResponse, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof StoreError) {
      const status =
        err.code === "NOT_FOUND"
          ? 404
          : err.code === "NOT_OWNER"
            ? 403
            : err.code === "LEASE_CONFLICT" || err.code === "INVALID_STATE"
              ? 409
              : 400;
      send(res, status, { error: err.message, code: err.code });
      return;
    }
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function toOutcome(body: Record<string, unknown>): Outcome {
  if (body.status === "approved") {
    if (body.error) {
      return { status: "failed", error: String(body.error) };
    }
    return {
      status: "approved",
      rows: Array.isArray(body.rows) ? body.rows : [],
      fields: Array.isArray(body.fields) ? body.fields : [],
    };
  }
  return {
    status: "rejected",
    reason: typeof body.reason === "string" ? body.reason : undefined,
  };
}

function baseHeaders(): Record<string, string> {
  return { ...CORS, "Cache-Control": "no-store" };
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { ...baseHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}
