import { appStorage } from "@beekeeperstudio/plugin";
import type {
  ActivityPage,
  ApprovalAttribution,
  AutoEvaluation,
  ConnectionInput,
  EvaluationFailure,
  EvaluationInput,
  EvaluatorConfig,
  EvaluatorStatus,
  RequestState,
  SensitivityRecord,
} from "@gatekeeper/shared";
import type { ActiveEvaluator } from "../evaluator";
import { AUTO_POLICY } from "../sql/auto";
import type { ActivityEntry, Proposal, SessionRoster } from "../types";

const STAGES = new Set([
  "timeout",
  "network",
  "http",
  "response",
  "input",
  "cancelled",
  "internal",
]);

// The broker's own diagnostic of a failed evaluation; anything else is no diagnosis. Its status
// is the provider's, never the 503 that carried it.
export function evaluationFailure(body: unknown): EvaluationFailure | undefined {
  const d = (body as { diagnostic?: unknown } | null)?.diagnostic as
    | { stage?: unknown; status?: unknown }
    | undefined;
  if (typeof d !== "object" || d === null || !STAGES.has(d.stage as string)) return undefined;
  const stage = d.stage as EvaluationFailure["stage"];
  const status = d.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? { stage, status }
    : { stage };
}

export class EvaluatorFailure extends Error {
  readonly failure: EvaluationFailure;
  constructor(failure: EvaluationFailure) {
    super("Evaluator unavailable");
    this.failure = failure;
  }
}

export interface BrokerConfig {
  baseUrl: string;
  tokenKey: string;
}

// The non-sensitive connection context the plugin POSTs to /connection (the server stamps
// capturedAt on its side). Never host/user/credentials.
export type ConnectionSnapshot = ConnectionInput;

// A refused renewal carries the request's settled state when the broker reports one, so
// the caller can tell a proposal that died from one merely re-offered. Absent (an older
// broker, a 401, a truncated body) means undefined, and the caller stays conservative.
export type RenewResult =
  | { ok: false; state?: RequestState }
  | { ok: true; leaseExpiresAt: number };

// Owns the broker transport (base URL, bearer token, wire request shape). The
// caller keeps the policy: when to re-pair on a 401, and the approval sequencing.
export class BrokerClient {
  private token: string | null = null;
  private readonly baseUrl: string;
  private readonly tokenKey: string;

  constructor(config: BrokerConfig) {
    this.baseUrl = config.baseUrl;
    this.tokenKey = config.tokenKey;
  }

  // The broker token is a capability secret, so it lives in Beekeeper's encrypted
  // store (appStorage's `encrypted` option maps to setEncryptedData/getEncryptedData).
  async loadToken(): Promise<string | null> {
    const encrypted = await appStorage.getItem<string>(this.tokenKey, { encrypted: true });
    if (encrypted) {
      this.token = encrypted;
      return encrypted;
    }
    // Migrate a token an earlier build wrote in the clear, then wipe the plaintext.
    const legacy = await appStorage.getItem<string>(this.tokenKey);
    if (legacy) {
      await appStorage.setItem(this.tokenKey, legacy, { encrypted: true });
      await appStorage.setItem(this.tokenKey, "");
      this.token = legacy;
      return legacy;
    }
    this.token = null;
    return null;
  }

  async setToken(value: string): Promise<void> {
    await appStorage.setItem(this.tokenKey, value, { encrypted: true });
    this.token = value;
  }

  async clearToken(): Promise<void> {
    await appStorage.setItem(this.tokenKey, "", { encrypted: true });
    await appStorage.setItem(this.tokenKey, "");
    this.token = null;
  }

  // Is a broker listening at all? No Authorization header: this runs before pairing,
  // and a rejected fetch is the only way to see "nothing is listening" (a CORS-blocked
  // response is indistinguishable from a refused connection, so the route sends CORS).
  async probe(): Promise<boolean> {
    try {
      return (await fetch(`${this.baseUrl}/pair/status`)).ok;
    } catch {
      return false;
    }
  }

