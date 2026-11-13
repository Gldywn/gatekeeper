import type { EvaluatorConfig } from "@gatekeeper/shared";
import { AUTO_KEY, AUTO_MODEL, AUTO_THRESHOLDS } from "./sql/auto";

export type Axis = keyof typeof AUTO_THRESHOLDS;
export type Cutoffs = Record<Axis, number>;
export type Provider = EvaluatorConfig["provider"];

export const AXES = Object.keys(AUTO_THRESHOLDS) as Axis[];
export const AXIS_LABELS: Record<Axis, string> = {
  personal_disclosure: "Personal data",
  organization_disclosure: "Company identity",
  secret_disclosure: "Access secrets",
  insufficient_context: "Unclear meaning",
};
export const PROVIDER_NAMES: Record<Provider, string> = {
  typesafe: "TypeSafe",
  custom: "Custom server",
};
// The hosted models each provider names; a Custom server's model is whatever it serves.
export const HOSTED_MODELS = { typesafe: [AUTO_MODEL] };
const CUSTOM_MODEL = /^[A-Za-z0-9._:@/-]{1,100}$/;

// What Settings keeps. A cutoff left empty is null, never zero: it cannot authorize anything.
export interface EvaluatorSettings {
  provider: Provider;
  model: string;
  baseUrl: string;
  builtIn: boolean;
  cutoffs: Record<Axis, number | null>;
}

export const EVALUATOR_STORAGE = "gatekeeper.evaluator";
const emptyCutoffs = (): Record<Axis, number | null> =>
  Object.fromEntries(AXES.map((id) => [id, null])) as Record<Axis, number | null>;

export function settingsFor(provider: Provider, model = defaultModel(provider)): EvaluatorSettings {
  const builtIn = provider === "typesafe" && model === AUTO_MODEL;
  return {
    provider,
    model,
    baseUrl: "",
    builtIn,
    cutoffs: builtIn ? { ...AUTO_THRESHOLDS } : emptyCutoffs(),
  };
}
function defaultModel(provider: Provider): string {
  return provider === "custom" ? "" : HOSTED_MODELS[provider][0];
}
export const DEFAULT_SETTINGS = settingsFor("typesafe");

const inUnitRange = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

// Read from storage as untrusted data: anything damaged leaves Auto mode without an evaluator,
// never quietly back on TypeSafe.
export function parseSettings(raw: unknown): EvaluatorSettings | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const provider = r.provider;
  if (provider !== "typesafe" && provider !== "custom") return undefined;
  const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  if (!text(r.model, 100) || !text(r.baseUrl, 2048)) return undefined;
  // A hosted provider only serves the models it names.
  if (provider !== "custom" && !(HOSTED_MODELS[provider] as string[]).includes(r.model as string))
    return undefined;
  if (typeof r.builtIn !== "boolean") return undefined;
  const c = r.cutoffs as Record<string, unknown> | null;
  if (
    c === null ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    Object.keys(c).length !== AXES.length
  )
    return undefined;
  if (!AXES.every((id) => c[id] === null || inUnitRange(c[id]))) return undefined;
  const settings: EvaluatorSettings = {
    provider,
    model: r.model as string,
    baseUrl: r.baseUrl as string,
    builtIn: r.builtIn,
    cutoffs: Object.fromEntries(AXES.map((id) => [id, c[id]])) as Record<Axis, number | null>,
  };
  // Built-in cutoffs exist only for jev-1.13.0, and only as shipped.
  if (settings.builtIn && !builtInFits(settings)) return undefined;
  return settings;
}

function builtInFits(s: EvaluatorSettings): boolean {
  return (
    s.provider === "typesafe" &&
    s.model === AUTO_MODEL &&
    AXES.every((id) => s.cutoffs[id] === AUTO_THRESHOLDS[id])
  );
}

export const builtInAvailable = (s: Pick<EvaluatorSettings, "provider" | "model">) =>
  s.provider === "typesafe" && s.model === AUTO_MODEL;

// Plain http only to a loopback literal: anywhere else, anyone on the path could read the input
// or answer in the server's place. A typed localhost becomes the literal the broker accepts.
export function canonicalBaseUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  if (url.username || url.password || url.search || url.hash) return undefined;
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// The evaluator as the broker receives it, or undefined while something is missing or invalid.
export function evaluatorConfig(s: EvaluatorSettings): EvaluatorConfig | undefined {
  if (s.provider === "typesafe")
    return s.model === AUTO_MODEL ? { provider: "typesafe", model: AUTO_MODEL } : undefined;
  const baseUrl = canonicalBaseUrl(s.baseUrl);
  return baseUrl && baseUrl === s.baseUrl && CUSTOM_MODEL.test(s.model)
    ? { provider: "custom", model: s.model, baseUrl }
    : undefined;
}

