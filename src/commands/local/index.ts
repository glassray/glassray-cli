/**
 * The local Coach surface of the umbrella CLI: `start` (the one lazy-heavy path,
 * delegated to `@glassray/coach`) plus the data verbs (traces / stats / usage /
 * flows / evals / deviations / discovery / fix / runs). The verbs are thin
 * loopback fetchers ported from `coach/bin/commands.mjs` — command names and
 * semantics are identical, and stdout is the API JSON verbatim (never decorated).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { boolFlag, parseCommand, resolveTimeoutSec, strFlag, type Context } from "../../lib/context.js";
import { CliError } from "../../lib/errors.js";
import {
  DEFAULT_TIMEOUT_SEC,
  enqueueAndWait,
  loopbackApi,
  loopbackDelete,
  loopbackPatch,
  loopbackPost,
  printJson,
  tailTraces,
  type WaitOptions,
} from "../../lib/loopback.js";

/** Data-verb command words this module serves. */
export const LOCAL_DATA_COMMANDS = new Set([
  "traces",
  "stats",
  "usage",
  "flows",
  "evals",
  "deviations",
  "discovery",
  "fix",
  "runs",
]);

/** Options every waiting verb accepts. */
const WAIT_FLAGS = { "no-wait": { type: "boolean" }, timeout: { type: "string" } } as const;

/** Parsed values shape. */
type Values = Record<string, string | boolean | (string | boolean)[]>;

/** Resolve the shared wait flags into a concrete budget. */
const waitOpts = (values: Values): WaitOptions => ({
  noWait: boolFlag(values, "no-wait"),
  timeoutSec: resolveTimeoutSec(values, DEFAULT_TIMEOUT_SEC),
});

/** Build a query string from the defined entries only. */
const toQuery = (entries: Record<string, string | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs === "" ? "" : `?${qs}`;
};

/** Require an id positional or throw a usage error. */
const requireId = (positionals: string[], what = "<id>"): string => {
  const id = positionals[0];
  if (id === undefined) throw new CliError(`missing ${what}`);
  return id;
};

/** Parse a JSON-valued flag (e.g. --selector '{"agent":"x"}') or throw. */
const parseJsonFlag = (flag: string, value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new CliError(`--${flag} must be valid JSON (got: ${value})`);
  }
};

// ── start (delegated to @glassray/coach) ───────────────────────────────────────

/**
 * `glassray start` — run the local Coach server. Prefers a locally-installed
 * `@glassray/coach`; falls back to `npx --yes @glassray/coach start`. This is the
 * ONE heavy path (npx cold-starts the coach package on demand).
 */
export const cmdStart = async (ctx: Context, args: string[]): Promise<void> => {
  // Pass through the port and any extra flags (already in `args`).
  const passthrough = [...args];
  if (!passthrough.includes("--port")) passthrough.push("--port", String(ctx.port));

  const require = createRequire(import.meta.url);
  let localBin: string | null = null;
  try {
    const pkgJsonPath = require.resolve("@glassray/coach/package.json");
    const pkg = require("@glassray/coach/package.json") as { bin?: string | Record<string, string> };
    const binField = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    if (binField) localBin = path.join(path.dirname(pkgJsonPath), binField);
  } catch {
    localBin = null;
  }

  const [cmd, spawnArgs] = localBin
    ? [process.execPath, [localBin, "start", ...passthrough]]
    : ["npx", ["--yes", "@glassray/coach", "start", ...passthrough]];

  // The `npx` fallback is a `.cmd` shim on Windows, which Node can't exec without
  // a shell; the localBin path runs node directly and never needs one.
  const useShell = !localBin && process.platform === "win32";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, spawnArgs, { stdio: "inherit", shell: useShell });
    child.on("error", (err) =>
      reject(new CliError(`could not start Coach (${err.message}) — is npx available?`, 2)),
    );
    child.on("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new CliError(`Coach exited with code ${code}`, code ?? 1));
    });
  });
};

// ── data verbs ─────────────────────────────────────────────────────────────────

