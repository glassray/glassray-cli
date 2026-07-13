/**
 * `glassray connect <target>` — wire a trace source or an integration:
 *   otlp                          push source (SDK/OTLP); writes the ingest key to .env.local
 *   langsmith | langfuse | posthog  pull source (provider keys → Vault, server-side)
 *   github | slack                deep-link consent; `--wait` polls status to connected
 *
 * OTLP/pull hit the REST API with the org key; github/slack open a browser
 * hand-off and always print the URL too (SSH-safe). See docs/onboarding-wizard.md.
 */
import path from "node:path";
import { resolveApiKey } from "../lib/config.js";
import { boolFlag, parseCommand, resolveTimeoutSec, strFlag, type Context } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { openBrowser } from "../lib/browser.js";
import { readDotenvValues, upsertEnvLocal } from "../lib/env-file.js";
import { connectOtlp, connectPull, getConfig, getStatus } from "../lib/http.js";
import { pollUntil } from "../lib/poll.js";
import type { ConnectPullRequest, PullProvider, SetupStatusResponse } from "../lib/types.js";
import { bullet, card, detail, dim, info, link, printData, spinner, success } from "../lib/ui.js";

/** The env var the ingest key is written under in `.env.local` (consumed by the SDK exporter). */
export const INGEST_KEY_ENV_VAR = "GLASSRAY_API_KEY";

/** Resolve the org API key or throw a "login first" error. */
const requireOrgKey = (ctx: Context): string => {
  const key = resolveApiKey(ctx.endpoint, ctx.apiKeyOverride);
  if (!key) throw new CliError(`not logged in to ${ctx.endpoint} — run \`glassray login\``);
  return key;
};

/** Default display name for a new source: the repo directory name. */
const defaultDisplayName = (): string => path.basename(process.cwd());

/** `connect otlp` — create a push source and write its ingest key to `.env.local`. */
const connectOtlpCmd = async (ctx: Context, args: string[]): Promise<void> => {
  const { values } = parseCommand(args, { name: { type: "string" } });
  const key = requireOrgKey(ctx);
  const displayName = strFlag(values, "name") ?? defaultDisplayName();

  const spin = spinner(`Setting up trace ingestion for "${displayName}"…`);
  const res = await connectOtlp(ctx.endpoint, key, { displayName });
  spin.succeed(
    res.existing
      ? `Already receiving traces for "${displayName}"`
      : `Ready to receive traces for "${displayName}"`,
  );

  // On an idempotent retry the key can't be re-shown — leave `.env.local` alone.
  const written = res.ingestKey
    ? upsertEnvLocal(process.cwd(), INGEST_KEY_ENV_VAR, res.ingestKey)
    : null;

  if (ctx.json) {
    printData({ ...res, envFile: written?.file ?? null, envVar: INGEST_KEY_ENV_VAR });
    return;
  }
  card([
    `  ${bullet("ok")} Ready to receive your agent's traces`,
    `    ${dim("Send to")}    ${res.endpoint}`,
    written
      ? `    ${dim("Key")}        saved to ${written.file} as ${INGEST_KEY_ENV_VAR}${written.unchanged ? dim(" (unchanged)") : ""}`
      : `    ${dim("Key")}        already set — rotate it in the dashboard if ${INGEST_KEY_ENV_VAR} is missing`,
    ``,
    `  Next: ${link("glassray instrument")} to add tracing to your code, then ${link("glassray verify --wait")}.`,
  ]);
};

/** Assemble a pull-connect request from flags / repo env; validates the provider's required fields. */
const buildPullRequest = (
  provider: PullProvider,
  values: Record<string, string | boolean | (string | boolean)[]>,
): ConnectPullRequest => {
  const fromEnv = boolFlag(values, "keys-from-env") ? readDotenvValues(process.cwd()) : new Map<string, string>();
  const pick = (flag: string, ...envKeys: string[]): string | undefined => {
    const v = strFlag(values, flag);
    if (v !== undefined) return v;
    for (const k of envKeys) {
      const e = fromEnv.get(k);
      if (e) return e;
    }
    return undefined;
  };

  const req: ConnectPullRequest = { provider };
  const name = strFlag(values, "name");
  if (name) req.displayName = name;
  const host = strFlag(values, "host");
  if (host) req.hostUrl = host;

  if (provider === "langsmith") {
    req.apiKey = pick("key", "LANGSMITH_API_KEY", "LANGCHAIN_API_KEY");
    req.projectName = pick("project", "LANGSMITH_PROJECT", "LANGCHAIN_PROJECT");
    if (!req.apiKey) throw new CliError("langsmith needs an API key — pass --key or --keys-from-env");
  } else if (provider === "langfuse") {
    req.publicKey = pick("public-key", "LANGFUSE_PUBLIC_KEY");
    req.secretKey = pick("secret-key", "LANGFUSE_SECRET_KEY");
    if (!req.publicKey || !req.secretKey) {
      throw new CliError("langfuse needs both --public-key and --secret-key (or --keys-from-env)");
    }
  } else {
    req.apiKey = pick("key", "POSTHOG_API_KEY", "POSTHOG_PERSONAL_API_KEY");
    req.projectId = pick("project-id", "POSTHOG_PROJECT_ID");
    if (!req.apiKey) throw new CliError("posthog needs an API key — pass --key or --keys-from-env");
  }
  return req;
};

