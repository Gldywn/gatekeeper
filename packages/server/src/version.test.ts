import { describe, expect, it } from "vitest";
import { readIdentity } from "./version.js";

const pkg = JSON.stringify({ version: "0.4.0" });

describe("readIdentity", () => {
  it("trusts a release stamp only for the version it sits next to", () => {
    expect(readIdentity(pkg, JSON.stringify({ version: "0.4.0" }))).toEqual({ version: "0.4.0" });
    expect(readIdentity(pkg, JSON.stringify({ version: "0.3.1" }))).toEqual({
      version: "0.4.0",
      dev: {},
    });
  });

  it("keeps the git facts of a dev stamp and drops anything else", () => {
    const stamp = { version: "0.4.0", dev: { sha: "5f5a0e4", branch: "feat/x", extra: 1 } };
    expect(readIdentity(pkg, JSON.stringify(stamp))).toEqual({
      version: "0.4.0",
      dev: { sha: "5f5a0e4", branch: "feat/x" },
    });
    const bogus = { version: "0.4.0", dev: { sha: 42, branch: "x".repeat(201) } };
    expect(readIdentity(pkg, JSON.stringify(bogus))).toEqual({ version: "0.4.0", dev: {} });
  });

  it("reads a missing or malformed stamp as a plain dev build, never a release", () => {
    for (const stamp of [null, "", "{", "null", "[]", '"0.4.0"']) {
      expect(readIdentity(pkg, stamp)).toEqual({ version: "0.4.0", dev: {} });
    }
  });
});
