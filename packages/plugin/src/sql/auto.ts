import type { AutoEvaluation } from "@gatekeeper/shared";

export const AUTO_MODEL = "jev-1.13.0";
export const AUTO_POLICY = "auto-v10";
// No read-only axis: the local analysis decides read-only behavior before Jev is called.
export const AUTO_THRESHOLDS = {
  personal_disclosure: 0.2,
  organization_disclosure: 0.15,
  secret_disclosure: 0.15,
  insufficient_context: 0.45,
} as const;
export const AUTO_KEY = "gatekeeper.typesafe-key";

const AXES = Object.keys(AUTO_THRESHOLDS) as (keyof typeof AUTO_THRESHOLDS)[];

// Cutoffs a record carries arrive as JSON: exactly the four axes, each in [0,1], or nothing.
export function recordedCutoffs(t: unknown): Record<string, number> | undefined {
  if (t === null || typeof t !== "object" || Array.isArray(t)) return undefined;
  const r = t as Record<string, unknown>;
  const valid =
    Object.keys(r).length === AXES.length &&
    AXES.every((id) => {
      const v = r[id];
      return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
    });
  return valid ? (r as Record<string, number>) : undefined;
}

export function validEvaluation(e: AutoEvaluation): boolean {
  const recorded = e?.thresholds === undefined ? undefined : recordedCutoffs(e.thresholds);
  return (
    e !== null &&
    typeof e === "object" &&
    e.provider === "typesafe" &&
    e.model === AUTO_MODEL &&
    e.policy === AUTO_POLICY &&
    // Absent from an older broker; present, it must be the very rule this plugin enforces.
    (e.thresholds === undefined ||
      (recorded !== undefined && AXES.every((id) => recorded[id] === AUTO_THRESHOLDS[id]))) &&
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
    Object.entries(AUTO_THRESHOLDS).every(([id, cutoff]) => e.probabilities[id] <= cutoff)
  );
}
