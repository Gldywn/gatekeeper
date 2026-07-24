import { randomUUID } from "node:crypto";

export type Row = Record<string, unknown>;

export interface Field {
  name: string;
}

export interface Proposal {
  id: string;
  sql: string;
  intent?: string;
  createdAt: number;
}

export type ProposalResult =
  | { status: "approved"; rows: Row[]; fields: Field[] }
  | { status: "rejected"; reason?: string }
  | { status: "error"; error: string };

interface Waiter {
  resolve: (result: ProposalResult) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// MVP scope: single plugin, FIFO, in-memory, no persistence or fairness.
export class ProposalQueue {
  private readonly unclaimed: Proposal[] = [];
  private readonly waiters = new Map<string, Waiter>();

  // Blocks until the plugin posts a decision or the timeout fires.
  enqueue(
    sql: string,
    intent: string | undefined,
    timeoutMs: number,
  ): Promise<ProposalResult> {
    const proposal: Proposal = {
      id: randomUUID(),
      sql,
      intent,
      createdAt: Date.now(),
    };
    this.unclaimed.push(proposal);

    return new Promise<ProposalResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(proposal.id);
        this.drop(proposal.id);
        reject(new Error("Timed out waiting for human approval"));
      }, timeoutMs);
      this.waiters.set(proposal.id, { resolve, reject, timer });
    });
  }

  // Oldest un-claimed proposal; removing it marks it claimed.
  claimNext(): Proposal | undefined {
    return this.unclaimed.shift();
  }

  resolve(id: string, result: ProposalResult): boolean {
    const waiter = this.waiters.get(id);
    if (!waiter) {
      return false;
    }
    clearTimeout(waiter.timer);
    this.waiters.delete(id);
    waiter.resolve(result);
    return true;
  }

  private drop(id: string): void {
    const index = this.unclaimed.findIndex((p) => p.id === id);
    if (index !== -1) {
      this.unclaimed.splice(index, 1);
    }
  }
}