/** `connect langsmith|langfuse|posthog` — create a pull source, keys go to Vault server-side. */
const connectPullCmd = async (ctx: Context, provider: PullProvider, args: string[]): Promise<void> => {
  const { values } = parseCommand(args, {
    name: { type: "string" },
    host: { type: "string" },
    key: { type: "string" },
    "public-key": { type: "string" },
    "secret-key": { type: "string" },
    project: { type: "string" },
    "project-id": { type: "string" },
    "keys-from-env": { type: "boolean" },
  });
  const orgKey = requireOrgKey(ctx);
  const req = buildPullRequest(provider, values);

  const spin = spinner(`connecting ${provider}…`);
  const res = await connectPull(ctx.endpoint, orgKey, req);
  spin.succeed(
    res.existing
      ? `${provider} already connected (${res.traceSourceId})`
      : `${provider} connected (${res.traceSourceId})`,
  );

  if (ctx.json) {
    printData(res);
    return;
  }
  card([
    `  ${bullet("ok")} ${res.existing ? `Already reading your ${provider} traces` : `Now reading your ${provider} traces`}`,
    `    ${dim("Source")}     ${res.traceSourceId}`,
    `    ${dim("Backfill")}   ${
      res.syncJobIds.length > 0
        ? `pulling recent history (${res.syncJobIds.length} job${res.syncJobIds.length === 1 ? "" : "s"})`
        : res.existing
          ? "already up to date"
          : "none"
    }`,
    ``,
    `  Next: ${link("glassray verify --wait")} to confirm traces are arriving.`,
  ]);
};

/** A browser hand-off integration (github/slack): its deep-link and the status field to watch. */
interface Integration {
  label: string;
  /** Build the consent deep-link from the deployment's app URL. */
  deepLink: (appUrl: string) => string;
  /** Read the connection state from a status payload. */
  read: (status: SetupStatusResponse) => "connected" | "not_connected";
}

/** The two browser-consent integrations. */
const INTEGRATIONS: Record<"github" | "slack", Integration> = {
  github: {
    label: "GitHub",
    deepLink: (appUrl) => `${appUrl}/api/github/connect`,
    read: (s) => s.github,
  },
  slack: {
    label: "Slack",
    deepLink: (appUrl) => `${appUrl}/connect/slack`,
    read: (s) => s.slack,
  },
};

/** `connect github|slack` — open the consent deep-link; `--wait` polls status to connected. */
const connectIntegrationCmd = async (
  ctx: Context,
  which: "github" | "slack",
  args: string[],
): Promise<void> => {
  const { values } = parseCommand(args, {
    wait: { type: "boolean" },
    "no-open": { type: "boolean" },
    timeout: { type: "string" },
  });
  const key = requireOrgKey(ctx);
  const integration = INTEGRATIONS[which];
  const config = await getConfig(ctx.endpoint);
  const url = integration.deepLink(config.appUrl);

  // Already connected? Skip the hand-off.
  const current = await getStatus(ctx.endpoint, key);
  if (integration.read(current) === "connected") {
    if (ctx.json) printData({ integration: which, state: "connected", changed: false });
    else success(`${integration.label} already connected`);
    return;
  }

  if (!boolFlag(values, "no-open")) openBrowser(url);
  info(`→ ${integration.label}: ${link(url)}`);
  detail("approve in the browser (or open that URL on any device)");

  if (!boolFlag(values, "wait")) {
    if (ctx.json) printData({ integration: which, deepLink: url, state: "not_connected" });
    return;
  }

  const timeoutSec = resolveTimeoutSec(values, 180);
  const spin = spinner(`waiting for ${integration.label} to connect…`);
  const result = await pollUntil(
    () => getStatus(ctx.endpoint, key),
    (s) => integration.read(s) === "connected",
    { timeoutSec, onTick: (_s, elapsed) => spin.update(`waiting for ${integration.label}… (${elapsed}s)`) },
  );
  if (result.satisfied) {
    spin.succeed(`${integration.label} connected`);
    if (ctx.json) printData({ integration: which, state: "connected", changed: true });
  } else {
    spin.fail(`${integration.label} not connected within ${timeoutSec}s — re-open ${url} or run \`glassray status\``);
    throw new CliError(`${integration.label} did not connect in time`);
  }
};

/** The `connect` command dispatcher. */
export const cmdConnect = async (ctx: Context, args: string[]): Promise<void> => {
  const target = args[0];
  const rest = args.slice(1);
  switch (target) {
    case "otlp":
      return connectOtlpCmd(ctx, rest);
    case "langsmith":
    case "langfuse":
    case "posthog":
      return connectPullCmd(ctx, target, rest);
    case "github":
    case "slack":
      return connectIntegrationCmd(ctx, target, rest);
    default:
      throw new CliError(
        target === undefined
          ? "usage: glassray connect otlp|langsmith|langfuse|posthog|github|slack"
          : `unknown connect target "${target}" — expected otlp|langsmith|langfuse|posthog|github|slack`,
      );
  }
};
