import { appStorage } from "@beekeeperstudio/plugin";
import type { ConnectionInput } from "@gatekeeper/shared";
import type { ActivityEntry, Proposal, SessionRoster } from "../types";

export interface BrokerConfig {
  baseUrl: string;
  tokenKey: string;
}

// The non-sensitive connection context the plugin POSTs to /connection (the server stamps
// capturedAt on its side). Never host/user/credentials.
export type ConnectionSnapshot = ConnectionInput;

// A refused renewal (cancelled or lost lease) tells the caller to drop the card.
export type RenewResult = { ok: false } | { ok: true; leaseExpiresAt: number };

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

  // Returns the raw Response so poll() keeps the 401-vs-200 auth-failure policy.
  pending(connectionName?: string): Promise<Response> {
    return this.request("/pending", { headers: this.connHeader(connectionName) });
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

  async activity(connectionName?: string): Promise<ActivityEntry[] | null> {
    const res = await this.request("/activity", { headers: this.connHeader(connectionName) });
    if (res.status !== 200) {
      return null;
    }
    return ((await res.json()) as { activity: ActivityEntry[] }).activity;
  }

  async renew(id: string, leaseId: string): Promise<RenewResult> {
    const res = await this.request("/lease/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, leaseId }),
    });
    if (!res.ok) {
      return { ok: false };
    }
    const { leaseExpiresAt } = (await res.json()) as { leaseExpiresAt: number };
    return { ok: true, leaseExpiresAt };
  }

  async executing(id: string, leaseId: string): Promise<boolean> {
    const res = await this.request("/executing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, leaseId }),
    });
    return res.ok;
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
