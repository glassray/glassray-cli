/**
 * `glassray whoami` — who and which org the active key resolves to. Reads the
 * stored/env key and confirms it against `/api/public/setup/status`.
 */
import { getStoredCredential, resolveApiKey } from "../lib/config.js";
import { parseCommand, type Context } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { getStatus } from "../lib/http.js";
import { bold, bullet, card, dim, link, printData } from "../lib/ui.js";

/** The `whoami` command. */
export const cmdWhoami = async (ctx: Context, args: string[]): Promise<void> => {
  parseCommand(args);
  const key = resolveApiKey(ctx.endpoint, ctx.apiKeyOverride);
  if (!key) {
    throw new CliError(`not logged in to ${ctx.endpoint} — run \`glassray login\``);
  }
  const stored = getStoredCredential(ctx.endpoint);
  const status = await getStatus(ctx.endpoint, key);

  if (ctx.json) {
    printData({
      endpoint: ctx.endpoint,
      organizationId: status.organizationId,
      orgName: stored?.orgName ?? null,
      userEmail: stored?.userEmail ?? null,
      traceCount: status.traceCount,
    });
    return;
  }

  card([
    `  ${bullet("ok")} ${stored?.userEmail ? `${bold(stored.userEmail)} → ` : ""}${bold(stored?.orgName ?? status.organizationId)}`,
    `    ${dim("Endpoint")}   ${link(ctx.endpoint)}`,
    `    ${dim("Org")}        ${status.organizationId}`,
    `    ${dim("Traces")}     ${status.traceCount} total`,
  ]);
};
