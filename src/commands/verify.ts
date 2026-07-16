/**
 * `glassray verify` — the exit gate. Polls `/api/public/setup/status` until a
 * trace has landed (recent push, or any source with traces). On timeout it
 * prints a diagnosis ladder so the user knows exactly what to fix. A
 * permanent standalone command, not just an onboarding step.
 */
import { resolveApiKey } from "../lib/config.js";
import { boolFlag, parseCommand, resolveTimeoutSec, type Context } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { getStatus } from "../lib/http.js";
import { pollUntil } from "../lib/poll.js";
import type { SetupStatusResponse } from "../lib/types.js";
import { bullet, card, detail, dim, info, printData, spinner } from "../lib/ui.js";

/** True when the status shows a trace has landed (recent push, or any source with traces). */
const tracesLanded = (s: SetupStatusResponse): boolean =>
  s.recentTraceCount >= 1 || s.traceCount >= 1 || s.sources.some((src) => src.traceCount > 0);

/** The diagnosis ladder shown on a failed verify. */
const DIAGNOSIS: string[] = [
  "401 / 403 → wrong or missing org key: re-run `glassray login` (or check GLASSRAY_TOKEN)",
  "200 but zero traces → exporter endpoint wrong, or the process exited before flush() — check the OTLP endpoint + call flush on shutdown",
  "tags missing → re-run `glassray instrument` to stamp glassray.customer / agent / flow",
];

/** The `verify` command. */
export const cmdVerify = async (ctx: Context, args: string[]): Promise<void> => {
  const { values } = parseCommand(args, {
    wait: { type: "boolean" },
    canary: { type: "boolean" },
    timeout: { type: "string" },
  });
  const key = resolveApiKey(ctx.endpoint, ctx.apiKeyOverride);
  if (!key) throw new CliError(`not logged in to ${ctx.endpoint} — run \`glassray login\``);

  if (boolFlag(values, "canary")) {
    // SDK-emitted canary traces are a future capability. For now,
    // instruct running the real agent — surfaced, not silently ignored.
    info("--canary isn't available yet — run your agent to send a real trace instead.");
  }

  const timeoutSec = resolveTimeoutSec(values, 180);
  const wait = boolFlag(values, "wait");

  // A single check when not waiting.
  if (!wait) {
    const status = await getStatus(ctx.endpoint, key);
    if (ctx.json) {
      printData({ verified: tracesLanded(status), ...status });
      if (!tracesLanded(status)) throw new CliError("No traces have arrived yet — run your agent, then try again.");
      return;
    }
    if (tracesLanded(status)) reportVerified(status);
    else reportUnverified(status, null);
    if (!tracesLanded(status)) throw new CliError("No traces have arrived yet — run your agent, then try again.");
    return;
  }

  info("Run your agent once so we can confirm traces are arriving.");
  const spin = spinner("Watching for your first trace…");
  const result = await pollUntil(
    () => getStatus(ctx.endpoint, key),
    tracesLanded,
    {
      timeoutSec,
      onTick: (s, elapsed) => spin.update(`Watching for your first trace… ${s.traceCount} seen (${elapsed}s)`),
    },
  );
  spin.stop();

  if (ctx.json) {
    printData({ verified: result.satisfied, ...result.value });
    if (!result.satisfied) throw new CliError("No traces arrived before the timeout.");
    return;
  }

  if (result.satisfied) {
    reportVerified(result.value);
  } else {
    reportUnverified(result.value, timeoutSec);
    throw new CliError("No traces arrived before the timeout — run your agent, then `glassray verify --wait`.");
  }
};

/** Print the verified success card. */
const reportVerified = (status: SetupStatusResponse): void => {
  card([
    `  ${bullet("ok")} Traces are arriving — Glassray is watching your agent`,
    `    ${dim("Traces")}   ${status.traceCount} received (${status.recentTraceCount} in the last hour)`,
  ]);
};

/** Print the unverified card + the diagnosis ladder. */
const reportUnverified = (status: SetupStatusResponse, timeoutSec: number | null): void => {
  card([
    `  ${bullet("down")} No traces have arrived${timeoutSec ? ` in ${timeoutSec}s` : " yet"}`,
    `    ${dim("Sources")}  ${status.sources.length} connected · ${status.traceCount} received`,
  ]);
  info("A few things to check:");
  for (const line of DIAGNOSIS) detail(`• ${line}`);
};
