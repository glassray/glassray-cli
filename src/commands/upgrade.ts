/**
 * `glassray upgrade` — print how to self-update. By design the CLI never mutates
 * a global install on its own; it reports the current/latest versions and the npm
 * command to run.
 */
import { parseCommand, type Context } from "../lib/context.js";
import { compareVersions, fetchLatestVersion, info, printData, VERSION } from "../lib/ui.js";

/** The `upgrade` command. */
export const cmdUpgrade = async (ctx: Context, args: string[]): Promise<void> => {
  parseCommand(args);
  const latest = await fetchLatestVersion();
  const outdated = latest !== null && compareVersions(latest, VERSION) > 0;
  const command = "npm install -g @glassray/cli@latest";

  if (ctx.json) {
    printData({ current: VERSION, latest, outdated, command });
    return;
  }
  if (outdated) info(`Update available: ${VERSION} → ${latest}`);
  else info(`glassray ${VERSION}${latest ? " is the latest" : ""}`);
  info(`To upgrade: ${command}`);
};
