export interface ConnectionSnapshot {
  connectionName: string;
  databaseType: string;
  databaseName: string;
  schema: string | null;
  readOnly: boolean;
  capturedAt: number;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The non-sensitive connection context the plugin shares with the agent. It
// never carries host, user, or credentials, and is informational only: any
// holder of the broker token can set it, so it must not drive authorization.
export class ConnectionState {
  private snapshot: ConnectionSnapshot | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  set(input: Record<string, unknown>): void {
    this.snapshot = {
      connectionName: str(input.connectionName),
      databaseType: str(input.databaseType),
      databaseName: str(input.databaseName),
      schema: input.schema == null ? null : str(input.schema),
      readOnly: input.readOnly === true,
      capturedAt: this.now(),
    };
  }

  get(): ConnectionSnapshot | null {
    return this.snapshot;
  }
}
