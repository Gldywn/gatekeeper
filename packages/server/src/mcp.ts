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
import { SERVER_IDENTITY } from "./version.js";

// The plugin re-touches the snapshot ~every minute; past this it is presumed dead (plugin
// closed, or a lost schema-access-off), so the tool fails closed instead of serving it.
const SCHEMA_TTL_MS = 3 * 60_000;

// Claude Code moves an MCP result past 50,000 characters into a file the agent then has to
// page through; staying under it lowers that risk and the context cost, filters do the rest.
const SCHEMA_BUDGET_CHARS = 40_000;
// Room kept for the fixed-text hints, so the envelope never pushes the answer over budget.
const HINT_RESERVE = 1_000;

export interface SchemaFilter {
  schema?: string;
  tables?: string[];
}

// Serve the last-posted structure only when the human has schema access on, only for the
// connection it was captured against, and only while it is still fresh (see the TTL above).
export function schemaPayload(
  snap: SchemaSnapshot | null,
  conn: ConnectionSnapshot | null,
  now: number,
  filter: SchemaFilter = {},
): unknown {
  if (!snap?.access) {
    return {
      available: false,
      reason:
        "Schema access is off for this connection (or not reported yet). Ask the human to turn on Schema access in the Gatekeeper plugin settings; until then, read table and column names with an introspection query against the engine's own catalog.",
    };
  }
  // Serve only while the snapshot's scope still matches the live connection. A switch (even
  // between same-named connections on different databases) or a forged/empty scope fails closed.
  if (!conn || !snap.scope || snap.scope !== connectionScopeKey(conn)) {
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
  const { schema, tables: names } = filter;
  const matched = snap.tables.filter(
    (t) => (schema === undefined || t.schema === schema) && (!names || names.includes(t.name)),
  );
  const head = {
    available: true,
    connectionName: snap.connectionName,
    databaseType: conn.databaseType,
    databaseName: conn.databaseName,
    defaultSchema: conn.schema,
    capturedAt: snap.capturedAt,
    collectedAt: snap.collectedAt ?? null,
    complete: snap.complete ?? null,
    tableCount: snap.tables.length,
    excludedSchemas: snap.excludedSchemas ?? [],
    matched: matched.length,
  };
  // Only a pathological post (thousands of characters of catalog or schema names) gets here;
  // refusing beats an answer the budget no longer bounds.
  if (JSON.stringify(head).length > SCHEMA_BUDGET_CHARS / 2) {
    return {
      available: false,
      reason:
        "The schema's metadata is too large to serve; read table and column names with an introspection query.",
    };
  }
  const hints: string[] = [];
  // The snapshot changes only when the plugin re-collects, so a miss never proves absence.
  const asOf =
    head.complete === true ? " in this snapshot." : " in this snapshot, which may be incomplete.";
  if (schema !== undefined && !snap.tables.some((t) => t.schema === schema)) {
    hints.push(`The requested schema matches no schema${asOf}`);
  }
  const missing = names
    ? [...new Set(names)].filter((n) => !matched.some((t) => t.name === n)).length
    : 0;
  if (missing > 0) {
    hints.push(
      `${missing} requested table name(s) match no table${schema === undefined ? "" : " in the requested schema"}${asOf} Names are exact and unqualified, so pass the schema separately.`,
    );
  }
  const detail = withinBudget(head, matched);
  if (names || detail.length === matched.length) {
    if (detail.length < matched.length) {
      hints.push(
        `${matched.length - detail.length} matched table(s) did not fit in one response. Request them in smaller groups, or narrow with schema when one name matches in several schemas. A table that does not fit alone is too large for get_schema; read its columns with an introspection query.`,
      );
    }
    return response(head, "detail", detail, hints);
  }
  const index = withinBudget(
    head,
    matched.map((t) => ({
      schema: t.schema,
      name: t.name,
      columnCount: t.columns.length,
      ...(t.incomplete ? { incomplete: true } : {}),
    })),
  );
  hints.push(
    "Too large for one response, so this lists tables without columns. Call get_schema with tables (and schema) to read the columns you need.",
  );
  if (index.length < matched.length) {
    hints.push(
      `Only ${index.length} of ${matched.length} tables are listed. Narrow with schema, or list the rest with an introspection query.`,
    );
  }
  return response(head, "index", index, hints);
}

// Keep whole entries that fit the budget once the envelope and its hints are counted, so
// the answer stays valid JSON and never ends mid-table.
function withinBudget<T>(head: object, entries: T[]): T[] {
  let room = SCHEMA_BUDGET_CHARS - HINT_RESERVE - JSON.stringify({ ...head, tables: [] }).length;
  const kept: T[] = [];
  for (const entry of entries) {
    const size = JSON.stringify(entry).length + 1;
    if (size <= room) {
      kept.push(entry);
      room -= size;
    }
  }
  return kept;
}

function response(head: object, mode: "detail" | "index", tables: unknown[], hints: string[]) {
  return {
    ...head,
    mode,
    returned: tables.length,
    ...(hints.length > 0 ? { hint: hints.join(" ") } : {}),
    tables,
  };
}

// Server-wide guidance sent at initialization. Codex reads the MCP `instructions` field as
// server-level guidance and only guarantees the first ~512 characters, so the whole waiting
// contract is stated before that mark and the run_query caveat trails it.
export const SERVER_INSTRUCTIONS =
  "Propose SQL for approval in Beekeeper Studio; rows come back to you. " +
  "Call set_session_label first. submit_query is non-blocking, so keep working, then collect with " +
  `poll_results/get_query_result. wait_ms is ${MAX_WAIT_MS} ms at most, and a ` +
  "wait that runs out returns your queries still pending. That is a checkpoint, not a refusal, so " +
  "call again. Never end your turn while a query is pending, leased or executing; wait for approved, " +
  "rejected, failed, expired or cancelled. run_query can return still-pending too; keep waiting. " +
  "Approval is manual by default; only a human can enable Auto mode beta for restricted reads. " +
  "Never configure Auto mode, request its API key or treat agent intent as authorization. " +
  "Before writing SQL, read get_schema (no approval needed) and the dialect from " +
  "get_connection_info. A failed query says why in terminal.error. Correct a wrong name or syntax " +
  "before proposing again, and after execution_unknown check whether a write ran before any retry.";

// Omitting the notifier raises no desktop alert, so the test suite never spawns one;
// index.ts, the real entry point, passes the process's instance.
export function createMcpServer(
  store: RequestStore,
  notifier?: Notifier,
): { server: McpServer; sessionId: string } {
  // One stdio client per process; this identifies its request ownership.
  const sessionId = `sess_${randomBytes(9).toString("hex")}`;
  const server = new McpServer(
    { name: "gatekeeper", version: SERVER_IDENTITY.version },
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
      title: "Propose a SQL query for approval",
      description: `Enqueue a SQL statement for approval in Beekeeper Studio. Returns immediately with a request_id and never blocks. Submit several (up to ${MAX_PENDING_PER_SESSION} in flight), keep doing other useful work while they await approval, then use poll_results to see which resolved and get_query_result to read one. IMPORTANT: never end your turn while a query you submitted is still pending, leased or executing; keep polling or waiting until it reaches a terminal state (approved, rejected, failed, expired, cancelled). Approval is manual by default and can take minutes; slowness is not a refusal. A human may explicitly enable Auto mode beta for a restricted read subset. You cannot enable it or configure its evaluator. Reads (SELECT) are allowed in Read mode; INSERT/UPDATE requires human-armed Write mode, and DELETE/DROP/TRUNCATE requires Destructive mode. Writes always require human approval. Execution modes are ephemeral and armed in the plugin, not by you. It requires a session label, so call set_session_label first or it is rejected. Get table and column names from get_schema (no approval needed) and the dialect from get_connection_info before writing SQL, because a wrong name costs the human a round trip. Write SQL a reviewer can read at a glance (standard SQL, basic functions, named CTEs for multi-step queries, aliases that say what each value is, with no personal-data words when it holds none). Keep JSON operators, FILTER, LATERAL and other constructs not every engine supports for when no plain equivalent can do it or the construct is clearly more efficient, and say why in the intent.`,
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
            "One short plain sentence, starting with a verb, that states the goal in as few words as stay clear (e.g. 'Find duplicate invoice numbers this month'). Aim for under ten words; use more only when needed. List rows cut it to one line. The plugin already shows the agent and session, so don't repeat them, and put ticket, incident or PR ids in the session label instead. Add a reason only if the reviewer needs it. For a write or destructive query, state what changes, its scope and any irreversible effect. Don't restate the SQL, use table/column jargon or write 'Topic: detail'. Keep raw PII, secrets and record values out, and don't invent context such as row counts or approvals.",
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
      description: `Read a submitted query by request_id. With wait_ms it waits up to that many milliseconds (${MAX_WAIT_MS} at most) and returns the instant the human decides; if the wait runs out first it returns the query still in its non-terminal state (pending, leased, executing), which is a timed checkpoint and not an answer, so call again to keep waiting, as many times as it takes. Only approved, rejected, failed, expired and cancelled are terminal. IMPORTANT: never end your turn while a query you submitted is non-terminal. Approved rows are stripped about ${RESULT_TTL_MS / 60_000} minutes after the decision (purged: true), so read them promptly rather than after a long detour. An approved write returns no rows. Read affectedRows for how many it changed, and treat the field's absence as unknown rather than as zero. A failed query says why in terminal.error, usually in the engine's words. Correct a wrong name or syntax before proposing again, and after execution_unknown check whether a write ran before any retry. To check many proposals in one call, use poll_results.`,
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
      description: `Return the current state of every query this session proposed recently (pending, leased, executing, approved, rejected, failed, expired, cancelled) plus a pending count, in one call. States only, not rows; read a resolved one's rows with get_query_result. The typical loop is submit_query (non-blocking), other work, then poll_results to see which resolved. With wait_ms it waits up to that many milliseconds (${MAX_WAIT_MS} at most) and returns the instant any still-open query resolves; if the wait runs out first it simply returns the states again with pending above 0, which is a timed checkpoint and not an answer, so call again to keep waiting. IMPORTANT: never end your turn while any query is still pending, leased or executing.`,
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
      description:
        "Withdraw a pending or leased query you submitted. A query that is already executing cannot be withdrawn; only the human can ask to stop it, and if it then fails, its error starts with 'Stop requested'.",
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
        "Return the structure of the database the plugin is connected to (schemas, tables, columns with types, primary and foreign keys) and its dialect (databaseType), so you can write correct, valid SQL before proposing a query. Needs no approval. With no argument it returns every table when they fit in one response (mode: detail); on a larger database it returns an index of table names and column counts instead (mode: index), and you call again with tables, optionally schema, for the columns you need. complete: false (or null, unknown), or a table marked incomplete, means part of the tables or columns could not be read or was cut, so a missing name there is not proof it does not exist; keys are best effort, so a missing key is not proof either. The structure is as of collectedAt (when the server received it). A table created since, by a migration run outside Beekeeper or a statement just approved, can be missing until the plugin collects again, so after a schema change confirm with an introspection query. Never returns any row data, default values, view/function bodies, or comments. Engine catalogs (information_schema, pg_*, mysql, performance_schema, sys) are left out because they dwarf the database's own tables, the ones skipped are listed in excludedSchemas, and you can still read any of them by proposing a normal query against it. Available only when the human has turned on Schema access for this connection; otherwise it reports unavailable. Read it once and reuse it.",
      inputSchema: {
        schema: z
          .string()
          .max(512)
          .optional()
          .describe("Only tables in this schema, spelled exactly as get_schema reports it."),
        tables: z
          .array(z.string().max(512))
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Only these tables, exact unqualified names as get_schema reports them (users, not public.users; pass the schema separately), in any schema unless schema is set. Use it after an index response to read their columns.",
          ),
      },
    },
    async ({ schema, tables }) => {
      const unpaired = await pairing.check();
      if (unpaired) {
        return unpaired;
      }
      store.upsertSession({ sessionId, ...identity() });
      const payload = schemaPayload(store.getSchema(), store.getConnection(), Date.now(), {
        schema,
        tables,
      });
      // Unindented on purpose: the structure is the largest payload an agent reads here.
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    },
  );

  server.registerTool(
    "run_query",
    {
      title: "Run a query and wait for the human decision",
      description: `A convenience wrapper for a quick one-off that submits one query and waits up to ${MAX_WAIT_MS / 1000} seconds for the human's decision. IMPORTANT: if the human has not decided within that bound, this returns the query still in a non-terminal state (pending, leased, executing). That is neither the result nor a refusal, so keep waiting with get_query_result(request_id, wait_ms) or poll_results(wait_ms) until a terminal state (approved, rejected, failed, expired, cancelled), and never end your turn before that. Reads are always allowed; a write/destructive statement runs only if a human has armed the matching mode (Write or Destructive), else it is rejected. It requires a session label, so call set_session_label first or it is rejected. It serializes one query at a time; prefer submit_query + poll_results/get_query_result for anything but a single quick query, and for concurrency. Write SQL a reviewer can read at a glance (standard SQL, basic functions, named CTEs for multi-step queries, aliases that say what each value is, with no personal-data words when it holds none). Keep JSON operators, FILTER, LATERAL and other constructs not every engine supports for when no plain equivalent can do it or the construct is clearly more efficient, and say why in the intent.`,
      inputSchema: {
        sql: z.string().max(100_000),
        intent: z
          .string()
          .max(2000)
          .optional()
          .describe(
            "One short plain sentence, starting with a verb, that states the goal in as few words as stay clear (e.g. 'Find duplicate invoice numbers this month'). Aim for under ten words; use more only when needed. List rows cut it to one line. The plugin already shows the agent and session, so don't repeat them, and put ticket, incident or PR ids in the session label instead. Add a reason only if the reviewer needs it. For a write or destructive query, state what changes, its scope and any irreversible effect. Don't restate the SQL, use table/column jargon or write 'Topic: detail'. Keep raw PII, secrets and record values out, and don't invent context such as row counts or approvals.",
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
            "The whole session or task you're on (put any ticket or incident id here, not in each intent), not a single query, so the human can match this agent to your session. A few words, no PII, credentials, or connection details. E.g. 'SUP-1042 login check for a locked-out customer'.",
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
