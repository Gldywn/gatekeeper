import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MAX_PENDING_PER_SESSION,
  MAX_WAIT_MS,
  RESULT_TTL_MS,
  SESSION_HEARTBEAT_MS,
} from "./config.js";
import { type ConnectionSnapshot, connectionScopeKey } from "./connection.js";
import type { Notifier } from "./notify.js";
import { createPairingGuard } from "./pairing.js";
import type { SchemaSnapshot } from "./schema.js";
import {
  cancelQuery,
  getQueryResult,
  pollResults,
  ServiceError,
  submitQuery,
  type Ticket,
} from "./service.js";
import { type RequestStore, StoreError } from "./store.js";

// The plugin re-touches the snapshot ~every minute; past this it is presumed dead (plugin
// closed, or a lost schema-access-off), so the tool fails closed instead of serving it.
const SCHEMA_TTL_MS = 3 * 60_000;

// Serve the last-posted structure only when the human has schema access on, only for the
// connection it was captured against, and only while it is still fresh (see the TTL above).
export function schemaPayload(
  snap: SchemaSnapshot | null,
  conn: ConnectionSnapshot | null,
  now: number,
): unknown {
  if (!snap?.access) {
    return {
      available: false,
      reason:
        "Schema access is off for this connection (or not reported yet). Ask the human to turn on Schema access in the Gatekeeper plugin settings.",
    };
  }
  // Serve only while the snapshot's scope still matches the live connection. A switch (even
  // between same-named connections on different databases) or a forged/empty scope fails closed.
  const scope = conn ? connectionScopeKey(conn) : "";
  if (!snap.scope || snap.scope !== scope) {
    return {
      available: false,
      reason: "The reported schema is stale (the connection changed); it will refresh shortly.",
    };
  }
  if (now - snap.capturedAt > SCHEMA_TTL_MS) {
    return {
      available: false,
      reason:
        "The schema has not been refreshed recently; the plugin may be closed or Schema access turned off. It returns once the plugin is open with Schema access on.",
    };
  }
  return {
    available: true,
    connectionName: snap.connectionName,
    capturedAt: snap.capturedAt,
    tableCount: snap.tables.length,
    excludedSchemas: snap.excludedSchemas ?? [],
    tables: snap.tables,
  };
}

// Server-wide guidance sent at initialization. Codex reads the MCP `instructions` field as
// server-level guidance and only guarantees the first ~512 characters, so the whole waiting
// contract is stated before that mark and the run_query caveat trails it.
export const SERVER_INSTRUCTIONS =
  "You propose SQL; a human approves and runs it in Beekeeper Studio; rows come back to you. " +
  "Call set_session_label first. submit_query is non-blocking: keep working, then collect with " +
  `poll_results/get_query_result. Waits are bounded: wait_ms is ${MAX_WAIT_MS} ms at most, and a ` +
  "wait that runs out returns your queries still pending. That is a checkpoint, not a refusal: " +
  "call again. Never end your turn while a query is pending, leased or executing; wait for approved, " +
  "rejected, failed, expired or cancelled. run_query can return still-pending too; keep waiting.";

