import type { AutoEvaluation } from "@gatekeeper/shared";

export const AUTO_MODEL = "jev-1.13.0";
export const AUTO_POLICY = "auto-beta-6";
export const AUTO_THRESHOLDS = {
  read_only: 0.95,
  personal_disclosure: 0.2,
  organization_disclosure: 0.15,
  secret_disclosure: 0.15,
  insufficient_context: 0.45,
} as const;
export const AUTO_KEY = "gatekeeper.typesafe-key";

export function validEvaluation(e: AutoEvaluation): boolean {
  return (
    e !== null &&
    typeof e === "object" &&
    e.provider === "typesafe" &&
    e.model === AUTO_MODEL &&
    e.policy === AUTO_POLICY &&
    typeof e.eligible === "boolean" &&
    Array.isArray(e.reasons) &&
    e.reasons.every((reason) => typeof reason === "string") &&
    /^[a-f0-9]{64}$/.test(e.sqlDigest) &&
    e.probabilities !== null &&
    typeof e.probabilities === "object" &&
    Object.keys(e.probabilities).length === Object.keys(AUTO_THRESHOLDS).length &&
    Object.keys(AUTO_THRESHOLDS).every((id) => {
      const value = e.probabilities[id];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
    }) &&
    Date.now() - e.evaluatedAt >= 0 &&
    Date.now() - e.evaluatedAt < 30000
  );
}

export function currentEvaluation(e: AutoEvaluation): boolean {
  return (
    validEvaluation(e) &&
    e.eligible &&
    e.reasons.length === 0 &&
    Object.entries(AUTO_THRESHOLDS).every(([id, cutoff]) =>
      id === "read_only" ? e.probabilities[id] >= cutoff : e.probabilities[id] <= cutoff,
    )
  );
}