  // Trades the code the human read for the capability token, and stores it exactly as
  // a token was stored before. Unauthenticated by nature, so it skips request().
  async exchange(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
    } catch {
      return { ok: false, error: "The broker stopped answering. Is your agent still running?" };
    }
    const body = (await res.json().catch(() => ({}))) as {
      token?: string;
      error?: string;
      retryAfterMs?: number;
    };
    if (res.status === 200 && body.token) {
      await this.setToken(body.token);
      return { ok: true };
    }
    if (res.status === 429) {
      const seconds = Math.ceil((body.retryAfterMs ?? 60_000) / 1000);
      return { ok: false, error: `Too many attempts. Try again in ${seconds}s.` };
    }
    return { ok: false, error: body.error ?? "Pairing failed." };
  }

  // Returns the raw Response so poll() keeps the 401-vs-200 auth-failure policy. `attention`
  // names the requests left to a human, whose alert rings now. Sent even empty: its presence
  // tells the broker this plugin calls the human, so submissions wait for it instead of ringing.
  pending(connectionName?: string, attention: string[] = []): Promise<Response> {
    const query = new URLSearchParams({ attention: attention.join(",") });
    return this.request(`/pending?${query}`, { headers: this.connHeader(connectionName) });
  }

  async inflight(connectionName?: string): Promise<Proposal[] | null> {
    const res = await this.request("/inflight", { headers: this.connHeader(connectionName) });
    if (res.status !== 200) {
      return null;
    }
    return ((await res.json()) as { inflight: Proposal[] }).inflight;
  }

  async sessions(connectionName?: string): Promise<SessionRoster[] | null> {
    const res = await this.request("/sessions", { headers: this.connHeader(connectionName) });
    if (res.status !== 200) {
      return null;
    }
    return ((await res.json()) as { sessions: SessionRoster[] }).sessions;
  }

  // One page, newest first; `before` is the last entry already fetched, so the page starts
  // strictly older than it.
  async activity(
    connectionName?: string,
    before?: Pick<ActivityEntry, "decidedAt" | "id">,
    limit?: number,
  ): Promise<ActivityPage | null> {
    const params = new URLSearchParams();
    if (before) {
      params.set("before", String(before.decidedAt));
      params.set("beforeId", before.id);
    }
    if (limit !== undefined) params.set("limit", String(limit));
    const query = params.toString();
    const res = await this.request(`/activity${query ? `?${query}` : ""}`, {
      headers: this.connHeader(connectionName),
    });
    if (res.status !== 200) {
      return null;
    }
    return (await res.json()) as ActivityPage;
  }

  // The kept rows of one approved request, still sealed; null when none were kept.
  async resultArchive(id: string, connectionName?: string): Promise<string | null> {
    const res = await this.request(`/results/${encodeURIComponent(id)}`, {
      headers: this.connHeader(connectionName),
    });
    if (res.status === 404) {
      return null;
    }
    if (res.status !== 200) {
      throw new Error(`Kept rows unavailable (${res.status})`);
    }
    const { payload } = (await res.json()) as { payload?: unknown };
    if (typeof payload !== "string") {
      throw new Error("Kept rows unavailable");
    }
    return payload;
  }

  async renew(id: string, leaseId: string): Promise<RenewResult> {
    const res = await this.request("/lease/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, leaseId }),
    });
    if (!res.ok) {
      try {
        const { state } = (await res.json()) as { state?: RequestState | null };
        return { ok: false, state: state ?? undefined };
      } catch {
        return { ok: false };
      }
    }
    const { leaseExpiresAt } = (await res.json()) as { leaseExpiresAt: number };
    return { ok: true, leaseExpiresAt };
  }

  async executing(
    id: string,
    leaseId: string,
    approval?: ApprovalAttribution,
    sensitivity?: SensitivityRecord,
  ): Promise<boolean> {
    const res = await this.request("/executing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, leaseId, approval, sensitivity }),
    });
    return res.ok;
  }

  async withdrawExecution(id: string, leaseId: string): Promise<boolean> {
    return (
      await this.request("/execution/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, leaseId }),
      })
    ).ok;
  }

  async evaluate(
    id: string,
    leaseId: string,
    scope: string,
    key: string,
    input: EvaluationInput,
    signal: AbortSignal,
    active: ActiveEvaluator,
  ): Promise<AutoEvaluation> {
    const res = await this.request("/evaluate", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        leaseId,
        scope,
        // A keyless Custom server gets no key field at all.
        ...(key ? { key } : {}),
        input,
        policy: AUTO_POLICY,
        evaluator: active.config,
        cutoffs: active.cutoffs,
        builtIn: active.builtIn,
      }),
    });
    if (!res.ok) {
      const failure = evaluationFailure(await res.json().catch(() => undefined));
      throw failure
        ? new EvaluatorFailure(failure)
        : new Error("Evaluator unavailable or lease lost");
    }
    return (await res.json()) as AutoEvaluation;
  }

  // "outdated" is a broker predating the route (plugin and server update separately);
  // anything else short of a clear verdict reads as unreachable.
  async checkEvaluator(
    evaluator: EvaluatorConfig,
    key: string,
  ): Promise<EvaluatorStatus | "outdated"> {
    try {
      const res = await this.request("/evaluate/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evaluator, ...(key ? { key } : {}) }),
      });
      if (res.status === 404) return "outdated";
      const status = res.ok ? ((await res.json()) as { status?: unknown }).status : null;
      return status === "valid" || status === "invalid" || status === "model-missing"
        ? status
        : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  // Returns false when the broker did not accept the outcome (a refused lease, or a body
  // the broker dropped), so the caller never reports success on an undelivered result.
  async result(id: string, leaseId: string, body: Record<string, unknown>): Promise<boolean> {
    const res = await this.request("/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, leaseId, ...body }),
    });
    return res.ok;
  }

  async postConnection(conn: ConnectionSnapshot): Promise<void> {
    await this.request("/connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(conn),
    });
  }

  async postSchema(schema: unknown): Promise<void> {
    await this.request("/schema", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(schema),
    });
  }

  async touchSchema(): Promise<void> {
    await this.request("/schema/touch", { method: "POST" });
  }

  private request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${this.token}` },
    });
  }

  private connHeader(connectionName?: string): Record<string, string> {
    // Percent-encode: the scope key holds a control-char separator (and names can hold
    // anything), and a raw control or non-ASCII byte in a header value is rejected by Node.
    return connectionName ? { "X-Gatekeeper-Connection": encodeURIComponent(connectionName) } : {};
  }
}
