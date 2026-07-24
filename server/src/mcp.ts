import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProposalQueue, ProposalResult } from "./queue.js";

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export function createMcpServer(queue: ProposalQueue): McpServer {
  const server = new McpServer({ name: "gatekeeper", version: "0.0.1" });

  server.registerTool(
    "run_query",
    {
      title: "Run a human-approved, read-only SQL query",
      description:
        "Propose a read-only SQL SELECT to run against the user's database. A human reviews the SQL in Beekeeper Studio and approves or rejects it before it runs on their connection. Returns the resulting rows on approval.",
      inputSchema: {
        sql: z.string().describe("The read-only SQL SELECT to run."),
        intent: z
          .string()
          .optional()
          .describe("A short, human-readable reason for the query."),
      },
    },
    async ({ sql, intent }) => {
      let result: ProposalResult;
      try {
        result = await queue.enqueue(sql, intent, APPROVAL_TIMEOUT_MS);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      if (result.status === "approved") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { rows: result.rows, fields: result.fields },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (result.status === "rejected") {
        return errorResult(
          `Query rejected by the human${result.reason ? `: ${result.reason}` : "."}`,
        );
      }
      return errorResult(`Query failed to execute: ${result.error}`);
    },
  );

  return server;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
