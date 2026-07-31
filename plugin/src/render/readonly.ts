import type { EndpointReadOnly } from "../sql/readonly-probe";

export type LayerState = "ok" | "warn" | "mut";

// One harmonized vocabulary for every layer chip and the summary badge, derived
// host-side only: the endpoint probe result never leaves the plugin.
export interface ReadOnlyView {
  chip: { kind: LayerState; label: string; lock: boolean };
  gatekeeper: { label: string; state: LayerState };
  beekeeper: { label: string; state: LayerState };
  endpoint: { label: string; state: LayerState };
}

export function readOnlyView(
  beekeeperReadOnly: boolean,
  endpoint: EndpointReadOnly | null,
  endpointProbed: boolean,
): ReadOnlyView {
  const endpointReadOnly = endpoint !== null && (endpoint.replica || endpoint.sessionReadOnly);
  const endpointWriter = endpoint !== null && !endpoint.replica && !endpoint.sessionReadOnly;
  const beyondGatekeeper = beekeeperReadOnly || endpointReadOnly;

  const endpointLayer: { label: string; state: LayerState } =
    !endpointProbed || endpoint === null
      ? { label: "not verified", state: "mut" }
      : endpointReadOnly
        ? { label: "read-only", state: "ok" }
        : { label: "writable", state: "warn" };

  // Green lock only when a layer below Gatekeeper also blocks writes; amber writable
  // when the probe confirmed a writer; muted unverified for the non-Postgres edge.
  const chip: { kind: LayerState; label: string; lock: boolean } = beyondGatekeeper
    ? { kind: "ok", label: "read-only", lock: true }
    : endpointWriter
      ? { kind: "warn", label: "writable", lock: false }
      : { kind: "mut", label: "unverified", lock: false };

  return {
    chip,
    gatekeeper: { label: "read-only", state: "ok" },
    beekeeper: beekeeperReadOnly
      ? { label: "read-only", state: "ok" }
      : { label: "off", state: "mut" },
    endpoint: endpointLayer,
  };
}
