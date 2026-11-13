import { describe, expect, it } from "vitest";
import {
  activeEvaluator,
  agentPrompt,
  canonicalBaseUrl,
  DEFAULT_SETTINGS,
  evaluatorConfig,
  firstMissing,
  keySlot,
  parseSettings,
  recipient,
  settingsFor,
} from "./evaluator";
import { AUTO_THRESHOLDS } from "./sql/auto";

const custom = (baseUrl: string, model = "kev-4b") => ({
  ...settingsFor("custom", model),
  baseUrl,
});

describe("the stored evaluator", () => {
  it("reads back what Settings keeps", () => {
    expect(parseSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))).toEqual(DEFAULT_SETTINGS);
    const own = { ...custom("http://127.0.0.1:8080"), cutoffs: { ...AUTO_THRESHOLDS } };
    expect(parseSettings(own)).toEqual(own);
  });

  it.each([
    null,
    [],
    "typesafe",
    { ...DEFAULT_SETTINGS, provider: "openai" },
    { ...DEFAULT_SETTINGS, builtIn: "yes" },
    { ...DEFAULT_SETTINGS, cutoffs: { personal_disclosure: 0.2 } },
    { ...DEFAULT_SETTINGS, cutoffs: { ...AUTO_THRESHOLDS, insufficient_context: 2 } },
    // Built-in cutoffs exist only for jev-1.13.0, and only as shipped.
    { ...DEFAULT_SETTINGS, cutoffs: { ...AUTO_THRESHOLDS, personal_disclosure: 0.9 } },
    { ...settingsFor("custom", "kev-4b"), builtIn: true, cutoffs: { ...AUTO_THRESHOLDS } },
    { ...DEFAULT_SETTINGS, baseUrl: "x".repeat(3000) },
  ])("treats a damaged entry as no choice, never as TypeSafe: %o", (raw) => {
    expect(parseSettings(raw)).toBeUndefined();
  });

  it("starts every model other than jev-1.13.0 with empty cutoffs", () => {
    expect(settingsFor("custom", "kev-4b").cutoffs).toEqual({
      personal_disclosure: null,
      organization_disclosure: null,
      secret_disclosure: null,
      insufficient_context: null,
    });
    expect(settingsFor("typesafe").builtIn).toBe(true);
  });
});

describe("a Custom server's address", () => {
  it.each([
    ["http://localhost:8080/", "http://127.0.0.1:8080"],
    [" https://kev.example.test/api/ ", "https://kev.example.test/api"],
    ["http://[::1]:8080", "http://[::1]:8080"],
  ])("keeps %s as %s", (raw, canonical) => {
    expect(canonicalBaseUrl(raw)).toBe(canonical);
  });

  it.each([
    "http://kev.example.test",
    "https://a:b@kev.example.test",
    "https://kev.example.test/?k=1",
  ])("refuses %s", (raw) => {
    expect(canonicalBaseUrl(raw)).toBeUndefined();
  });

  it("is not a usable evaluator until it is canonical and names a model", () => {
    expect(evaluatorConfig(custom("http://localhost:8080"))).toBeUndefined();
    expect(firstMissing(custom("http://localhost:8080"))).toBe("baseUrl");
    expect(firstMissing(custom("http://127.0.0.1:8080", ""))).toBe("model");
    expect(firstMissing(custom("http://127.0.0.1:8080"))).toBe("personal_disclosure");
  });
});

describe("keys and the choice in force", () => {
  it("gives each destination its own key slot, path prefix included", () => {
    expect(keySlot(DEFAULT_SETTINGS)).toBe("gatekeeper.typesafe-key");
    expect(keySlot(custom("https://kev.example.test/a"))).not.toBe(
      keySlot(custom("https://kev.example.test/b")),
    );
    expect(keySlot(custom("not a url"))).toBeUndefined();
  });

  it("freezes the choice Auto mode is switched on with", () => {
    const s = { ...custom("https://kev.example.test/tenant"), cutoffs: { ...AUTO_THRESHOLDS } };
    const rule = activeEvaluator(s);
    expect(rule).toMatchObject({
      config: { provider: "custom", model: "kev-4b", baseUrl: "https://kev.example.test/tenant" },
      builtIn: false,
      endpoint: "https://kev.example.test",
    });
    expect(Object.isFrozen(rule)).toBe(true);
    expect(Object.isFrozen(rule?.cutoffs)).toBe(true);
    s.cutoffs.personal_disclosure = 0.9;
    expect(rule?.cutoffs.personal_disclosure).toBe(0.2);
    expect(activeEvaluator(custom("https://kev.example.test"))).toBeUndefined();
  });

  it("names who receives the input", () => {
    expect(recipient(DEFAULT_SETTINGS)).toBe("TypeSafe");
    expect(recipient(custom("http://127.0.0.1:8080/v"))).toBe("Custom server at 127.0.0.1:8080");
    expect(recipient(undefined)).toBe("The evaluator");
  });

  it("writes a prompt that names the bench and never a key", () => {
    const prompt = agentPrompt(custom("https://kev.example.test"));
    expect(prompt).toContain(
      "--provider custom --model kev-4b --base-url https://kev.example.test --split development",
    );
    expect(prompt).toContain("GATEKEEPER_EVALUATOR_KEY");
    expect(prompt).toContain("TZ=UTC");
    expect(prompt).toContain("Do not change my Gatekeeper settings");
    expect(prompt).not.toMatch(/apikey_|Bearer/);
  });
});

describe("the commands the prompt hands to an agent", () => {
  it.each([
    ["https://kev.example.test/a&b", "'https://kev.example.test/a&b'"],
    ["https://kev.example.test/$(id)", "'https://kev.example.test/$(id)'"],
    ["https://kev.example.test/it's", "'https://kev.example.test/it'\\''s'"],
  ])("quotes %s as one shell word", (url, quoted) => {
    expect(canonicalBaseUrl(url)).toBe(url);
    const prompt = agentPrompt({ ...custom(url), model: "kev-4b" }) ?? "";
    expect(prompt).toContain(`--base-url ${quoted} --split development`);
  });

  it("writes no command for an evaluator not yet complete", () => {
    expect(agentPrompt(custom(""))).toBeUndefined();
  });

  it("refuses a stored hosted model its provider does not serve", () => {
    expect(
      parseSettings({ ...DEFAULT_SETTINGS, builtIn: false, model: "jev-latest" }),
    ).toBeUndefined();
  });
});
