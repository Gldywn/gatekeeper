import type { EndpointReadOnly } from "../sql/readonly-probe";

export type LayerState = "ok" | "warn" | "mut";

export interface ReadOnlyView {
  chip: { kind: LayerState; label: string };
  gatekeeper: { label: string; state: LayerState };
  beekeeper: { label: string; state: LayerState };
  endpoint: { label: string; state: LayerState };
}

// One read-only layer protects the whole connection; only every layer writable is
// writable, anything left (no barrier, something we could not read) is not available.
// gatekeeperReadOnly is true until the mode becomes switchable, so today it is read-only.
export function readOnlyView(
  gatekeeperReadOnly: boolean,
  beekeeperReadOnly: boolean,
  endpoint: EndpointReadOnly | null,
  endpointProbed: boolean,
): ReadOnlyView {
  type Verdict = "ro" | "rw" | "na";
  const gk: Verdict = gatekeeperReadOnly ? "ro" : "rw";
  const bk: Verdict = beekeeperReadOnly ? "ro" : "rw";
  const ep: Verdict =
    !endpointProbed || endpoint === null
      ? "na"
      : endpoint.replica || endpoint.sessionReadOnly
        ? "ro"
        : "rw";
  const layers: Verdict[] = [gk, bk, ep];

  const kind: LayerState = layers.includes("ro")
    ? "ok"
    : layers.every((l) => l === "rw")
      ? "warn"
      : "mut";

  const word = (v: Verdict): { label: string; state: LayerState } =>
    v === "ro"
      ? { label: "read-only", state: "ok" }
      : v === "rw"
        ? { label: "writable", state: "warn" }
        : { label: "not available", state: "mut" };

  return {
    chip: { kind, label: word(kind === "ok" ? "ro" : kind === "warn" ? "rw" : "na").label },
    gatekeeper: word(gk),
    beekeeper: word(bk),
    endpoint: word(ep),
  };
}
