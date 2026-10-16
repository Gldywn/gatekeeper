import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../types";
import { agentLinkAge, agentLinkLabel, agentLinkStatusHtml } from "./agentlink";

const T = 1_800_000_000_000;

describe("agent link", () => {
  it.each<[ConnectionState, string, string]>([
    ["connecting", "Connecting to the Gatekeeper server", "failed"],
    ["reconnecting", "Reconnecting to the Gatekeeper server", "failed"],
    ["connected", "Connected to the Gatekeeper server", "passed"],
    ["error", "Gatekeeper server unreachable", "failing"],
  ])("names %s and tones its dot like the database check", (state, label, tone) => {
    expect(agentLinkLabel(state)).toBe(label);
    expect(agentLinkStatusHtml(state)).toContain(`class="db-status ${tone}"`);
  });

  it("leaves an age slot only where an age means something", () => {
    expect(agentLinkStatusHtml("connected")).toContain('Last answer<span class="db-age">');
    expect(agentLinkStatusHtml("error")).toContain('No answer<span class="db-age">');
    expect(agentLinkStatusHtml("reconnecting")).not.toContain("db-age");
    expect(agentLinkStatusHtml("connecting")).not.toContain("db-age");
  });

  it("dates the last answer, and never invents one", () => {
    expect(agentLinkAge("connected", T - 3_000, T)).toBe("3s ago");
    expect(agentLinkAge("error", T - 14_000, T)).toBe("for 14s");
    expect(agentLinkAge("error", T - 180_000, T)).toBe("for 3m");
    expect(agentLinkAge("error", 0, T)).toBe("");
  });
});