/** `traces list|get <id>|tail`. */
const cmdTraces = async (ctx: Context, args: string[]): Promise<void> => {
  const verb = args[0];
  const rest = args.slice(1);
  if (verb === "list") {
    const { values } = parseCommand(rest, {
      q: { type: "string" },
      agent: { type: "string" },
      status: { type: "string" },
      flow: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
    });
    const query = toQuery({
      q: strFlag(values, "q"),
      agent: strFlag(values, "agent"),
      status: strFlag(values, "status"),
      flow: strFlag(values, "flow"),
      limit: strFlag(values, "limit"),
      offset: strFlag(values, "offset"),
    });
    return printJson(await loopbackApi(ctx.port, `/api/traces${query}`));
  }
  if (verb === "get") {
    const { positionals } = parseCommand(rest);
    return printJson(await loopbackApi(ctx.port, `/api/traces/${encodeURIComponent(requireId(positionals))}`));
  }
  if (verb === "tail") return tailTraces(ctx.port);
  throw new CliError(verb === undefined ? "missing verb (list|get|tail)" : `unknown traces verb "${verb}"`);
};

/** `stats`. */
const cmdStats = async (ctx: Context): Promise<void> => printJson(await loopbackApi(ctx.port, "/api/stats"));

/** `usage`. */
const cmdUsage = async (ctx: Context): Promise<void> => printJson(await loopbackApi(ctx.port, "/api/usage"));

/** `flows list|get|create|update|delete|audit|discover`. */
const cmdFlows = async (ctx: Context, args: string[]): Promise<void> => {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "list": {
      const { values } = parseCommand(rest, { status: { type: "string" } });
      return printJson(await loopbackApi(ctx.port, `/api/flows${toQuery({ status: strFlag(values, "status") })}`));
    }
    case "get": {
      const { positionals } = parseCommand(rest);
      return printJson(await loopbackApi(ctx.port, `/api/flows/${encodeURIComponent(requireId(positionals))}`));
    }
    case "create": {
      const { values } = parseCommand(rest, {
        name: { type: "string" },
        description: { type: "string" },
        rule: { type: "string" },
        classify: { type: "string" },
        selector: { type: "string" },
        "created-by": { type: "string" },
      });
      const name = strFlag(values, "name");
      if (name === undefined) throw new CliError("create requires --name");
      const body: Record<string, unknown> = { name };
      if (strFlag(values, "description") !== undefined) body.description = strFlag(values, "description");
      if (strFlag(values, "rule") !== undefined) body.rule = strFlag(values, "rule");
      if (strFlag(values, "classify") !== undefined) body.classify = strFlag(values, "classify");
      const selector = strFlag(values, "selector");
      if (selector !== undefined) body.selector = parseJsonFlag("selector", selector);
      if (strFlag(values, "created-by") !== undefined) body.createdBy = strFlag(values, "created-by");
      return printJson(await loopbackPost(ctx.port, "/api/flows", body));
    }
    case "update": {
      const { values, positionals } = parseCommand(rest, {
        name: { type: "string" },
        description: { type: "string" },
        rule: { type: "string" },
        "no-rule": { type: "boolean" },
        classify: { type: "string" },
        selector: { type: "string" },
        "no-selector": { type: "boolean" },
        status: { type: "string" },
      });
      const id = requireId(positionals);
      const body: Record<string, unknown> = {};
      if (strFlag(values, "name") !== undefined) body.name = strFlag(values, "name");
      if (strFlag(values, "description") !== undefined) body.description = strFlag(values, "description");
      if (strFlag(values, "rule") !== undefined) body.rule = strFlag(values, "rule");
      if (boolFlag(values, "no-rule")) body.rule = null;
      if (strFlag(values, "classify") !== undefined) body.classify = strFlag(values, "classify");
      const selector = strFlag(values, "selector");
      if (selector !== undefined) body.selector = parseJsonFlag("selector", selector);
      if (boolFlag(values, "no-selector")) body.selector = null;
      if (strFlag(values, "status") !== undefined) body.status = strFlag(values, "status");
      return printJson(await loopbackPatch(ctx.port, `/api/flows/${encodeURIComponent(id)}`, body));
    }
    case "delete": {
      const { positionals } = parseCommand(rest);
      return printJson(await loopbackDelete(ctx.port, `/api/flows/${encodeURIComponent(requireId(positionals))}`));
    }
    case "audit": {
      const { positionals } = parseCommand(rest);
      return printJson(await loopbackApi(ctx.port, `/api/flows/${encodeURIComponent(requireId(positionals))}/audit`));
    }
    case "discover": {
      const { values } = parseCommand(rest, WAIT_FLAGS);
      return enqueueAndWait(ctx.port, "/api/flows/run", {}, waitOpts(values));
    }
    default:
      throw new CliError(verb === undefined ? "missing flows verb" : `unknown flows verb "${verb}"`);
  }
};

