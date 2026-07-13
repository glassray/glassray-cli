/**
 * The local Coach surface of the umbrella CLI: `start` and the loop verbs
 * (pull / push / run / compare / check / link) delegated to `@glassray/coach`
 * (they need repo-side files — glassray.yaml, fixtures, run recipes), plus the
 * data verbs (traces / stats / usage / flows / evals / deviations / discovery /
 * experiments / fix / runs). The data verbs are thin loopback fetchers ported from
 * `coach/bin/commands.mjs` — command names and semantics are identical, and
 * stdout is the API JSON verbatim (never decorated).
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  "experiments",
  "fix",
  "runs",
]);

/** Loop verbs delegated verbatim to the coach CLI — they read/write repo-side files (glassray.yaml, fixtures dirs, run recipes) the loopback fetchers don't model. */
export const LOCAL_PASSTHROUGH_COMMANDS = new Set(["pull", "push", "run", "compare", "check", "link"]);

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

/** Parse an integer flag (≥ min) or throw. */
const intFlag = (flag: string, value: string, min: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new CliError(`--${flag} must be an integer ≥ ${min} (got: ${value})`);
  return n;
};

/** Parse a 0..1 rate flag or throw. */
const rateFlag = (flag: string, value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new CliError(`--${flag} must be a number between 0 and 1 (got: ${value})`);
  }
  return n;
};

// ── delegation to @glassray/coach (`start` + the loop verbs) ───────────────────

/**
 * Resolve how to invoke the coach CLI: a locally-installed `@glassray/coach`
 * (its bin located via package.json, so the bin's name doesn't matter), else
 * `npx --yes @glassray/coach` (the one heavy, cold-start path).
 */
const coachInvocation = (verbArgs: string[]): { cmd: string; args: string[]; useShell: boolean } => {
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
  if (localBin) return { cmd: process.execPath, args: [localBin, ...verbArgs], useShell: false };
  // The `npx` fallback is a `.cmd` shim on Windows, which Node can't exec without
  // a shell; the localBin path runs node directly and never needs one.
  return { cmd: "npx", args: ["--yes", "@glassray/coach", ...verbArgs], useShell: process.platform === "win32" };
};

/**
 * `glassray start` — run the local Coach server. Prefers a locally-installed
 * `@glassray/coach`; falls back to `npx --yes @glassray/coach start`.
 */
