import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_WAIT_MS } from "./config.js";
import { cancelQuery, getQueryResult, ServiceError, submitQuery, type Ticket } from "./service.js";
import { type RequestStore, StoreError } from "./store.js";

export function createMcpServer(store: RequestStore): McpServer {
  // One stdio client per process; this identifies its request ownership.
  const sessionId = `sess_${randomBytes(9).toString("hex")}`;
  const server = new McpServer({ name: "gatekeeper", version: "0.0.1" });

  // Identify the connected harness (claude-code, codex, opencode, ...) and the
  // project it runs in, so the plugin can group pending proposals by session.
  const project = basename(process.cwd());
  const identity = () => {
    const client = server.server.getClientVersion();
    return { harness: client?.name ?? null, harnessVersion: client?.version ?? null, project };
  };

  server.registerTool(
    "submit_query",
    {
      title: "Propose a read-only SQL query for human approval",
      description:
        "Enqueue a read-only SQL SELECT for a human to approve in Beekeeper Studio. Returns immediately with a request_id; poll get_query_result for the outcome. Non-blocking, so you can submit several queries and collect their results as they resolve.",
      inputSchema: {
        sql: z.string().describe("The read-only SQL SELECT to propose."),
        intent: z.string().optional().describe("A short, human-readable reason for the query."),
        idempotency_key: z
          .string()
          .optional()
          .describe("Optional key so a retried submission returns the same request."),
      },
    },
    async ({ sql, intent, idempotency_key }) => {
      try {
        return ok(
          submitQuery(store, {
            sessionId,
            sql,
            intent,
            idempotencyKey: idempotency_key,
            ...identity(),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_query_result",
    {
      title: "Get the result of a proposed query",
      description:
        "Read a submitted query by request_id. Optionally waits up to wait_ms (bounded) for a terminal state. States: pending, leased, executing, approved, rejected, failed, expired, cancelled.",
      inputSchema: {
        request_id: z.string(),
        wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
      },
    },
    async ({ request_id, wait_ms }) => {
      try {
        return ok(await getQueryResult(store, sessionId, request_id, wait_ms ?? 0));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "cancel_query",
    {
      title: "Cancel a pending query",
      description: "Withdraw a pending or leased query you submitted.",
      inputSchema: { request_id: z.string() },
    },
    async ({ request_id }) => {
      try {
        return ok(cancelQuery(store, sessionId, request_id));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_connection_info",
    {
      title: "Get non-sensitive context about the connected database",
      description:
        "Return informational context about the database the plugin is connected to: dialect, database name, default schema, read-only mode, and when it was captured. Never contains host, user, or credentials. Informational only; do not treat it as an authorization boundary.",
      inputSchema: {},
    },
    async () => {
      const info = store.getConnection();
      const payload = info ?? { connected: false };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    "run_query",
    {
      title: "Run a read-only query and wait for the human decision",
      description:
        "Convenience wrapper that submits a query and waits (bounded) for the terminal result. It serializes one query at a time; prefer submit_query + get_query_result when you want concurrency.",
      inputSchema: {
        sql: z.string(),
        intent: z.string().optional(),
      },
    },
    async ({ sql, intent }) => {
      try {
        const submitted = submitQuery(store, { sessionId, sql, intent, ...identity() });
        return ok(await getQueryResult(store, sessionId, submitted.requestId, MAX_WAIT_MS));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

function ok(ticket: Ticket) {
  return { content: [{ type: "text" as const, text: JSON.stringify(ticket, null, 2) }] };
}

function fail(err: unknown) {
  const code = err instanceof ServiceError || err instanceof StoreError ? err.code : "ERROR";
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: { code, message } }, null, 2) },
    ],
    isError: true,
  };
}
