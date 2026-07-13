import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ENDPOINT, resolveEndpoint } from "./config.js";

/*
 * Endpoint resolution precedence: `--endpoint` flag > GLASSRAY_APP_URL >
 * GLASSRAY_ENDPOINT (deprecated) > default, with the trailing slash trimmed.
 */
describe("resolveEndpoint", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      app: process.env.GLASSRAY_APP_URL,
      legacy: process.env.GLASSRAY_ENDPOINT,
    };
    delete process.env.GLASSRAY_APP_URL;
    delete process.env.GLASSRAY_ENDPOINT;
  });
  afterEach(() => {
    for (const [k, v] of [
      ["GLASSRAY_APP_URL", saved.app],
      ["GLASSRAY_ENDPOINT", saved.legacy],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("prefers the flag and trims a trailing slash", () => {
    expect(resolveEndpoint("https://staging.glassray.ai/")).toBe("https://staging.glassray.ai");
  });

  it("falls back to GLASSRAY_APP_URL over the legacy var", () => {
    process.env.GLASSRAY_APP_URL = "https://app.example.com";
    process.env.GLASSRAY_ENDPOINT = "https://legacy.example.com";
    expect(resolveEndpoint()).toBe("https://app.example.com");
  });

  it("falls back to the legacy GLASSRAY_ENDPOINT when GLASSRAY_APP_URL is unset", () => {
    process.env.GLASSRAY_ENDPOINT = "https://legacy.example.com";
    expect(resolveEndpoint()).toBe("https://legacy.example.com");
  });

  it("defaults when nothing is set", () => {
    expect(resolveEndpoint()).toBe(DEFAULT_ENDPOINT);
  });
});
