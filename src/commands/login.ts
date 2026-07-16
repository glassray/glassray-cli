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
import { pick, prompt } from "../lib/prompt.js";
import type { SetupExchangeOrgOption, SetupExchangeRequest, SetupExchangeResponse } from "../lib/types.js";
import { bold, bullet, card, dim, info, link, PALETTE, paint, printData, success } from "../lib/ui.js";

/** Ask for a new organization's name on a fresh sign-up. TTY-only (the caller gates on `isTTY`). */
const promptOrgName = async (): Promise<string> => {
  info("Looks like you're new here — let's name your organization first.");
  return prompt("Organization name:");
};

/**
 * Pull the selectable orgs out of a `multi-org` 409's structured body.
 * `undefined` when the server predates the payload (older deployment) — the
 * caller then falls back to the plain error + `--org` guidance.
 */
const parseOrgOptions = (
  payload: Record<string, unknown> | undefined,
): SetupExchangeOrgOption[] | undefined => {
  if (!payload || !Array.isArray(payload.orgs)) return undefined;
  const orgs = payload.orgs.filter((o): o is SetupExchangeOrgOption => {
    if (!o || typeof o !== "object") return false;
    const rec = o as Record<string, unknown>;
    return typeof rec.id === "string" && typeof rec.name === "string";
  });
  return orgs.length > 0 ? orgs : undefined;
};

/**
 * The interactive org picker shown when the account belongs to several orgs:
 * every org (non-admin ones marked — the exchange only mints keys for admins),
 * plus a "create a new organization" escape hatch. Returns the follow-up
 * exchange request for the choice. TTY-only (the caller gates).
 */
const pickOrg = async (orgs: SetupExchangeOrgOption[]): Promise<SetupExchangeRequest> => {
  const labels = orgs.map(
    (o) => `${o.name}${o.roleSlug && o.roleSlug !== "admin" ? dim(" — needs admin") : ""}`,
  );
  const chosen = await pick("Which organization do you want to set up?", [
    ...labels,
    "Create a new organization…",
  ]);
  if (chosen < orgs.length) return { organizationId: orgs[chosen]!.id };
  const orgName = await prompt("New organization name:");
  return { orgName, createOrg: true };
};

/**
 * Exchange the device-grant token for an org key, resolving the two interactive
 * cases on a TTY: a fresh sign-up (`org-name-required` → ask for a name and
 * create the org), and a multi-org account (`multi-org` → picker over the 409's
 * orgs, or create a new one) — the browser wizard then just does the
 * onboarding. Non-TTY re-throws the server guidance (`--org-name` / `--org`).
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
    if (err instanceof CliError && process.stdin.isTTY) {
      if (err.code === "org-name-required") {
        const orgName = await promptOrgName();
        return exchange(ctx.endpoint, accessToken, { ...req, orgName });
      }
      if (err.code === "multi-org") {
        const orgs = parseOrgOptions(err.payload);
        if (orgs) {
          const choice = await pickOrg(orgs);
          return exchange(ctx.endpoint, accessToken, { ...req, ...choice });
        }
      }
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