/** `evals list|get|create|update|run|delete`. */
const cmdEvals = async (ctx: Context, args: string[]): Promise<void> => {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "list":
      return printJson(await loopbackApi(ctx.port, "/api/evals"));
    case "get": {
      const { positionals } = parseCommand(rest);
      return printJson(await loopbackApi(ctx.port, `/api/evals/${encodeURIComponent(requireId(positionals))}`));
    }
    case "create": {
      const { values } = parseCommand(rest, {
        deviation: { type: "string" },
        flow: { type: "string" },
        label: { type: "string" },
        rule: { type: "string" },
        description: { type: "string" },
        "no-autorun": { type: "boolean" },
        "autorun-threshold": { type: "string" },
      });
      const body: Record<string, unknown> = {};
      const deviation = strFlag(values, "deviation");
      if (deviation !== undefined) {
        body.deviationId = deviation;
      } else {
        const label = strFlag(values, "label");
        const rule = strFlag(values, "rule");
        if (label === undefined || rule === undefined) {
          throw new CliError("create needs --deviation <id>, or both --label and --rule");
        }
        body.label = label;
        body.rule = rule;
        if (strFlag(values, "description") !== undefined) body.description = strFlag(values, "description");
        if (boolFlag(values, "no-autorun")) body.autorun = false;
        const threshold = strFlag(values, "autorun-threshold");
        if (threshold !== undefined) body.autorunThreshold = Number(threshold);
      }
      if (strFlag(values, "flow") !== undefined) body.flowId = strFlag(values, "flow");
      return printJson(await loopbackPost(ctx.port, "/api/evals", body));
    }
    case "update": {
      const { values, positionals } = parseCommand(rest, {
        flow: { type: "string" },
        "no-flow": { type: "boolean" },
        autorun: { type: "boolean" },
        "no-autorun": { type: "boolean" },
        "autorun-threshold": { type: "string" },
      });
      const id = requireId(positionals);
      const body: Record<string, unknown> = {};
      if (strFlag(values, "flow") !== undefined) body.flowId = strFlag(values, "flow");
      if (boolFlag(values, "no-flow")) body.flowId = null;
      if (boolFlag(values, "autorun")) body.autorun = true;
      if (boolFlag(values, "no-autorun")) body.autorun = false;
      const threshold = strFlag(values, "autorun-threshold");
      if (threshold !== undefined) body.autorunThreshold = Number(threshold);
      return printJson(await loopbackPatch(ctx.port, `/api/evals/${encodeURIComponent(id)}`, body));
    }
    case "run": {
      const { values, positionals } = parseCommand(rest, {
        sample: { type: "string" },
        model: { type: "string" },
        ...WAIT_FLAGS,
      });
      const id = requireId(positionals);
      const body: Record<string, unknown> = {};
      if (strFlag(values, "sample") !== undefined) body.sampleSize = Number(strFlag(values, "sample"));
      if (strFlag(values, "model") !== undefined) body.model = strFlag(values, "model");
      return enqueueAndWait(ctx.port, `/api/evals/${encodeURIComponent(id)}/run`, body, waitOpts(values), () =>
        loopbackApi(ctx.port, `/api/evals/${encodeURIComponent(id)}`),
      );
    }
    case "delete": {
      const { positionals } = parseCommand(rest);
      return printJson(await loopbackDelete(ctx.port, `/api/evals/${encodeURIComponent(requireId(positionals))}`));
    }
    default:
      throw new CliError(verb === undefined ? "missing evals verb" : `unknown evals verb "${verb}"`);
  }
};