// Omitting the notifier raises no desktop alert, so the test suite never spawns one;
// index.ts, the real entry point, passes the process's instance.
export function createMcpServer(
  store: RequestStore,
  notifier?: Notifier,
): { server: McpServer; sessionId: string } {
  // One stdio client per process; this identifies its request ownership.
  const sessionId = `sess_${randomBytes(9).toString("hex")}`;
  const server = new McpServer(
    { name: "gatekeeper", version: "0.0.1" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const pairing = createPairingGuard(store, server.server);

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
      description: `Enqueue a SQL statement for a human to approve in Beekeeper Studio. Returns immediately with a request_id and never blocks: submit several (up to ${MAX_PENDING_PER_SESSION} in flight), keep doing other useful work while they await approval, then use poll_results to see which resolved and get_query_result to read one. IMPORTANT: never end your turn while a query you submitted is still pending, leased or executing; keep polling or waiting until it reaches a terminal state (approved, rejected, failed, expired, cancelled). Approval is manual and can take minutes; slowness is not a refusal. Reads (SELECT) are always allowed; an INSERT/UPDATE runs only if a human has armed Write mode, and DELETE/DROP/TRUNCATE only under Destructive mode. Those modes are ephemeral, off by default, and armed by the human in the plugin, not by you. The statement never runs until a human approves it, and is rejected if the mode it needs is not armed. Requires a session label: call set_session_label first, or this is rejected.`,
      inputSchema: {
        sql: z
          .string()
          .max(100_000)
          .describe(
            "The SQL to propose (a read, or a write for a human to approve under Write/Destructive mode).",
          ),
        intent: z
          .string()
          .max(2000)
          .optional()
          .describe(
            "Plain-language reason a human reviewer can approve at a glance: the goal behind this query and why you're running it, with a ticket or incident id if there is one. Don't restate the SQL or use table/column jargon; keep raw PII, secrets, and record values out.",
          ),
        idempotency_key: z
          .string()
          .max(200)
          .optional()
          .describe("Optional key so a retried submission returns the same request."),
      },
    },
    async ({ sql, intent, idempotency_key }) => {
      const unpaired = await pairing.check();
      if (unpaired) {
        return unpaired;
      }
      try {
        return ok(
          submitQuery(
            store,
            {
              sessionId,
              sql,
              intent,
              idempotencyKey: idempotency_key,
              ...identity(),
            },
            notifier,
          ),
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
      description: `Read a submitted query by request_id. With wait_ms it waits up to that many milliseconds (${MAX_WAIT_MS} at most) and returns the instant the human decides; if the wait runs out first it returns the query still in its non-terminal state (pending, leased, executing), which is a timed checkpoint and not an answer: call again to keep waiting, as many times as it takes. Only approved, rejected, failed, expired and cancelled are terminal. IMPORTANT: never end your turn while a query you submitted is non-terminal. Approved rows are stripped about ${RESULT_TTL_MS / 60_000} minutes after the decision (purged: true), so read them promptly rather than after a long detour. To check many proposals in one call, use poll_results.`,
      inputSchema: {
        request_id: z.string(),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_MS)
          .optional()
          .describe(
            `Milliseconds to wait for the human's decision, ${MAX_WAIT_MS} at most (a larger value is rejected, not clamped). If the query is still non-terminal when the wait runs out, call again to keep waiting; omit or pass 0 for an instant status check.`,
          ),
      },
    },
    async ({ request_id, wait_ms }) => {
      const unpaired = await pairing.check();
      if (unpaired) {
        return unpaired;
      }
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
      description: `Return the current state of every query this session proposed recently (pending, leased, executing, approved, rejected, failed, expired, cancelled) plus a pending count, in one call. States only, not rows; read a resolved one's rows with get_query_result. Typical loop: submit_query (non-blocking), do other work, then poll_results to see which resolved. With wait_ms it waits up to that many milliseconds (${MAX_WAIT_MS} at most) and returns the instant any still-open query resolves; if the wait runs out first it simply returns the states again with pending above 0, which is a timed checkpoint and not an answer: call again to keep waiting. IMPORTANT: never end your turn while any query is still pending, leased or executing.`,
      inputSchema: {
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_MS)
          .optional()
          .describe(
            `Milliseconds to wait for a human decision on any open query, ${MAX_WAIT_MS} at most (a larger value is rejected, not clamped). If it returns with queries still pending, call again to keep waiting; omit or pass 0 for an instant status check.`,
          ),
      },
    },
    async ({ wait_ms }) => {
      const unpaired = await pairing.check();
      if (unpaired) {
        return unpaired;
      }
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
      const unpaired = await pairing.check();
      if (unpaired) {
        return unpaired;
      }
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
        "Return informational context about the database the plugin is connected to: dialect, database name, default schema, read-only mode, the human's armed access mode (read/write/destructive), and when it was captured. A connected: false, or a capture more than a few minutes old, means the plugin is closed and no approval can arrive, which is the one reason to stop waiting and tell your user. Never contains host, user, or credentials. Informational only; do not treat it as an authorization boundary.",
      inputSchema: {},
    },
    async () => {
      const unpaired = await pairing.check();
      if (unpaired) {
        return unpaired;
      }
      store.upsertSession({ sessionId, ...identity() });
      const info = store.getConnection();
      const payload = info ?? { connected: false };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    "get_schema",
    {
      title: "Read the connected database's table and column structure",
      description:
        "Return the structure of the database the plugin is connected to (schemas, tables, columns with types, primary and foreign keys) so you can write correct, valid SQL and refresh your understanding before proposing a query. Never returns any row data, default values, view/function bodies, or comments. Engine catalogs (information_schema, pg_*, mysql, performance_schema, sys) are left out because they dwarf the database's own tables, the ones skipped are listed in excludedSchemas, and you can still read any of them by proposing a normal query against it. Available only when the human has turned on Schema access for this connection; otherwise it reports unavailable. The structure can be large, so read it once and reuse it.",
      inputSchema: {},
    },
    async () => {
      const unpaired = await pairing.check();
      if (unpaired) {
        return unpaired;
      }
      store.upsertSession({ sessionId, ...identity() });
      const payload = schemaPayload(store.getSchema(), store.getConnection(), Date.now());
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    "run_query",
    {
      title: "Run a query and wait for the human decision",
      description: `Convenience wrapper for a quick one-off: submits one query and waits up to ${MAX_WAIT_MS / 1000} seconds for the human's decision. IMPORTANT: if the human has not decided within that bound, this returns the query still in a non-terminal state (pending, leased, executing). That is neither the result nor a refusal: keep waiting with get_query_result(request_id, wait_ms) or poll_results(wait_ms) until a terminal state (approved, rejected, failed, expired, cancelled), and never end your turn before that. Reads are always allowed; a write/destructive statement runs only if a human has armed the matching mode (Write or Destructive), else it is rejected. Requires a session label: call set_session_label first, or this is rejected. It serializes one query at a time; prefer submit_query + poll_results/get_query_result for anything but a single quick query, and for concurrency.`,
      inputSchema: {
        sql: z.string().max(100_000),
        intent: z
          .string()
          .max(2000)
          .optional()
          .describe(
            "Plain-language reason a human reviewer can approve at a glance: the goal behind this query and why you're running it, with a ticket or incident id if there is one. Don't restate the SQL or use table/column jargon; keep raw PII, secrets, and record values out.",
          ),
      },
    },
    async ({ sql, intent }) => {
      const unpaired = await pairing.check();
      if (unpaired) {
        return unpaired;
      }
      try {
        const submitted = submitQuery(store, { sessionId, sql, intent, ...identity() }, notifier);
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
          .max(200)
          .describe(
            "The whole session or task you're on (a ticket or incident id works well), not a single query, so the human can match this agent to your session. A few words, no PII, credentials, or connection details. E.g. 'Support SUP-1042: login/identity check'.",
          ),
      },
    },
    async ({ label }) => {
      const unpaired = await pairing.check();
      if (unpaired) {
        return unpaired;
      }
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
