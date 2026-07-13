/**
 * `glassray login` — pair this machine with a Glassray org via the WorkOS device
 * grant, then swap the access token for a durable org API key at
 * `/api/public/setup/exchange`. `--api-key` (or `GLASSRAY_TOKEN`) skips pairing
 * for CI/headless. Also exports `ensurePaired`, the shared "make sure we have a
 * usable org key" helper the setup launcher reuses.
 */
import { getStoredCredential, resolveApiKey, setStoredCredential, type StoredCredential } from "../lib/config.js";
import { boolFlag, parseCommand, strFlag, type Context } from "../lib/context.js";
import { runDeviceAuth } from "../lib/device-auth.js";
import { CliError } from "../lib/errors.js";
import { exchange, getConfig, getStatus } from "../lib/http.js";
import { prompt } from "../lib/prompt.js";
import type { SetupExchangeResponse } from "../lib/types.js";
import { bold, bullet, card, dim, info, link, PALETTE, paint, printData, success } from "../lib/ui.js";

/** Ask for a new organization's name on a fresh sign-up. TTY-only (the caller gates on `isTTY`). */
const promptOrgName = async (): Promise<string> => {
  info("Looks like you're new here — let's name your organization first.");
  return prompt("Organization name:");
};

/**
 * Exchange the device-grant token for an org key. On a fresh sign-up the user
 * has no organization yet and the server replies `org-name-required`; on a TTY
 * we ask for a name and retry, creating the org — the browser wizard then just
 * does the onboarding. (Non-TTY re-throws the guidance to pass `--org-name`.)
 */
const exchangeWithOrgPrompt = async (
  ctx: Context,
  accessToken: string,
  opts: { orgName?: string; org?: string },
): Promise<SetupExchangeResponse> => {
  const req = {
    ...(opts.orgName ? { orgName: opts.orgName } : {}),
    ...(opts.org ? { organizationId: opts.org } : {}),
  };
  try {
    return await exchange(ctx.endpoint, accessToken, req);
  } catch (err) {
    if (err instanceof CliError && err.code === "org-name-required" && process.stdin.isTTY) {
      const orgName = await promptOrgName();
      return exchange(ctx.endpoint, accessToken, { ...req, orgName });
    }
    throw err;
  }
};

/** How the CLI became (or already was) paired. */
export interface PairResult extends StoredCredential {
  /** True when this call actually ran the browser pairing (vs. reusing a key). */
  paired: boolean;
}

/**
 * Ensure an org API key is available for `ctx.endpoint`. Precedence:
 * `--api-key` / `GLASSRAY_TOKEN` (validated) → stored credential → run the
 * device grant + exchange. In non-interactive sessions with no key, this throws
 * rather than blocking on a prompt.
 */
export const ensurePaired = async (
  ctx: Context,
  opts: { orgName?: string; org?: string; open?: boolean; forceRepair?: boolean } = {},
): Promise<PairResult> => {
  // 1. An explicit key (env/flag) short-circuits pairing — validate it once.
  if (!opts.forceRepair) {
    const key = resolveApiKey(ctx.endpoint, ctx.apiKeyOverride);
    if (key) {
      const stored = getStoredCredential(ctx.endpoint);
      if (stored && stored.apiKey === key) {
        return { ...stored, paired: false };
      }
      // A raw key from env/flag with no matching stored metadata: confirm it works.
      // Only reuse the stored orgName/userEmail when it belongs to the SAME org the
      // key validated as — otherwise a stored credential for a different org would
      // mislabel the session ("Signed in to <wrong org>").
      const status = await getStatus(ctx.endpoint, key);
      const sameOrg = stored?.organizationId === status.organizationId;
      const cred = {
        organizationId: status.organizationId,
        orgName: sameOrg && stored ? stored.orgName : status.organizationId,
        apiKey: key,
        userEmail: sameOrg && stored ? stored.userEmail : null,
        updatedAt: new Date().toISOString(),
      };
      return { ...cred, paired: false };
    }
  }

  // 2. No key — run the device grant.
  if (!process.stdin.isTTY && opts.forceRepair !== true && !ctx.apiKeyOverride) {
    // Non-TTY with no key: we cannot open a browser prompt. Surface the fix.
    throw new CliError(
      "not paired and no GLASSRAY_TOKEN set — run `glassray login` in an interactive terminal, or pass --api-key",
    );
  }
  const config = await getConfig(ctx.endpoint);
  const grant = await runDeviceAuth(config, { open: opts.open });
  const result = await exchangeWithOrgPrompt(ctx, grant.accessToken, {
    orgName: opts.orgName,
    org: opts.org,
  });
  setStoredCredential(ctx.endpoint, {
    organizationId: result.organizationId,
    orgName: result.orgName,
    apiKey: result.apiKey.value,
    userEmail: result.userEmail,
  });
  return {
    organizationId: result.organizationId,
    orgName: result.orgName,
    apiKey: result.apiKey.value,
    userEmail: result.userEmail,
    updatedAt: new Date().toISOString(),
    paired: true,
  };
};

/** The `login` command. */
export const cmdLogin = async (ctx: Context, args: string[]): Promise<void> => {
  const { values } = parseCommand(args, {
    "org-name": { type: "string" },
    org: { type: "string" },
    "no-open": { type: "boolean" },
  });
  const orgName = strFlag(values, "org-name");
  const org = strFlag(values, "org");
  const open = !boolFlag(values, "no-open");

  const result = await ensurePaired(ctx, { orgName, org, open });

  if (ctx.json) {
    printData({
      organizationId: result.organizationId,
      orgName: result.orgName,
      userEmail: result.userEmail,
      paired: result.paired,
    });
    return;
  }

  const who = result.userEmail ? `${bold(result.userEmail)} → ` : "";
  success(result.paired ? "paired" : "already paired");
  card([
    `  ${bullet("ok")} Signed in ${who}${bold(result.orgName)}`,
    `    ${dim("Endpoint")}   ${link(ctx.endpoint)}`,
    `    ${dim("Org")}        ${result.organizationId}`,
    ``,
    `  Next: ${paintCmd("glassray setup")} to wire ingestion, or ${paintCmd("glassray status")}.`,
  ]);
};

/** Bright-green command styling used across the branded cards. */
const paintCmd = (text: string): string => bold(paint(text, PALETTE.brandBright));
