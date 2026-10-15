import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS build script, shared with the plugin's vite.config
import { buildIdentity } from "../../../scripts/build-identity.mjs";

describe("buildIdentity", () => {
  it("is a release only when the release tag names this exact version", () => {
    expect(buildIdentity(tmpdir(), "0.4.0", "v0.4.0")).toEqual({ version: "0.4.0" });
    expect(() => buildIdentity(tmpdir(), "0.4.0", "v0.3.1")).toThrow(/v0\.3\.1/);
  });

  it("is dev without a tag, even where git has nothing to say", () => {
    expect(buildIdentity(tmpdir(), "0.4.0", undefined)).toEqual({ version: "0.4.0", dev: {} });
  });
});
