import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_PENDING_PER_SESSION, MAX_WAIT_MS, RESULT_TTL_MS } from "./config.js";
import { createMcpServer, SERVER_INSTRUCTIONS } from "./mcp.js";
import { RequestStore } from "./store.js";

// Codex only guarantees the first 512 characters of the MCP instructions field, so the
// whole waiting contract has to land inside that window.
const CODEX_INSTRUCTIONS_WINDOW = 512;
// The rule an agent must see even in a harness that truncates a long description.
const TURN_RULE_BUDGET = 400;

const SKILL = readFileSync(
  fileURLToPath(new URL("../../../skills/gatekeeper/SKILL.md", import.meta.url)),
  "utf8",
);

type ToolInfo = { name: string; description?: string; inputSchema: Record<string, unknown> };

let client: Client;
let tools: ToolInfo[];
let instructions: string | undefined;

const tool = (name: string): ToolInfo => {
  const found = tools.find((t) => t.name === name);
  if (!found) {
    throw new Error(`tool ${name} is not registered`);
  }
  return found;
};

const describeOf = (name: string): string => tool(name).description ?? "";

const waitMsDescription = (name: string): string => {
  const props = (
    tool(name).inputSchema as { properties?: Record<string, { description?: string }> }
  ).properties;
  return props?.wait_ms?.description ?? "";
};

beforeAll(async () => {
  const { server } = createMcpServer(new RequestStore());
  client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  instructions = client.getInstructions();
  tools = (await client.listTools()).tools as ToolInfo[];
});

describe("server instructions", () => {
  it("reaches the client", () => {
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it("states the whole waiting contract within Codex's guaranteed window", () => {
    const window = SERVER_INSTRUCTIONS.slice(0, CODEX_INSTRUCTIONS_WINDOW);
    expect(window).toContain("set_session_label first");
    expect(window).toContain(`${MAX_WAIT_MS} ms at most`);
    expect(window).toContain("returns your queries still pending");
    expect(window).toContain("Never end your turn");
    expect(window).toContain("approved, rejected, failed, expired or cancelled");
  });

  it("warns that run_query can return still-pending too", () => {
    expect(SERVER_INSTRUCTIONS).toContain("run_query can return still-pending");
  });
});

describe("tool descriptions", () => {
  it("tells the agent a bounded wait is a checkpoint, not an answer", () => {
    for (const name of ["get_query_result", "poll_results"]) {
      const description = describeOf(name);
      expect(description, name).toContain(`${MAX_WAIT_MS} at most`);
      expect(description, name).toContain("call again to keep waiting");
      expect(description, name).toContain("never end your turn");
    }
  });

  it("carries the same contract on the wait_ms parameter itself", () => {
    for (const name of ["get_query_result", "poll_results"]) {
      const description = waitMsDescription(name);
      expect(description, name).toContain(`${MAX_WAIT_MS} at most`);
      expect(description, name).toContain("rejected, not clamped");
      expect(description, name).toContain("call again to keep waiting");
    }
  });

  it("warns that run_query can return a still-pending proposal", () => {
    const description = describeOf("run_query");
    expect(description).toContain(`waits up to ${MAX_WAIT_MS / 1000} seconds`);
    expect(description).toContain("non-terminal state");
    expect(description).toContain("neither the result nor a refusal");
    // run_query submits internally, so it hits the same session-label gate.
    expect(description).toContain("call set_session_label first");
  });

  it("puts the never-end-your-turn rule early in submit_query", () => {
    const description = describeOf("submit_query");
    expect(description).toContain("never end your turn");
    expect(description.indexOf("never end your turn")).toBeLessThan(TURN_RULE_BUDGET);
  });

  it("states the backpressure and freshness limits an agent cannot guess", () => {
    expect(describeOf("submit_query")).toContain(`${MAX_PENDING_PER_SESSION} in flight`);
    expect(describeOf("get_query_result")).toContain(
      `stripped about ${RESULT_TTL_MS / 60_000} minutes`,
    );
  });

  it("points at the dead-channel exit from the wait loop", () => {
    expect(describeOf("get_connection_info")).toContain("connected: false");
    expect(describeOf("get_connection_info")).toContain("no approval can arrive");
  });
});

describe("the wait bound the descriptions promise", () => {
  it("rejects a wait_ms above the cap instead of clamping it", async () => {
    const res = (await client.callTool({
      name: "get_query_result",
      arguments: { request_id: "req_nonexistent", wait_ms: MAX_WAIT_MS + 1 },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Input validation error");
    expect(res.content[0].text).toContain("wait_ms");
    expect(res.content[0].text).toContain(String(MAX_WAIT_MS));
  });

  it("accepts a wait_ms at the cap", async () => {
    // This session proposed nothing, so the wait has no open query to sit on and
    // returns at once; it exercises schema acceptance, not the wait itself.
    const res = (await client.callTool({
      name: "poll_results",
      arguments: { wait_ms: MAX_WAIT_MS },
    })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
  });
});

describe("the skill", () => {
  it("documents every registered tool", () => {
    for (const t of tools) {
      expect(SKILL, t.name).toContain(`\`${t.name}(`);
    }
  });

  it("states the wait bound the server actually enforces", () => {
    expect(SKILL).toContain(`${MAX_WAIT_MS} is the maximum the server accepts`);
  });
});
