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

// What Auto mode compares an answer with: the evaluator and cutoffs it was switched on with.
export interface AutoRule {
  readonly config: { readonly provider: string; readonly model: string };
  readonly cutoffs: Readonly<Record<string, number>>;
  readonly builtIn: boolean;
  readonly endpoint?: string;
}
export const BUILT_IN_RULE: AutoRule = {
  config: { provider: "typesafe", model: AUTO_MODEL },
  cutoffs: AUTO_THRESHOLDS,
  builtIn: true,
};

export function validEvaluation(e: AutoEvaluation, rule: AutoRule = BUILT_IN_RULE): boolean {
  const recorded = e?.thresholds === undefined ? undefined : recordedCutoffs(e.thresholds);
  return (
    e !== null &&
    typeof e === "object" &&
    e.provider === rule.config.provider &&
    e.model === rule.config.model &&
    e.policy === AUTO_POLICY &&
    e.endpoint === rule.endpoint &&
    // An older broker records no cutoffs: only the built-in ones can be what it applied.
    // Recorded, they must be the very rule Auto mode was switched on with.
    (e.thresholds === undefined
      ? rule.builtIn && e.builtIn === undefined
      : recorded !== undefined &&
        e.builtIn === rule.builtIn &&
        AXES.every((id) => recorded[id] === rule.cutoffs[id])) &&
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

export function currentEvaluation(e: AutoEvaluation, rule: AutoRule = BUILT_IN_RULE): boolean {
  return (
    validEvaluation(e, rule) &&
    e.eligible &&
    e.reasons.length === 0 &&
    AXES.every((id) => e.probabilities[id] <= rule.cutoffs[id])
  );
}
