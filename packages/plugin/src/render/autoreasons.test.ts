import type { AutoEvaluation } from "@gatekeeper/shared";
import { describe, expect, it } from "vitest";
import { evaluationText, holdSentence, reasonHtml, refusalReason, reviewText } from "./autoreasons";

const evaluation = (reasons: string[]): AutoEvaluation => ({
  provider: "typesafe",
  model: "jev-1.13.0",
  policy: "auto-beta-7",
  evaluatedAt: 1,
  sqlDigest: "a".repeat(64),
  eligible: reasons.length === 0,
  reasons,
  probabilities: {},
});

describe("Auto mode reasons as sentences", () => {
  it("writes the evaluator's fixed labels as one sentence", () => {
    expect(evaluationText(["Potential personal disclosure"])).toEqual({
      sentence: "The evaluation flagged potential personal disclosure.",
      recorded: null,
    });
    expect(
      evaluationText([
        "Potential personal disclosure",
        "Potential organization disclosure",
        "Insufficient evaluation context",
      ]).sentence,
    ).toBe(
      "The evaluation flagged potential personal disclosure and potential organization disclosure. The evaluation had insufficient context.",
    );
  });

  it("keeps an unknown label on the record, inherited object keys included", () => {
    expect(evaluationText(["Something <new>"])).toEqual({
      sentence: "The evaluation did not clear this read.",
      recorded: "Something &lt;new&gt;",
    });
    expect(evaluationText(["toString"]).sentence).toBe("The evaluation did not clear this read.");
    expect(holdSentence("constructor")).toBe("");
  });

  it("reads a hold after a favourable evaluation as the hold, never as a refusal", () => {
    const cleared = evaluation([]);
    expect(
      reviewText(
        "Needs review: Execution stopped before SQL ran. Approval authority changed",
        cleared,
      ).sentence,
    ).toMatch(/^Execution was stopped before the SQL ran/);
    const refused = evaluation(["Potential personal disclosure"]);
    expect(reviewText(`Needs review: ${refusalReason(refused)}`, refused).sentence).toBe(
      "The evaluation flagged potential personal disclosure.",
    );
  });

  it("names a held source only when the detail does not already show it", () => {
    expect(holdSentence("Sensitive source or alias: ip_address")).toBe(
      'A local check flagged <code class="name">ip_address</code> before evaluation.',
    );
    expect(holdSentence("Sensitive source or alias: email", { shown: (n) => n === "email" })).toBe(
      "A local check flagged this read before evaluation.",
    );
    // The server stores the family without the name.
    expect(holdSentence("Sensitive source or alias")).toBe(
      "A local check flagged this read before evaluation.",
    );
  });

  it("words old and server-side families, and keeps any other diagnostic as recorded text", () => {
    expect(holdSentence("Evaluation timed out. Approve manually")).toBe(
      "The evaluation timed out.",
    );
    expect(holdSentence("Unsupported projection")).toBe(
      "This projection is not supported for automatic evaluation.",
    );
    expect(reviewText("Automatic review required", undefined)).toEqual({
      sentence: "This read was held for review.",
      recorded: null,
    });
    const unknown = reviewText("Needs review: A check nobody wrote a sentence for", undefined);
    expect(reasonHtml(unknown, " Waiting for your review.")).toBe(
      'This read was held for review. Waiting for your review. <span class="auto-recorded">Recorded reason: A check nobody wrote a sentence for</span>',
    );
  });
});
