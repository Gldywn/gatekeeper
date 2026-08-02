import { appStorage } from "@beekeeperstudio/plugin";
import type { ActivityEntry, Proposal, SessionRoster } from "../types";

export interface BrokerConfig {
  baseUrl: string;
  tokenKey: string;
}

// The non-sensitive connection context handed to the agent via POST /connection:
// dialect, database, schema, read-only, never host/user/credentials.
export interface ConnectionSnapshot {
  connectionName: string;
  databaseType: string;
  databaseName: string;
  schema: string | null;
  readOnly: boolean;
}

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

  async result(id: string, leaseId: string, body: Record<string, unknown>): Promise<void> {
    await this.request("/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, leaseId, ...body }),
    });
  }

  async postConnection(conn: ConnectionSnapshot): Promise<void> {
    await this.request("/connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(conn),
    });
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
