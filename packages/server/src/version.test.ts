import { describe, expect, it } from "vitest";
import { launcherIdentity, readIdentity } from "./version.js";

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

describe("launcherIdentity", () => {
  it("keeps what the dev launcher knew, and never lets it claim a release", () => {
    const dev = { version: "0.4.0", dev: { sha: "fdd2424", branch: "feat/x" } };
    expect(launcherIdentity(pkg, JSON.stringify(dev))).toEqual(dev);
    expect(launcherIdentity(pkg, JSON.stringify({ version: "0.4.0" }))).toEqual({
      version: "0.4.0",
      dev: {},
    });
    expect(launcherIdentity(pkg, null)).toEqual({ version: "0.4.0", dev: {} });
  });
});
