import type { EndpointReadOnly } from "../sql/readonly-probe";

export type LayerState = "ok" | "warn" | "mut";

export interface ReadOnlyView {
  chip: { kind: LayerState; label: string };
  gatekeeper: { label: string; state: LayerState };
  beekeeper: { label: string; state: LayerState };
  endpoint: { label: string; state: LayerState };
}

// One read-only layer protects the whole connection; only every layer writable is
// writable, anything left (no barrier, something unverified) is unknown. gatekeeperReadOnly
// is true until the mode becomes switchable, so today the badge is always read-only.
export function readOnlyView(
  gatekeeperReadOnly: boolean,
  beekeeperReadOnly: boolean,
  endpoint: EndpointReadOnly | null,
  endpointProbed: boolean,
): ReadOnlyView {
  type Verdict = "ro" | "rw" | "unknown";
  const gk: Verdict = gatekeeperReadOnly ? "ro" : "rw";
  const bk: Verdict = beekeeperReadOnly ? "ro" : "rw";
  const ep: Verdict =
    !endpointProbed || endpoint === null
      ? "unknown"
      : endpoint.replica || endpoint.sessionReadOnly
        ? "ro"
        : "rw";
  const layers: Verdict[] = [gk, bk, ep];

  const kind: LayerState = layers.includes("ro")
    ? "ok"
    : layers.every((l) => l === "rw")
      ? "warn"
      : "mut";
  const label = kind === "ok" ? "read-only" : kind === "warn" ? "writable" : "unknown";

  const endpointRow: { label: string; state: LayerState } =
    !endpointProbed || endpoint === null
      ? { label: "not verified", state: "mut" }
      : endpoint.replica
        ? { label: "read replica", state: "ok" }
        : endpoint.sessionReadOnly
          ? { label: "session read-only", state: "ok" }
          : { label: "writable", state: "warn" };

  return {
    chip: { kind, label },
    gatekeeper: { label: "read-only", state: "ok" },
    beekeeper: beekeeperReadOnly ? { label: "on", state: "ok" } : { label: "off", state: "mut" },
    endpoint: endpointRow,
  };
}
