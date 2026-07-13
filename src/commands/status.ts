/**
 * `glassray status` — the cloud-account aggregate: connected sources + health,
 * GitHub / Slack, and whether traces are landing. Pretty card or `--json`.
 */
import { getStoredCredential, resolveApiKey } from "../lib/config.js";
import { parseCommand, type Context } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { getStatus } from "../lib/http.js";
import type { SetupStatusResponse } from "../lib/types.js";
import { bold, bullet, card, dim, link, printData } from "../lib/ui.js";

/** Map a connection state to a bullet. */
const stateBullet = (connected: boolean): string => (connected ? bullet("ok") : bullet("down"));

/** Render the branded status card lines from a status payload. */
export const renderStatusCard = (
  endpoint: string,
  orgName: string | null,
  status: SetupStatusResponse,
): string[] => {
  const lines: string[] = [
    `  ${bold("glassray status")}  ${dim(link(endpoint))}`,
    ``,
    `  ${bullet(status.recentTraceCount > 0 ? "ok" : status.traceCount > 0 ? "warn" : "down")} ${bold(orgName ?? status.organizationId)} — ${status.traceCount} traces (${status.recentTraceCount} in last hour)`,
  ];
  if (status.sources.length === 0) {
    lines.push(`    ${dim("no trace sources connected yet — run")} glassray setup`);
  }
  for (const s of status.sources) {
    const health = s.enabled ? (s.lastError ? bullet("warn") : bullet("ok")) : bullet("down");
    const label = s.displayName ?? s.id;
    const err = s.lastError ? `  ${dim(`(${s.lastError})`)}` : "";
    lines.push(`    ${health} ${label} ${dim(`[${s.provider}]`)} — ${s.traceCount} traces${err}`);
  }
  lines.push(``);
  lines.push(`    ${stateBullet(status.github === "connected")} GitHub    ${dim(status.github)}`);
  lines.push(`    ${stateBullet(status.slack === "connected")} Slack     ${dim(status.slack)}`);
  return lines;
};

/** The `status` command. */
export const cmdStatus = async (ctx: Context, args: string[]): Promise<void> => {
  parseCommand(args);
  const key = resolveApiKey(ctx.endpoint, ctx.apiKeyOverride);
  if (!key) {
    throw new CliError(`not logged in to ${ctx.endpoint} — run \`glassray login\``);
  }
  const status = await getStatus(ctx.endpoint, key);
  if (ctx.json) {
    printData(status);
    return;
  }
  card(renderStatusCard(ctx.endpoint, getStoredCredential(ctx.endpoint)?.orgName ?? null, status));
};
