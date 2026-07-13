/**
 * `glassray connect <target>` — wire a trace source (the advanced/CI path;
 * `glassray setup` does this for you):
 *   otlp                          push source (SDK/OTLP); writes the ingest key to .env.local
 *   langsmith | langfuse | posthog  pull source (provider keys → Vault, server-side)
 *
 * All hit the REST API with the org key. GitHub and Slack are connected in the
 * browser onboarding wizard (v3), not here.
 */
import path from "node:path";
import { resolveApiKey } from "../lib/config.js";
import { boolFlag, parseCommand, strFlag, type Context } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { detectEnvFile, readDotenvValues, upsertEnvFile } from "../lib/env-file.js";
import { connectOtlp, connectPull } from "../lib/http.js";
import type { ConnectPullRequest, PullProvider } from "../lib/types.js";
import { bullet, card, dim, link, printData, spinner } from "../lib/ui.js";

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

  // On an idempotent retry the key can't be re-shown — leave the env file alone.
  const written = res.ingestKey
    ? upsertEnvFile(process.cwd(), INGEST_KEY_ENV_VAR, res.ingestKey, detectEnvFile(process.cwd()))
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
    default:
      throw new CliError(
        target === undefined
          ? "usage: glassray connect otlp|langsmith|langfuse|posthog"
          : `unknown connect target "${target}" — expected otlp|langsmith|langfuse|posthog (GitHub / Slack are connected in the setup wizard)`,
      );
  }
};
