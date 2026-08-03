import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_WAIT_MS, SESSION_HEARTBEAT_MS } from "./config.js";
import {
  cancelQuery,
  getQueryResult,
  pollResults,
  ServiceError,
  submitQuery,
  type Ticket,
} from "./service.js";
import { type RequestStore, StoreError } from "./store.js";

export function createMcpServer(store: RequestStore): { server: McpServer; sessionId: string } {
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

  // Register the session the moment the handshake completes, so an agent shows in
  // the roster even before it submits anything, and heartbeat it for the life of
  // the stdio connection so an idle-but-connected agent stays live.
  server.server.oninitialized = () => {
    store.upsertSession({ sessionId, ...identity() });
    const heartbeat = setInterval(() => store.heartbeatSession(sessionId), SESSION_HEARTBEAT_MS);
    heartbeat.unref();
  };

  server.registerTool(
    "submit_query",
    {
      title: "Propose a SQL query for human approval",
      description:
        "Enqueue a SQL statement for a human to approve in Beekeeper Studio. Reads (SELECT) are always allowed; an INSERT/UPDATE runs only if a human has armed Write mode, and DELETE/DROP/TRUNCATE only under Destructive mode. Those modes are ephemeral, off by default, and armed by the human in the plugin, not by you. The statement never runs until a human approves it, and is rejected if the mode it needs is not armed. Returns immediately with a request_id. Requires a session label: call set_session_label first, or this is rejected. Non-blocking: submit several, keep working (investigate, read, propose more) while they await approval, then use poll_results to see which resolved and get_query_result to read one. Do not end your turn with a query still pending; poll or wait for it first.",
      inputSchema: {
        sql: z
          .string()
          .describe(
            "The SQL to propose (a read, or a write for a human to approve under Write/Destructive mode).",
          ),
        intent: z
          .string()
          .optional()
          .describe(
            "Plain-language reason a human reviewer can approve at a glance: the goal behind this query and why you're running it, with a ticket or incident id if there is one. Don't restate the SQL or use table/column jargon; keep raw PII, secrets, and record values out.",
          ),
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
        "Read a submitted query by request_id. Optionally waits up to wait_ms (bounded) for a terminal state; the wait returns the instant the human decides. States: pending, leased, executing, approved, rejected, failed, expired, cancelled. To check many proposals in one call, use poll_results.",
      inputSchema: {
        request_id: z.string(),
        wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
      },
    },
    async ({ request_id, wait_ms }) => {
      try {
        store.upsertSession({ sessionId, ...identity() });
        return ok(await getQueryResult(store, sessionId, request_id, wait_ms ?? 0));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "poll_results",
    {
      title: "Check all your proposed queries at once",
      description:
        "Return the current state of every query this session proposed recently (pending, leased, executing, approved, rejected, failed, expired, cancelled) in one call. Use it to keep working while queries await approval and collect them as they land: submit_query (non-blocking), do other work, then poll_results to see which resolved, and get_query_result to read a resolved one's rows. Optionally wait up to wait_ms (bounded) to return the instant any still-pending one resolves. It returns states only, not rows. Do not end your turn while a query is still pending: poll or wait for it first.",
      inputSchema: {
        wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
      },
    },
    async ({ wait_ms }) => {
      try {
        store.upsertSession({ sessionId, ...identity() });
        const snapshot = await pollResults(store, sessionId, wait_ms ?? 0);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(snapshot, null, 2) }],
        };
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
        store.upsertSession({ sessionId, ...identity() });
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
        "Return informational context about the database the plugin is connected to: dialect, database name, default schema, read-only mode, the human's armed access mode (read/write/destructive), and when it was captured. Never contains host, user, or credentials. Informational only; do not treat it as an authorization boundary.",
      inputSchema: {},
    },
    async () => {
      store.upsertSession({ sessionId, ...identity() });
      const info = store.getConnection();
      const payload = info ?? { connected: false };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    "run_query",
    {
      title: "Run a query and wait for the human decision",
      description:
        "Convenience wrapper that submits a query and waits (bounded) for the terminal result. Reads are always allowed; a write/destructive statement runs only if a human has armed the matching mode (Write or Destructive), else it is rejected. It serializes one query at a time; prefer submit_query + get_query_result when you want concurrency.",
      inputSchema: {
        sql: z.string(),
        intent: z
          .string()
          .optional()
          .describe(
            "Plain-language reason a human reviewer can approve at a glance: the goal behind this query and why you're running it, with a ticket or incident id if there is one. Don't restate the SQL or use table/column jargon; keep raw PII, secrets, and record values out.",
          ),
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

  server.registerTool(
    "set_session_label",
    {
      title: "Label what this session is working on",
      description:
        "Set a short, human-readable label for this session (ideally matching your own session's title so a human can correlate the two). You must call this before any query; Gatekeeper rejects submit_query until a session label is set. It appears in the Beekeeper plugin's connected-agents roster so the human sees each agent's purpose at a glance. Update it if the task changes. Never include PII, credentials, or connection details.",
      inputSchema: {
        label: z
          .string()
          .describe(
            "The whole session or task you're on (a ticket or incident id works well), not a single query, so the human can match this agent to your session. A few words, no PII, credentials, or connection details. E.g. 'Support SUP-1042: login/identity check'.",
          ),
      },
    },
    async ({ label }) => {
      try {
        store.upsertSession({ sessionId, ...identity() });
        store.setSessionLabel(sessionId, label);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true }, null, 2) }],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  return { server, sessionId };
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
