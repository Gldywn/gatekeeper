// One elected "active" tab talks to the broker; other Gatekeeper tabs sit standby and inert
// so open tabs never double-poll or race an approval. On the active closing, a standby promotes.

export type InstanceRole = "active" | "standby";

const NS = "gk-single-instance/v1";
const HEARTBEAT_MS = 2500;
const CLAIM_WINDOW_MS = 350;
const ACTIVE_TIMEOUT_MS = 8000;

type Kind = "claim" | "active" | "yield" | "takeover";
export interface SingleInstanceWire {
  ns: string;
  k: Kind;
  id: string;
}

export interface SingleInstanceDeps {
  post: (msg: SingleInstanceWire) => void;
  subscribe: (handler: (msg: SingleInstanceWire) => void) => void;
  now: () => number;
  // Fired when this tab becomes the one instance that may talk to the broker.
  onActive: () => void;
  // Fired when this tab must go inert (another instance owns the slot).
  onStandby: () => void;
}

export class SingleInstance {
  private role: InstanceRole | "pending" = "pending";
  private lastActiveAt = 0;
  private activePeer: string | null = null;
  private claimTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly d: SingleInstanceDeps;
  private readonly id: string;

  constructor(d: SingleInstanceDeps, id: string) {
    this.d = d;
    this.id = id;
    d.subscribe((m) => this.receive(m));
  }

  get instanceId(): string {
    return this.id;
  }

  join(): void {
    this.claim();
  }

  // A standby tab forcing itself active ("Use Gatekeeper here").
  takeOver(): void {
    this.send("takeover");
    this.claim();
  }

  // Mark inert first so a re-entrant claim from the standby we just yielded to is not
  // answered; then release the slot so it promotes at once instead of after the timeout.
  dispose(): void {
    const wasActive = this.role === "active";
    this.disposed = true;
    this.stopTimers();
    if (wasActive) {
      this.send("yield");
    }
  }

  private claim(): void {
    this.role = "pending";
    this.stopTimers();
    this.send("claim");
    this.claimTimer = setTimeout(() => {
      if (this.role === "pending") {
        this.promote();
      }
    }, CLAIM_WINDOW_MS);
  }

  private promote(): void {
    if (this.role === "active") {
      return;
    }
    this.role = "active";
    this.stopTimers();
    this.send("active");
    this.heartbeat = setInterval(() => this.send("active"), HEARTBEAT_MS);
    this.d.onActive();
  }

  private standby(peer: string): void {
    this.activePeer = peer;
    this.lastActiveAt = this.d.now();
    const changed = this.role !== "standby";
    this.role = "standby";
    if (this.claimTimer) {
      clearTimeout(this.claimTimer);
      this.claimTimer = null;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.d.now() - this.lastActiveAt > ACTIVE_TIMEOUT_MS) {
          this.claim();
        }
      }, HEARTBEAT_MS);
    }
    if (changed) {
      this.d.onStandby();
    }
  }

  private receive(m: SingleInstanceWire): void {
    if (this.disposed || !m || m.ns !== NS || m.id === this.id) {
      return;
    }
    switch (m.k) {
      case "claim":
        // Only an active instance answers, so the claimer learns the slot is owned.
        if (this.role === "active") {
          this.send("active");
        }
        break;
      case "active":
        if (this.role === "active") {
          // Two actives: the lower id keeps the slot, the other stands down.
          if (m.id < this.id) {
            this.standby(m.id);
          } else {
            this.send("active");
          }
        } else {
          this.standby(m.id);
        }
        break;
      case "takeover":
        if (this.role === "active") {
          this.standby(m.id);
        }
        break;
      case "yield":
        if (this.role === "standby" && m.id === this.activePeer) {
          this.claim();
        }
        break;
    }
  }

  private stopTimers(): void {
    if (this.claimTimer) {
      clearTimeout(this.claimTimer);
      this.claimTimer = null;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private send(k: Kind): void {
    this.d.post({ ns: NS, k, id: this.id });
  }
}
