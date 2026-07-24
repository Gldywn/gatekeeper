import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProposalQueue } from "./queue.js";
import { createBroker } from "./broker.js";
import { createMcpServer } from "./mcp.js";

const BROKER_HOST = "127.0.0.1";
const BROKER_PORT = Number(process.env.GATEKEEPER_BROKER_PORT ?? 9999);

async function main(): Promise<void> {
  const queue = new ProposalQueue();

  const broker = createBroker(queue);
  await new Promise<void>((resolve, reject) => {
    broker.once("error", reject);
    broker.listen(BROKER_PORT, BROKER_HOST, () => {
      broker.off("error", reject);
      // stdout is the MCP stdio channel, so all logs go to stderr.
      console.error(
        `[gatekeeper] broker listening on http://${BROKER_HOST}:${BROKER_PORT}`,
      );
      resolve();
    });
  });

  // Exit when the MCP client disconnects (stdin closes) so we do not linger
  // holding the broker port after the session ends.
  const shutdown = () => {
    broker.close();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const mcp = createMcpServer(queue);
  await mcp.connect(new StdioServerTransport());
  console.error("[gatekeeper] MCP server ready on stdio");
}

main().catch((err) => {
  console.error("[gatekeeper] fatal:", err);
  process.exit(1);
});
