import { afterEach, describe, expect, it, vi } from "vitest";
import { exchange, getStatus, ORG_KEY_HINT } from "./http.js";
import { CliError } from "./errors.js";

/*
 * The org-key calls attach a remediation hint on a 401 (`glassray logout` …) so a
 * stale / revoked key doesn't dead-end at a bare "invalid api key".
 */
describe("org-key request hints", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respondWith = (status: number, body: unknown): void => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
  };

  it("attaches the logout hint on a 401, surfacing the server message", async () => {
    respondWith(401, { error: "invalid api key" });
    await expect(getStatus("https://app.glassray.ai", "glr_stale")).rejects.toMatchObject({
      message: "invalid api key",
      hint: ORG_KEY_HINT,
    });
  });

  it("does NOT attach an auth hint on a non-401 (e.g. 503)", async () => {
    respondWith(503, { error: "status temporarily unavailable" });
    const err = await getStatus("https://app.glassray.ai", "glr_ok").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).hint).toBeUndefined();
  });

  /** The org picker reads the multi-org 409's structured body — a CliError must carry it. */
  it("carries the full error body as payload (the multi-org picker's data source)", async () => {
    const orgs = [{ id: "org_a", name: "Acme", roleSlug: "admin" }];
    respondWith(409, { error: "You belong to multiple organizations", code: "multi-org", orgs });
    const err = await exchange("https://app.glassray.ai", "token", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("multi-org");
    expect((err as CliError).payload).toMatchObject({ orgs });
  });
});
