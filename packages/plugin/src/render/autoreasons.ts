import type { AutoEvaluation } from "@gatekeeper/shared";
import { escapeHtml } from "../html";

// Auto mode stores the diagnostic it owns (a fixed family, any source name stripped by the
// server); what a human reads is written here, at display time, so old records read the same.

const FAMILY_SENTENCES: Record<string, string> = {
  "Auto mode beta supports PostgreSQL only":
    "PostgreSQL is required for automatic evaluation in this beta.",
  "Query exceeds the automatic evaluation budget":
    "A query of at most 12,000 characters is required for automatic evaluation.",
  "A parsed single read is required": "A single, parsed read is required for automatic evaluation.",
  "Only SELECT is automatically supported":
    "A single, parsed read is required for automatic evaluation.",
  "Unresolved SQL dependencies":
    "The query's dependencies could not be resolved for automatic evaluation.",
  "String escape semantics require manual review":
    "String escape semantics could not be confirmed for automatic evaluation.",
  "Unresolved source column": "A source column could not be resolved for automatic evaluation.",
  "Unresolved relation or join":
    "A relation or join could not be resolved for automatic evaluation.",
  "Explicit source columns are required":
    "The selected columns could not be resolved for automatic evaluation.",
  "Unsupported output alias": "An output alias is not supported for automatic evaluation.",
  "Mixed set operation precedence needs manual review":
    "Mixed set operation precedence is not supported for automatic evaluation.",
  "An explicit simple schema and table are required":
    "An explicit schema and a base table are required for automatic evaluation.",
  "Sensitive or system schema": "This schema is outside automatic evaluation.",
  "Unsupported LIMIT": "This LIMIT clause is not supported for automatic evaluation.",
  "Unresolved JSON path": "A JSON path could not be resolved for automatic evaluation.",
  "Named windows need manual review":
    "This window specification is not supported for automatic evaluation.",
  "Unresolved cast": "A cast could not be resolved for automatic evaluation.",
  "System information needs manual review": "System information is outside automatic evaluation.",
  "System data needs manual review": "System information is outside automatic evaluation.",
  "Custom function needs manual review": "A custom function is outside automatic evaluation.",
  "Unsupported SQL representation":
    "The SQL representation could not be analyzed for automatic evaluation.",
  "Views, foreign tables, RLS and inherited relations need manual review":
    "Views, foreign tables, RLS and inherited relations are outside automatic evaluation.",
  "Whole JSON or opaque output needs manual review":
    "Whole JSON or opaque output is outside automatic evaluation.",
  "Unresolved output type": "An output type could not be resolved for automatic evaluation.",
  "Unresolved or unsupported source": "A source could not be cleared for automatic evaluation.",
  "Metadata unavailable":
    "Required metadata could not be obtained or resolved for automatic evaluation.",
  "Metadata unavailable or relation unresolved":
    "Required metadata could not be obtained or resolved for automatic evaluation.",
  "Unresolved ordering or grouping type":
    "An ordering or grouping type could not be resolved for automatic evaluation.",
  "Custom operator class needs manual review":
    "A custom operator class is outside automatic evaluation.",
  "Custom cast needs manual review": "A custom cast is outside automatic evaluation.",
  "Function effects need manual review":
    "Function effects could not be cleared for automatic evaluation.",
  "PostgreSQL catalog must come first in the search path":
    "A search path with the PostgreSQL catalog first is required for automatic evaluation.",
  "Unresolved function or operator":
    "A function or operator could not be resolved for automatic evaluation.",
  "Custom function or operator needs manual review":
    "A custom function or operator is outside automatic evaluation.",
  "Custom operator needs manual review": "A custom operator is outside automatic evaluation.",
  "Cast target needs manual review": "A cast type could not be cleared for automatic evaluation.",
  "Cast source needs manual review": "A cast type could not be cleared for automatic evaluation.",
  "Evaluation timed out. Approve manually": "The evaluation timed out.",
  "Invalid evaluator response or stale policy/model":
    "The evaluation response did not meet the current validation requirements.",
  "Evaluator uncertainty or stale policy/model":
    "The evaluation did not meet the current automatic approval requirements.",
  "Evaluator or metadata unavailable. Approve manually":
    "Automatic evaluation could not be completed.",
  "Evaluation cancelled or authority changed":
    "The evaluation was cancelled or its approval authority changed.",
  "Connection or approval authority changed":
    "The connection check failed or approval authority changed before execution.",
  "Execution stopped before SQL ran. Approval authority changed":
    "Execution was stopped before the SQL ran because the connection, approval authority or approval requirements could not be confirmed.",
  "Schema changed. Enable Auto mode again after review": "The schema changed during evaluation.",
  "Tab ownership changed": "Tab ownership changed during evaluation.",
  "Connection changed": "The connection changed during evaluation.",
  "Pairing changed": "Pairing changed during evaluation.",
  "Auto mode disabled": "Auto mode was disabled during evaluation.",
  "Auto mode disabled while evaluating": "Auto mode was disabled during evaluation.",
  "Pairing lost": "Pairing was lost during evaluation.",
  // The server's stand-in for a diagnostic it does not persist.
  "Automatic review required": "This read was held for review.",
  // Families from earlier plugin versions that stored records still carry.
  "Custom operators, functions or casts need manual review":
    "Custom operators, functions or casts are outside automatic evaluation.",
  "Unsupported automatic SQL clause": "This SQL clause is not supported for automatic evaluation.",
  "Use one explicit ordinary table for Auto mode":
    "One explicit ordinary table is required for automatic evaluation.",
  "Unsupported projection": "This projection is not supported for automatic evaluation.",
  "Expressions, functions and JSON access need manual review":
    "Expressions, functions and JSON access are outside automatic evaluation.",
  "Automatic LIMIT must be between 1 and 1000":
    "A LIMIT between 1 and 1000 was required for automatic evaluation.",
};

