import { afterEach, describe, expect, it, vi } from "vitest";
import { versionDockHtml, versionGroupHtml } from "./render/version";
import {
  compareVersions,
  fetchLatestRelease,
  LATEST_RELEASE_URL,
  parseServerIdentity,
  versionStatus,
} from "./version";

const rel = (version: string) => ({ version });
const dev = (version: string, branch?: string) => ({ version, dev: { sha: "5f5a0e4", branch } });
const header = (value: unknown) => encodeURIComponent(JSON.stringify(value));

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
});

describe("versionStatus", () => {
  it("says up to date when both sides match the latest release", () => {
    const s = versionStatus(rel("0.4.0"), rel("0.4.0"), "0.4.0");
    expect(s.plugin).toEqual({ kind: "ok", version: "0.4.0" });
    expect(s.server).toEqual({ kind: "ok", version: "0.4.0" });
    expect(s.dock).toEqual({ kind: "ok", version: "0.4.0" });
  });

  it("falls back to plugin and server agreeing when the latest release is unknown", () => {
    expect(versionStatus(rel("0.4.0"), rel("0.4.0"), null).dock).toEqual({
      kind: "ok",
      version: "0.4.0",
    });
  });

  it("treats a newer release as news, not as a fault", () => {
    const s = versionStatus(rel("0.4.0"), rel("0.4.0"), "0.5.0");
    expect(s.plugin).toMatchObject({ kind: "behind", tone: "info", latest: "0.5.0" });
    expect(s.server).toMatchObject({ kind: "behind", tone: "info", latest: "0.5.0" });
    expect(s.dock).toEqual({ kind: "update", latest: "0.5.0" });
  });

  it("warns only the side that lags the other, and the mismatch outranks a newer release", () => {
    const s = versionStatus(rel("0.4.0"), rel("0.5.0"), "0.6.0");
    expect(s.plugin).toMatchObject({ kind: "behind", tone: "warn", peer: "0.5.0" });
    expect(s.server).toMatchObject({ kind: "behind", tone: "info", latest: "0.6.0" });
    expect(s.dock).toEqual({ kind: "mismatch" });
    const old = versionStatus(rel("0.10.0"), rel("0.9.0"), null);
    expect(old.plugin.kind).toBe("ok");
    expect(old.server).toMatchObject({ kind: "behind", tone: "warn", peer: "0.10.0" });
  });

  it("still tells a lagging plugin to update when the server version is unknown", () => {
    const s = versionStatus(rel("0.4.0"), null, "0.5.0");
    expect(s.plugin).toMatchObject({ kind: "behind", tone: "info" });
    expect(s.server).toEqual({ kind: "unknown" });
    expect(s.dock).toEqual({ kind: "update", latest: "0.5.0" });
    expect(versionStatus(rel("0.4.0"), null, null).dock).toEqual({ kind: "unknown" });
  });

  it("gives no advice at all when either side is a dev build", () => {
    const linked = versionStatus(dev("0.4.0", "feat/x"), rel("0.3.0"), "0.9.0");
    expect(linked.plugin).toEqual({ kind: "dev", sha: "5f5a0e4", branch: "feat/x" });
    expect(linked.server).toEqual({ kind: "plain", version: "0.3.0" });
    expect(linked.dock).toEqual({ kind: "dev" });
    const devServer = versionStatus(rel("0.4.0"), dev("0.4.0"), "0.9.0");
    expect(devServer.plugin).toEqual({ kind: "plain", version: "0.4.0" });
    expect(devServer.dock).toEqual({ kind: "dev" });
  });
});

describe("parseServerIdentity", () => {
  it("reads a release or a dev build", () => {
    expect(parseServerIdentity(header({ version: "0.4.0" }))).toEqual({ version: "0.4.0" });
    expect(
      parseServerIdentity(header({ version: "0.4.0", dev: { sha: "a1b2c3d", branch: "feat/é" } })),
    ).toEqual({ version: "0.4.0", dev: { sha: "a1b2c3d", branch: "feat/é" } });
    expect(parseServerIdentity(header({ version: "0.4.0", dev: null }))).toEqual({
      version: "0.4.0",
      dev: {},
    });
  });

  it("reads anything else as unknown, never as a release", () => {
    for (const raw of [
      null,
      "",
      "%E0%A4%A",
      "not json",
      header({ version: 4 }),
      header({ version: "latest" }),
      header({ version: "0.4.0-beta.1" }),
      "x".repeat(4096),
    ]) {
      expect(parseServerIdentity(raw)).toBeNull();
    }
  });
});

describe("fetchLatestRelease", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stub = (impl: () => Promise<unknown>) => {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("reads the tag of the latest release, sending nothing but the request", async () => {
    const fetchMock = stub(async () => new Response(JSON.stringify({ tag_name: "v0.5.0" })));
    expect(await fetchLatestRelease()).toBe("0.5.0");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LATEST_RELEASE_URL);
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    expect(init.headers).toBeUndefined();
  });

  it("gives up quietly on any failure or an unexpected tag", async () => {
    stub(async () => new Response("rate limited", { status: 403 }));
    expect(await fetchLatestRelease()).toBeNull();
    stub(async () => new Response(JSON.stringify({ tag_name: "nightly" })));
    expect(await fetchLatestRelease()).toBeNull();
    stub(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchLatestRelease()).toBeNull();
  });
});

describe("version rendering", () => {
  it("escapes what the server or git reported", () => {
    const html = versionGroupHtml(
      versionStatus(dev("0.4.0", '<img src=x onerror="alert(1)">'), null, null),
      false,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("offers the stop command only where pkill exists", () => {
    const lagging = versionStatus(rel("0.5.0"), rel("0.4.0"), null);
    expect(versionGroupHtml(lagging, false)).toContain("data-copy-stop");
    const windows = versionGroupHtml(lagging, true);
    expect(windows).not.toContain("data-copy-stop");
    expect(windows).toContain("close and reopen every agent session");
  });

  it("keeps the corner indicator short", () => {
    expect(versionDockHtml({ kind: "update", latest: "0.5.0" }).html).not.toContain("available");
    expect(versionDockHtml({ kind: "mismatch" }).cls).toBe("warn");
    expect(versionDockHtml({ kind: "update", latest: "0.5.0" }).cls).toBe("info");
  });
});
