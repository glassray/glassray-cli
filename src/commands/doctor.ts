/**
 * `glassray doctor` — local + cloud health checks with one-line fixes: Node
 * version, endpoint reachability, key validity, and whether a local Coach server
 * is up. Exits non-zero when any hard check fails.
 */
import { resolveApiKey } from "../lib/config.js";
import { parseCommand, type Context } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { getConfig, getStatus } from "../lib/http.js";
import {
  bullet,
  compareVersions,
  fetchLatestVersion,
  printData,
  updateCheckOptedOut,
  VERSION,
} from "../lib/ui.js";

/** One diagnostic line. */
interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Probe whether a local Coach server answers on the port. */
const probeCoach = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const info = (await res.json()) as { name?: string };
    return info?.name === "glassray";
  } catch {
    return false;
  }
};

/** The `doctor` command. */
export const cmdDoctor = async (ctx: Context, args: string[]): Promise<void> => {
  parseCommand(args);
  const checks: Check[] = [];

  // Node version (the CLI supports Node 20.6+, matching @glassray/coach).
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 20 || (major === 20 && minor >= 6);
  checks.push({
    name: "node",
    ok: nodeOk,
    detail: nodeOk ? process.versions.node : `${process.versions.node} — install Node 20.6+`,
  });

  // Endpoint reachable (via the public config route).
  let appReachable = false;
  try {
    await getConfig(ctx.endpoint);
    appReachable = true;
  } catch {
    appReachable = false;
  }
  checks.push({
    name: "endpoint",
    ok: appReachable,
    detail: appReachable ? ctx.endpoint : `${ctx.endpoint} unreachable — check --endpoint / network`,
  });

  // Key validity (only when a key resolves).
  const key = resolveApiKey(ctx.endpoint, ctx.apiKeyOverride);
  if (key) {
    let valid = false;
    try {
      await getStatus(ctx.endpoint, key);
      valid = true;
    } catch {
      valid = false;
    }
    checks.push({
      name: "credentials",
      ok: valid,
      detail: valid ? "org key valid" : "org key rejected — re-run `glassray login`",
    });
  } else {
    checks.push({ name: "credentials", ok: true, detail: "not logged in (run `glassray login` when ready)" });
  }

  // Local Coach server (informational — not a hard failure).
  const coachUp = await probeCoach(ctx.port);
  checks.push({
    name: "local coach",
    ok: true,
    detail: coachUp ? `running on :${ctx.port}` : `not running on :${ctx.port} (start with \`glassray start\`)`,
  });

  // Update check (informational).
  if (!updateCheckOptedOut()) {
    const latest = await fetchLatestVersion();
    if (latest && compareVersions(latest, VERSION) > 0) {
      checks.push({ name: "version", ok: true, detail: `${latest} available (you have ${VERSION}) — npm i -g @glassray/cli` });
    } else {
      checks.push({ name: "version", ok: true, detail: `${VERSION}${latest ? " (latest)" : ""}` });
    }
  }

  const hardFail = checks.some((c) => !c.ok && (c.name === "node" || c.name === "endpoint" || c.name === "credentials"));

  if (ctx.json) {
    printData({ checks, ok: !hardFail });
    return;
  }
  process.stderr.write("\n");
  for (const c of checks) {
    process.stderr.write(`  ${c.ok ? bullet("ok") : bullet("down")} ${c.name.padEnd(12)} ${c.detail}\n`);
  }
  process.stderr.write("\n");
  if (hardFail) throw new CliError("doctor found problems — see the checks above");
};