// The local screening the legend can already explain: its sentence names who held the read,
// or the object when the legend does not show it.
const SENSITIVE_SOURCE = "Sensitive source or alias";
const SENSITIVE_INPUT = "Sensitive input stays on this machine";
const LOCAL_HOLD = "A local check flagged this read before evaluation.";
// No authored sentence: say only what is certain, and show the stored text beside it.
const UNKNOWN_HOLD = "This read was held for review.";
const UNKNOWN_REFUSAL = "The evaluation did not clear this read.";

const EVALUATOR_FLAGS: Record<string, string> = {
  "Potential personal disclosure": "potential personal disclosure",
  "Potential organization disclosure": "potential organization disclosure",
  "Potential access secret disclosure": "potential access secret disclosure",
};
const INSUFFICIENT_CONTEXT = "Insufficient evaluation context";

// Own keys only: a reason such as "toString" must stay unknown, not reach the prototype.
const own = (map: Record<string, string>, key: string) =>
  Object.hasOwn(map, key) ? map[key] : undefined;

export interface ReasonContext {
  // Whether the detail already shows this sensitive name (a PII or client mark).
  shown?: (name: string) => boolean;
  // Whether the detail already shows the query's sensitive values.
  valuesShown?: boolean;
}

// A sentence as HTML, and the stored diagnostic, escaped, when no authored sentence covers it.
export interface ReasonText {
  sentence: string;
  recorded: string | null;
}

/** The authored sentence, as HTML, for a stored hold diagnostic; "" when there is none. */
export function holdSentence(raw: string, ctx: ReasonContext = {}): string {
  const reason = raw.replace(/^Needs review:\s*/, "").trim();
  const sep = reason.indexOf(":");
  const family = sep === -1 ? reason : reason.slice(0, sep).trim();
  const name = sep === -1 ? "" : reason.slice(sep + 1).trim();
  if (family === SENSITIVE_SOURCE) {
    return name && !ctx.shown?.(name)
      ? `A local check flagged <code class="name">${escapeHtml(name)}</code> before evaluation.`
      : LOCAL_HOLD;
  }
  if (family === SENSITIVE_INPUT) {
    return ctx.valuesShown
      ? LOCAL_HOLD
      : "A local check flagged a sensitive input before evaluation.";
  }
  return own(FAMILY_SENTENCES, family) ?? own(FAMILY_SENTENCES, reason) ?? "";
}

/** What the evaluator flagged, from its fixed labels; any other label stays on the record. */
export function evaluationText(reasons: string[]): ReasonText {
  const flags = reasons.map((r) => own(EVALUATOR_FLAGS, r)).filter((f): f is string => !!f);
  const context = reasons.includes(INSUFFICIENT_CONTEXT);
  const unknown = reasons.filter((r) => !own(EVALUATOR_FLAGS, r) && r !== INSUFFICIENT_CONTEXT);
  if (unknown.length || (!flags.length && !context)) {
    return {
      sentence: UNKNOWN_REFUSAL,
      recorded: reasons.length ? escapeHtml(reasons.join(". ")) : null,
    };
  }
  const parts: string[] = [];
  if (flags.length) parts.push(`The evaluation flagged ${flags.join(" and ")}.`);
  if (context) parts.push("The evaluation had insufficient context.");
  return { sentence: parts.join(" "), recorded: null };
}

/** The reason the app records when an evaluation refuses a read (app.ts evaluateNext). */
export function refusalReason(evaluation: AutoEvaluation): string {
  return evaluation.reasons?.join(". ") || "Evaluator uncertainty or stale policy/model";
}

// The evaluator's labels only when this hold is its refusal: a favourable evaluation followed
// by an authority hold must read as the hold. Callers add "Nothing was sent" themselves.
export function reviewText(
  raw: string,
  evaluation: AutoEvaluation | undefined,
  ctx: ReasonContext = {},
): ReasonText {
  const reason = raw.replace(/^Needs review:\s*/, "").trim();
  if (evaluation && reason === refusalReason(evaluation) && evaluation.reasons?.length) {
    return evaluationText(evaluation.reasons);
  }
  const sentence = holdSentence(reason, ctx);
  return sentence
    ? { sentence, recorded: null }
    : { sentence: UNKNOWN_HOLD, recorded: reason ? escapeHtml(reason) : null };
}

/** One HTML line: the sentence, what follows it, then the stored text it could not word. */
export function reasonHtml(text: ReasonText, tail = ""): string {
  const recorded = text.recorded
    ? ` <span class="auto-recorded">Recorded reason: ${text.recorded}</span>`
    : "";
  return `${text.sentence}${tail}${recorded}`;
}
