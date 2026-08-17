import { randomBytes } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  BROKER_HOST,
  brokerPort,
  MAX_WAIT_MS,
  PAIRING_CODE_TTL_MS,
  PAIRING_IDLE_MS,
  POLL_MS,
} from "./config.js";
import type { RequestStore } from "./store.js";

// A type alias, not an interface: the SDK's tool-result parameter carries an index
// signature that only an alias satisfies structurally.
export type ToolFailure = {
  content: { type: "text"; text: string }[];
  isError: true;
};

export function pairingUrl(): string {
  return `http://${BROKER_HOST}:${brokerPort()}/pair`;
}

// Harnesses funnel MCP stderr into log files nobody reads, so a tool result is the only
// channel that reaches the human everywhere. Handed a mere description of the state, an
// agent debugs it and retries in a loop, so this orders rather than informs.
export function pairingMessage(code: string | null): string {
  const enter = "type it into the Gatekeeper tab in Beekeeper Studio (Tools menu)";
  const hold =
    "Nothing runs until they do. This is the normal unpaired state, not a fault in your call or in any code: do not investigate it, and do not call this tool again until the human confirms they have entered the code.";
  return code
    ? `PAIRING REQUIRED. Stop and ask the human, in your reply, to ${enter}: ${code}. ${hold} The code lasts about five minutes; ${pairingUrl()} shows the current one.`
    : `PAIRING REQUIRED. Stop and ask the human, in your reply, to open ${pairingUrl()}, read the 6-digit code shown there, and ${enter}. ${hold}`;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function pairedWithin(store: RequestStore, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    await delay(POLL_MS);
    if (store.pairedAt() !== null) {
      return true;
    }
  }
  return false;
}

// Every tool is gated on this: an agent that cannot reach a human's approval queue has
// nothing useful to do, and failing on the first call is what surfaces the code.
export function createPairingGuard(store: RequestStore, server: Server) {
  // URL mode is the spec's answer for a secret that must not pass through the client, but
  // support is uneven, so a client that refuses it is dropped for the rest of the process
  // and the tool result carries the code on its own.
  let urlMode = true;
  let asking = false;
  // At most one prompt per code: an agent retrying a failed tool would otherwise pop a
  // fresh one, and hold its call open, on every attempt.
  let askedFor: string | null = null;

  async function elicit(): Promise<void> {
    const controller = new AbortController();
    // The code is deliberately not in the URL or the message: the point of URL mode is
    // that it never transits the client.
    const answered = server
      .elicitInput(
        {
          mode: "url",
          message:
            "Gatekeeper needs pairing before it can propose queries. Open this page to read the pairing code, then type it into the Gatekeeper tab in Beekeeper Studio.",
          elicitationId: `pair_${randomBytes(8).toString("hex")}`,
          url: pairingUrl(),
        },
        { signal: controller.signal, timeout: MAX_WAIT_MS },
      )
      .then(
        () => undefined,
        () => {
          // An abort is ours (pairing landed); anything else is a client that cannot do
          // URL mode, so stop asking it.
          if (!controller.signal.aborted) {
            urlMode = false;
          }
        },
      );
    try {
      // The elicitation's own answer is not the truth; the pairing landing is. Racing both
      // means a declined prompt does not hold the tool call open either.
      await Promise.race([pairedWithin(store, Date.now() + MAX_WAIT_MS), answered]);
    } finally {
      controller.abort();
    }
  }

  return {
    async check(): Promise<ToolFailure | null> {
      if (store.pairedAt() !== null) {
        return null;
      }
      const issued = store.issuePairingCode(PAIRING_CODE_TTL_MS, PAIRING_IDLE_MS);
      const unasked = issued !== null && issued.code !== askedFor;
      if (urlMode && unasked && !asking && server.getClientCapabilities()?.elicitation) {
        asking = true;
        askedFor = issued.code;
        try {
          await elicit();
        } catch {
          urlMode = false;
        } finally {
          asking = false;
        }
        if (store.pairedAt() !== null) {
          return null;
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: {
                  code: "NOT_PAIRED",
                  message: pairingMessage(issued?.code ?? null),
                  pairing_code: issued?.code,
                  pairing_url: pairingUrl(),
                },
              },
              null,
              2,
            ),
          },
        ],
        isError: true as const,
      };
    },
  };
}
