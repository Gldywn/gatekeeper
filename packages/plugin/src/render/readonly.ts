import type { EndpointReadOnly } from "../sql/readonly-probe";

export type LayerState = "ok" | "warn" | "mut";

export interface ReadOnlyView {
  gatekeeper: { label: string; state: LayerState };
  beekeeper: { label: string; state: LayerState };
  endpoint: { label: string; state: LayerState };
}

// A null endpoint is one no check has confirmed yet (no check for this engine, or none
// passed on this connection), so it reads unknown, never writable.
export function readOnlyView(
  gatekeeperReadOnly: boolean,
  beekeeperReadOnly: boolean,
  endpoint: EndpointReadOnly | null,
): ReadOnlyView {
  const word = (readOnly: boolean): { label: string; state: LayerState } =>
    readOnly ? { label: "read-only", state: "ok" } : { label: "writable", state: "warn" };
  return {
    gatekeeper: word(gatekeeperReadOnly),
    beekeeper: word(beekeeperReadOnly),
    endpoint:
      endpoint === null
        ? { label: "unknown", state: "mut" }
        : word(endpoint.replica || endpoint.sessionReadOnly),
  };
}
