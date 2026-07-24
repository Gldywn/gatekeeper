import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { ProposalQueue, ProposalResult } from "./queue.js";

// We own the broker, so we grant CORS to the plugin's `plugin://` origin.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Result payloads carry the query rows, so the cap is generous.
const MAX_BODY_BYTES = 256 * 1024 * 1024;

export function createBroker(queue: ProposalQueue): Server {
  return createServer((req, res) => {
    handle(queue, req, res).catch((err) => {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

async function handle(
  queue: ProposalQueue,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/pending") {
    const proposal = queue.claimNext();
    if (!proposal) {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    sendJson(res, 200, proposal);
    return;
  }

  if (req.method === "POST" && req.url === "/result") {
    const body = await readJson(req);
    const result = toResult(body);
    if (!result || typeof body.id !== "string") {
      sendJson(res, 400, { error: "invalid result payload" });
      return;
    }
    const matched = queue.resolve(body.id, result);
    sendJson(res, matched ? 200 : 404, { ok: matched });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function toResult(body: any): ProposalResult | null {
  if (body?.status === "approved") {
    if (body.error) {
      return { status: "error", error: String(body.error) };
    }
    return {
      status: "approved",
      rows: Array.isArray(body.rows) ? body.rows : [],
      fields: Array.isArray(body.fields) ? body.fields : [],
    };
  }
  if (body?.status === "rejected") {
    return {
      status: "rejected",
      reason: typeof body.reason === "string" ? body.reason : undefined,
    };
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJson(req: IncomingMessage): Promise<any> {
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
