/**
 * `glassray logout` — clear the stored org credential for the active endpoint.
 * (Does not revoke the key server-side — rotate/revoke in the WorkOS API-keys
 * widget; re-running `login` mints a fresh deterministic-named key.)
 */
import { clearStoredCredential } from "../lib/config.js";
import { parseCommand, type Context } from "../lib/context.js";
import { printData, success, warn } from "../lib/ui.js";

/** The `logout` command. */
export const cmdLogout = async (ctx: Context, args: string[]): Promise<void> => {
  parseCommand(args);
  const removed = clearStoredCredential(ctx.endpoint);
  if (ctx.json) {
    printData({ endpoint: ctx.endpoint, removed });
    return;
  }
  if (removed) success(`logged out of ${ctx.endpoint}`);
  else warn(`no stored credential for ${ctx.endpoint}`);
};
