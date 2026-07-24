export interface PolicyVerdict {
  readOnly: boolean;
  reason?: string;
}

// Conservative, fail-closed read-only check mirrored from the plugin guard.
// TODO(gatekeeper#parser-guard): replace with a dialect-aware SQL parser.
export function assessReadOnly(sql: string): PolicyVerdict {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  if (stripped.length === 0) {
    return { readOnly: false, reason: "Empty statement" };
  }
  const single = stripped.replace(/;\s*$/, "");
  if (single.includes(";")) {
    return { readOnly: false, reason: "Only a single statement is allowed" };
  }
  if (!/^(select|with)\b/i.test(single)) {
    return { readOnly: false, reason: "Only SELECT (or WITH ... SELECT) is allowed" };
  }
  return { readOnly: true };
}