export const cmdStart = async (ctx: Context, args: string[]): Promise<void> => {
  // Pass through the port and any extra flags (already in `args`).
  const passthrough = [...args];
  if (!passthrough.includes("--port")) passthrough.push("--port", String(ctx.port));
  const { cmd, args: spawnArgs, useShell } = coachInvocation(["start", ...passthrough]);

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

/**
 * The loop verbs (`pull` / `push` / `run` / `compare` / `check` / `link`),
 * handed to the coach CLI verbatim. They keep the caller's cwd (glassray.yaml,
 * fixtures dirs, run recipes are repo-relative) and the port travels as
 * `GLASSRAY_PORT`. Coach prints its own data/errors; only its exit code is
 * propagated — no second error line on top.
 */
export const runCoachPassthrough = async (command: string, ctx: Context, args: string[]): Promise<void> => {
  const { cmd, args: spawnArgs, useShell } = coachInvocation([command, ...args]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, spawnArgs, {
      stdio: "inherit",
      shell: useShell,
      env: { ...process.env, GLASSRAY_PORT: String(ctx.port) },
    });
    child.on("error", (err) =>
      reject(new CliError(`could not run the coach CLI (${err.message}) — is npx available?`, 2)),
    );
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) process.exitCode = code;
      resolve();
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
      label: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
    });
    const query = toQuery({
      q: strFlag(values, "q"),
      agent: strFlag(values, "agent"),
      status: strFlag(values, "status"),
      flow: strFlag(values, "flow"),
      label: strFlag(values, "label"),
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
      // Discover flows FROM CODE: resolve the repo root to scan from --code-root
      // or the artifact file's `codeRoot`, make it absolute, and hand it to the
      // server (which otherwise falls back to its own launch cwd, or 400s).
      const { values } = parseCommand(rest, {
        "code-root": { type: "string" },
        file: { type: "string" },
        ...WAIT_FLAGS,
      });
      const body: Record<string, unknown> = {};
      const codeRoot = strFlag(values, "code-root");
      if (codeRoot !== undefined) {
        body.codeRoot = path.resolve(codeRoot);
      } else {
        // An explicitly named --file must exist and parse; the implicit default
        // is best-effort (a repo without glassray.yaml is fine).
        const explicitFile = strFlag(values, "file");
        const file = explicitFile ?? "glassray.yaml";
        const text = await readFile(file, "utf8").catch((err: unknown) => {
          if (explicitFile === undefined) return null;
          const message = err instanceof Error ? err.message : String(err);
          throw new CliError(`could not read --file ${file}: ${message}`);
        });
        if (text !== null) {
          try {
            const parsed = await loopbackPost(ctx.port, "/api/artifact/parse", { yaml: text });
            const artifact = parsed.artifact as { codeRoot?: string } | undefined;
            if (artifact?.codeRoot) body.codeRoot = path.resolve(path.dirname(file), artifact.codeRoot);
          } catch (err) {
            if (explicitFile !== undefined) throw err;
            // Fall through with no codeRoot — the server resolves from its own
            // cwd, or returns a helpful 400 telling the user to set codeRoot.
          }
        }
      }
      return enqueueAndWait(ctx.port, "/api/flows/run", body, waitOpts(values));
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
        name: { type: "string" },
        text: { type: "string" },
        description: { type: "string" },
        "source-file": { type: "string" },
        threshold: { type: "string" },
        judge: { type: "string" },
        "autorun-threshold": { type: "string" },
      });
      const body: Record<string, unknown> = {};
      const deviation = strFlag(values, "deviation");
      if (deviation !== undefined) {
        if (
          strFlag(values, "name") !== undefined ||
          strFlag(values, "text") !== undefined ||
          strFlag(values, "description") !== undefined ||
          strFlag(values, "source-file") !== undefined ||
          strFlag(values, "threshold") !== undefined ||
          strFlag(values, "judge") !== undefined ||
          strFlag(values, "autorun-threshold") !== undefined
        ) {
          throw new CliError("--deviation only combines with --flow (the deviation supplies the name/text)");
        }
        body.deviationId = deviation;
      } else {
        const name = strFlag(values, "name");
        const text = strFlag(values, "text");
        if (name === undefined || text === undefined) {
          throw new CliError("create needs --deviation <id>, or both --name and --text");
        }
        body.name = name;
        body.text = text;
        if (strFlag(values, "description") !== undefined) body.description = strFlag(values, "description");
        // A --source-file path becomes the rule's single code anchor (source: 'code').
        const sourceFile = strFlag(values, "source-file");
        if (sourceFile !== undefined) body.anchors = [{ file: sourceFile }];
        const threshold = strFlag(values, "threshold");
        if (threshold !== undefined) body.threshold = rateFlag("threshold", threshold);
        if (strFlag(values, "judge") !== undefined) body.judgeModel = strFlag(values, "judge");
        const autorunThreshold = strFlag(values, "autorun-threshold");
        if (autorunThreshold !== undefined) body.autorunThreshold = intFlag("autorun-threshold", autorunThreshold, 1);
      }
      if (strFlag(values, "flow") !== undefined) body.flowId = strFlag(values, "flow");
      return printJson(await loopbackPost(ctx.port, "/api/evals", body));
    }
    case "update": {
      const { values, positionals } = parseCommand(rest, {
        flow: { type: "string" },
        "no-flow": { type: "boolean" },
        "source-file": { type: "string" },
        "no-source-file": { type: "boolean" },
        threshold: { type: "string" },
        "no-threshold": { type: "boolean" },
        judge: { type: "string" },
        "no-judge": { type: "boolean" },
        "autorun-threshold": { type: "string" },
      });
      const id = requireId(positionals);
      if (strFlag(values, "flow") !== undefined && boolFlag(values, "no-flow")) {
        throw new CliError("pass either --flow or --no-flow, not both");
      }
      if (strFlag(values, "source-file") !== undefined && boolFlag(values, "no-source-file")) {
        throw new CliError("pass either --source-file or --no-source-file, not both");
      }
      if (strFlag(values, "threshold") !== undefined && boolFlag(values, "no-threshold")) {
        throw new CliError("pass either --threshold or --no-threshold, not both");
      }
      if (strFlag(values, "judge") !== undefined && boolFlag(values, "no-judge")) {
        throw new CliError("pass either --judge or --no-judge, not both");
      }
      const body: Record<string, unknown> = {};
      if (strFlag(values, "flow") !== undefined) body.flowId = strFlag(values, "flow");
      if (boolFlag(values, "no-flow")) body.flowId = null;
      const sourceFile = strFlag(values, "source-file");
      if (sourceFile !== undefined) body.anchors = [{ file: sourceFile }];
      if (boolFlag(values, "no-source-file")) body.anchors = null;
      const threshold = strFlag(values, "threshold");
      if (threshold !== undefined) body.threshold = rateFlag("threshold", threshold);
      if (boolFlag(values, "no-threshold")) body.threshold = null;
      if (strFlag(values, "judge") !== undefined) body.judgeModel = strFlag(values, "judge");
      if (boolFlag(values, "no-judge")) body.judgeModel = null;
      const autorunThreshold = strFlag(values, "autorun-threshold");
      if (autorunThreshold !== undefined) body.autorunThreshold = intFlag("autorun-threshold", autorunThreshold, 1);
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

/**
 * The discovery-run action: cluster recent traces into recurring failures
 * (deviations). Shared by the canonical `deviations discover` and its kept
 * `discovery run` alias — identical flags (--sample, --flow, --no-wait,
 * --timeout), the same `/api/discovery/run` enqueue, no behavior difference.
 */
const runDiscovery = async (ctx: Context, args: string[]): Promise<void> => {
  const { values } = parseCommand(args, { sample: { type: "string" }, flow: { type: "string" }, ...WAIT_FLAGS });
  const body: Record<string, unknown> = {};
  if (strFlag(values, "sample") !== undefined) body.sampleSize = Number(strFlag(values, "sample"));
  if (strFlag(values, "flow") !== undefined) body.flowId = strFlag(values, "flow");
  return enqueueAndWait(ctx.port, "/api/discovery/run", body, waitOpts(values));
};

/** `deviations list|get|discover|resolve`. */
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
    case "discover":
      // The canonical spelling of the discovery-run action; `discovery run` aliases it.
      return runDiscovery(ctx, rest);
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

/** `discovery run` — kept alias of the canonical `deviations discover`. */
const cmdDiscovery = async (ctx: Context, args: string[]): Promise<void> => {
  const verb = args[0];
  if (verb !== "run") throw new CliError(verb === undefined ? "missing verb (run)" : `unknown discovery verb "${verb}"`);
  return runDiscovery(ctx, args.slice(1));
};

/**
 * `experiments list [--flow <id>]|get <id>` — read-only view of the durable
 * compare experiments (GET /api/experiments[?flowId=…] and
 * /api/experiments/:id). Deliberately list/get only, matching
 * `coach/bin/commands.mjs`; the write endpoints (create / report) are not
 * surfaced here.
 */
const cmdExperiments = async (ctx: Context, args: string[]): Promise<void> => {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "list": {
      // The endpoint takes an optional `flowId` scope; surface it as `--flow`.
      const { values } = parseCommand(rest, { flow: { type: "string" } });
      return printJson(await loopbackApi(ctx.port, `/api/experiments${toQuery({ flowId: strFlag(values, "flow") })}`));
    }
    case "get": {
      const { positionals } = parseCommand(rest);
      return printJson(await loopbackApi(ctx.port, `/api/experiments/${encodeURIComponent(requireId(positionals))}`));
    }
    default:
      throw new CliError(verb === undefined ? "missing experiments verb" : `unknown experiments verb "${verb}"`);
  }
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
    case "experiments":
      return cmdExperiments(ctx, args);
    case "fix":
      return cmdFix(ctx, args);
    case "runs":
      return cmdRuns(ctx, args);
    default:
      throw new CliError(`unknown local command "${command}"`);
  }
};