export function completeCutoffs(s: EvaluatorSettings): Cutoffs | undefined {
  return AXES.every((id) => inUnitRange(s.cutoffs[id])) ? (s.cutoffs as Cutoffs) : undefined;
}

// The field the evaluator page should open on when Auto mode cannot start yet.
export function firstMissing(s: EvaluatorSettings): string | undefined {
  if (s.provider === "custom" && canonicalBaseUrl(s.baseUrl) !== s.baseUrl) return "baseUrl";
  if (s.provider === "custom" && !CUSTOM_MODEL.test(s.model)) return "model";
  return AXES.find((id) => !inUnitRange(s.cutoffs[id]));
}

// Each key lives with the destination it was given for and never moves to another one.
export function keySlot(s: EvaluatorSettings): string | undefined {
  if (s.provider === "typesafe") return AUTO_KEY;
  const config = evaluatorConfig(s);
  return config?.provider === "custom"
    ? `gatekeeper.evaluator-key.custom.${config.baseUrl}`
    : undefined;
}

export const keyRequired = (s: EvaluatorSettings) => s.provider === "typesafe";

// Who receives the SQL structure: the one name the copy keeps, since enabling consents to it.
export function recipient(s: EvaluatorSettings | undefined): string {
  if (!s) return "The evaluator";
  if (s.provider !== "custom") return PROVIDER_NAMES[s.provider];
  const base = canonicalBaseUrl(s.baseUrl);
  return base ? `Custom server at ${new URL(base).host}` : "The Custom server";
}

// What Auto mode was switched on with: frozen, so a later edit can never lend its decision
// to an evaluation made under the old one.
export interface ActiveEvaluator {
  readonly config: EvaluatorConfig;
  readonly cutoffs: Cutoffs;
  readonly builtIn: boolean;
  readonly endpoint?: string;
}

export function activeEvaluator(s: EvaluatorSettings): ActiveEvaluator | undefined {
  const config = evaluatorConfig(s);
  const cutoffs = completeCutoffs(s);
  if (!config || !cutoffs || (s.builtIn && !builtInFits(s))) return undefined;
  return Object.freeze({
    config: Object.freeze({ ...config }),
    cutoffs: Object.freeze({ ...cutoffs }),
    builtIn: s.builtIn,
    ...(config.provider === "custom" ? { endpoint: new URL(config.baseUrl).origin } : {}),
  });
}

// The bench flags that name this evaluator; nothing secret goes in them.
// A URL path or a model name can hold anything a shell would act on: every value is one quoted
// POSIX word, so a copied command runs the bench and nothing else.
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9._:/@-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function benchFlags(config: EvaluatorConfig): string {
  const flags = ["--provider", config.provider, "--model", config.model];
  if (config.provider === "custom") flags.push("--base-url", config.baseUrl);
  return flags.map(shellQuote).join(" ");
}

// What the user's agent needs to measure cutoffs: the bench, never a key, never their settings.
// Undefined while the evaluator is incomplete, rather than a command that would mislead.
export function agentPrompt(s: EvaluatorSettings): string | undefined {
  const config = evaluatorConfig(s);
  if (!config) return undefined;
  const where =
    config.provider === "custom"
      ? `a Custom server at ${config.baseUrl}, model ${config.model}`
      : `TypeSafe, model ${config.model}`;
  const flags = benchFlags(config);
  return [
    "Measure the four Gatekeeper Auto mode cutoffs for my evaluator.",
    "",
    `Evaluator: ${where}.`,
    "Questions: Gatekeeper's fixed Auto mode questions (auto-v10).",
    "",
    "1. Work in a clone of github.com/gldywn/gatekeeper at the release that matches my plugin.",
    "   Ask me before installing anything or calling a new domain.",
    "2. I set the evaluator's key in GATEKEEPER_EVALUATOR_KEY myself (unset for a keyless",
    "   Custom server). Never ask me to paste it, and never read it from Beekeeper, a .env",
    "   file or the Gatekeeper broker.",
    "3. Run the development split, then let the bench propose the cutoffs:",
    `   TZ=UTC pnpm eval:auto --live ${flags} --split development --out .orch/auto-evals/dev.json`,
    "   TZ=UTC pnpm eval:auto --propose .orch/auto-evals/dev.json --out .orch/auto-evals/cutoffs.json",
    "4. Check that proposal once on the validation split, without changing it:",
    `   TZ=UTC pnpm eval:auto --live ${flags} --split validation --out .orch/auto-evals/validation.json`,
    "   pnpm eval:auto --replay .orch/auto-evals/validation.json --thresholds .orch/auto-evals/cutoffs.json",
    "5. Report the four values, how many safe reads they let through, how many risky reads",
    "   they hold, and the validation result. Do not change my Gatekeeper settings: I enter",
    "   the values myself.",
  ].join("\n");
}
