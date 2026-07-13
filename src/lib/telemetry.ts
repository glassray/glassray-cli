/**
 * Best-effort run-telemetry (phase/step events) so we can see where setup stalls
 * in aggregate. Strictly fire-and-forget: honors `--no-telemetry` /
 * `GLASSRAY_NO_TELEMETRY`, never blocks a command, never throws, and carries no
 * secrets. See docs/onboarding-wizard.md §9 (opt-out, PostHog-parity).
 */
import type { Context } from "./context.js";

/** A single telemetry event. */
export interface TelemetryEvent {
  /** Coarse phase, e.g. "setup". */
  phase: string;
  /** Fine step within the phase, e.g. "detect" / "connect_otlp" / "verified". */
  step: string;
  /** Optional non-sensitive properties (no keys, no code, no URLs with secrets). */
  props?: Record<string, string | number | boolean | null>;
}

/**
 * Post one event, best-effort. Resolves immediately (does not await the network)
 * so it never delays the CLI; all failures are swallowed.
 */
export const track = (ctx: Context, event: TelemetryEvent): void => {
  if (!ctx.telemetry) return;
  try {
    void fetch(`${ctx.endpoint}/api/public/telemetry/cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...event, cliVersion: process.env.npm_package_version ?? undefined }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {
    // Never let telemetry break a command.
  }
};
