/**
 * The WorkOS AuthKit CLI-Auth device grant (RFC 8628), hand-rolled over raw
 * fetch. Starts a device authorization, prints the user code + opens the hosted
 * approval page (always printing the URL for headless sessions), then polls the
 * token endpoint honoring `interval` / `slow_down` until the user approves or the
 * code expires. See docs/onboarding-wizard.md §3.
 */
import { openBrowser } from "./browser.js";
import { CliError } from "./errors.js";
import { authorizeDevice, pollDeviceToken } from "./http.js";
import type { SetupConfigResponse } from "./types.js";
import { bold, detail, info, link, MODE_ERR, PALETTE, paintErr, spinner } from "./ui.js";

/**
 * Default Glassray auth-service base — the branded Authentication API domain, so
 * device requests, the `iss` on issued tokens, and the host end users glimpse
 * during sign-in all live on `glassray.ai`. Env-overridable via
 * `GLASSRAY_AUTH_API` (e.g. to point at a staging auth host).
 */
const DEFAULT_AUTH_API = "https://auth-api.glassray.ai";

/**
 * Resolve the auth-service base: `GLASSRAY_AUTH_API` env > the legacy
 * `GLASSRAY_WORKOS_API` env (DEPRECATED) > default. The legacy var stays a
 * fallback so an existing staging/dev environment that points it at a non-prod
 * auth host — matched to its own WorkOS `clientId` — keeps working after upgrade
 * instead of being silently sent to the production default.
 */
export const resolveAuthApi = (): string =>
  (process.env.GLASSRAY_AUTH_API ?? process.env.GLASSRAY_WORKOS_API ?? DEFAULT_AUTH_API).replace(
    /\/+$/,
    "",
  );

/** The result of a completed device grant. */
export interface DeviceAuthResult {
  accessToken: string;
  organizationId: string | null;
  userEmail: string | null;
}

/** Sleep for `seconds`. */
const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Run the full device grant against the deployment's WorkOS config. Requires a
 * non-null `clientId` (CLI auth enabled). Throws a `CliError` with a clear
 * message on expiry / denial / config gaps.
 */
export const runDeviceAuth = async (
  config: SetupConfigResponse,
  options: { open?: boolean } = {},
): Promise<DeviceAuthResult> => {
  if (!config.clientId) {
    throw new CliError(
      "this Glassray deployment has no CLI-auth client configured — pass --api-key, or set GLASSRAY_TOKEN",
    );
  }
  const authApi = resolveAuthApi();
  const auth = await authorizeDevice(authApi, config.clientId);

  info(`Pairing: your code is ${bold(auth.user_code, MODE_ERR)}`);
  const target = auth.verification_uri_complete || auth.verification_uri;
  if (options.open !== false) openBrowser(target);
  info(`Opening ${link(target, MODE_ERR)}`);
  detail("(or paste that URL on any device to approve)");

  const intervalStart = typeof auth.interval === "number" && auth.interval > 0 ? auth.interval : 5;
  const deadline = Date.now() + auth.expires_in * 1000;
  let interval = intervalStart;
  const spin = spinner("waiting for approval…");

  for (;;) {
    if (Date.now() >= deadline) {
      spin.fail("pairing code expired — run `glassray login` again");
      throw new CliError("device code expired before approval");
    }
    await sleep(interval);
    const token = await pollDeviceToken(authApi, config.clientId, auth.device_code);

    if (typeof token.access_token === "string") {
      spin.succeed(`approved${token.user?.email ? ` as ${token.user.email}` : ""}`);
      return {
        accessToken: token.access_token,
        organizationId: token.organization_id ?? null,
        userEmail: token.user?.email ?? null,
      };
    }

    switch (token.error) {
      case "authorization_pending":
        break; // keep polling
      case "slow_down":
        interval += 5; // RFC 8628 §3.5
        break;
      case "access_denied":
        spin.fail("pairing was denied in the browser");
        throw new CliError("device authorization was denied");
      case "expired_token":
        spin.fail("pairing code expired — run `glassray login` again");
        throw new CliError("device code expired before approval");
      default:
        spin.fail(`pairing failed: ${token.error ?? "unknown error"}`);
        throw new CliError(
          `device authentication failed: ${token.error_description ?? token.error ?? "unknown"}`,
        );
    }
    spin.update(`waiting for approval… ${paintErr(`(polling every ${interval}s)`, PALETTE.muted)}`);
  }
};