/** `deviations list|get|resolve`. */
const cmdDeviations = async (ctx: Context, args: string[]): Promise<void> => {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "list":
      return printJson(await loopbackApi(ctx.port, "/api/deviations"));
    case "get": {
      const { positionals } = parseCommand(rest);
      return printJson(await loopbackApi(ctx.port, `/api/deviations/${encodeURIComponent(requireId(positionals))}`));
    }
    case "resolve": {
      const { values, positionals } = parseCommand(rest, { reopen: { type: "boolean" } });
      const id = requireId(positionals);
      const action = boolFlag(values, "reopen") ? "reopen" : "resolve";
      return printJson(await loopbackPost(ctx.port, `/api/deviations/${encodeURIComponent(id)}/${action}`));
    }
    default:
      throw new CliError(verb === undefined ? "missing deviations verb" : `unknown deviations verb "${verb}"`);
  }
};

/** `discovery run`. */
const cmdDiscovery = async (ctx: Context, args: string[]): Promise<void> => {
  const verb = args[0];
  if (verb !== "run") throw new CliError(verb === undefined ? "missing verb (run)" : `unknown discovery verb "${verb}"`);
  const { values } = parseCommand(args.slice(1), { sample: { type: "string" }, flow: { type: "string" }, ...WAIT_FLAGS });
  const body: Record<string, unknown> = {};
  if (strFlag(values, "sample") !== undefined) body.sampleSize = Number(strFlag(values, "sample"));
  if (strFlag(values, "flow") !== undefined) body.flowId = strFlag(values, "flow");
  return enqueueAndWait(ctx.port, "/api/discovery/run", body, waitOpts(values));
};

/** `fix <deviationId>`. */
const cmdFix = async (ctx: Context, args: string[]): Promise<void> => {
  const { values, positionals } = parseCommand(args, WAIT_FLAGS);
  const id = requireId(positionals, "<deviationId>");
  return enqueueAndWait(ctx.port, `/api/deviations/${encodeURIComponent(id)}/fix`, {}, waitOpts(values), () =>
    loopbackApi(ctx.port, `/api/deviations/${encodeURIComponent(id)}`),
  );
};

/** `runs list|get|cancel`. */
const cmdRuns = async (ctx: Context, args: string[]): Promise<void> => {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "list": {
      const { values } = parseCommand(rest, { limit: { type: "string" } });
      return printJson(await loopbackApi(ctx.port, `/api/runs${toQuery({ limit: strFlag(values, "limit") })}`));
    }
    case "get": {
      const { positionals } = parseCommand(rest);
      return printJson(await loopbackApi(ctx.port, `/api/runs/${encodeURIComponent(requireId(positionals))}`));
    }
    case "cancel": {
      const { positionals } = parseCommand(rest);
      return printJson(await loopbackPost(ctx.port, `/api/runs/${encodeURIComponent(requireId(positionals))}/cancel`));
    }
    default:
      throw new CliError(verb === undefined ? "missing runs verb" : `unknown runs verb "${verb}"`);
  }
};

/** Dispatch a local data verb by command word. */
export const runLocalData = async (command: string, ctx: Context, args: string[]): Promise<void> => {
  switch (command) {
    case "traces":
      return cmdTraces(ctx, args);
    case "stats":
      return cmdStats(ctx);
    case "usage":
      return cmdUsage(ctx);
    case "flows":
      return cmdFlows(ctx, args);
    case "evals":
      return cmdEvals(ctx, args);
    case "deviations":
      return cmdDeviations(ctx, args);
    case "discovery":
      return cmdDiscovery(ctx, args);
    case "fix":
      return cmdFix(ctx, args);
    case "runs":
      return cmdRuns(ctx, args);
    default:
      throw new CliError(`unknown local command "${command}"`);
  }
};
