/**
 * `glassray token` — print the stored org API key for the current endpoint, raw
 * on stdout (the `gh auth token` pattern). Exists so the `.mcp.json` bearer can
 * stay an env reference instead of a committed secret:
 *
 *   export GLASSRAY_TOKEN="$(glassray token)"
 *
 * Data on stdout only; everything human goes to stderr, so command substitution
 * captures exactly the key.
 */
import { resolveApiKey } from "../lib/config.js";
import { parseCommand, type Context } from "../lib/context.js";
import { CliError } from "../lib/errors.js";

/** Print the resolved org key (flag > `GLASSRAY_TOKEN` env > stored) or fail with the login hint. */
export const cmdToken = async (ctx: Context, args: string[]): Promise<void> => {
  parseCommand(args);
  const key = resolveApiKey(ctx.endpoint, ctx.apiKeyOverride);
  if (!key) throw new CliError(`not logged in to ${ctx.endpoint} — run \`glassray login\``);
  process.stdout.write(`${key}\n`);
};
