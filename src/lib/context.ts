/**
 * Shared argument-parsing scaffolding. Global flags (`--json`, `--endpoint`,
 * `--debug`, `--no-telemetry`, `--api-key`, `--port`) may appear anywhere, so
 * each command folds `GLOBAL_OPTIONS` into its own `parseArgs` options and reads
 * the resolved `Context` for the cross-cutting settings.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolveEndpoint } from "./config.js";
import { CliError } from "./errors.js";

/** parseArgs option definitions for the flags every command accepts. */
export const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  endpoint: { type: "string" },
  debug: { type: "boolean" },
  "no-telemetry": { type: "boolean" },
  "api-key": { type: "string" },
  port: { type: "string" },
} as const satisfies ParseArgsConfig["options"];

/** Cross-cutting settings resolved once from the global flags + environment. */
export interface Context {
  /** Resolved Glassray base URL. */
  endpoint: string;
  /** Whether `--json` machine output is requested. */
  json: boolean;
  /** Whether `--debug` (stack traces, verbose) is on. */
  debug: boolean;
  /** Whether run-telemetry may be sent (false under `--no-telemetry` / env opt-out). */
  telemetry: boolean;
  /** An explicit `--api-key` override — wins over the `GLASSRAY_TOKEN` env var and the stored key. */
  apiKeyOverride: string | undefined;
  /** Local Coach port (`--port` > `GLASSRAY_PORT` > 5899). */
  port: number;
}

/** Values shape produced by a global parse. */
type GlobalValues = Partial<Record<keyof typeof GLOBAL_OPTIONS, string | boolean>>;

/** Resolve the local Coach port: `--port` > `GLASSRAY_PORT` > 5899. */
const resolvePort = (flag: string | boolean | undefined): number => {
  const raw = typeof flag === "string" ? flag : (process.env.GLASSRAY_PORT ?? "");
  if (raw === "") return 5899;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) {
    throw new CliError(`invalid --port ${raw}`);
  }
  return port;
};

/** Build the cross-cutting `Context` from parsed global flag values. */
export const buildContext = (values: GlobalValues): Context => ({
  endpoint: resolveEndpoint(typeof values.endpoint === "string" ? values.endpoint : undefined),
  json: values.json === true,
  debug: values.debug === true,
  telemetry: values["no-telemetry"] !== true && !process.env.GLASSRAY_NO_TELEMETRY,
  apiKeyOverride: typeof values["api-key"] === "string" ? values["api-key"] : undefined,
  port: resolvePort(values.port),
});

/** Strictly parse one command's args (global flags merged in); a bad flag becomes a `CliError`. */
export const parseCommand = (
  args: string[],
  options: ParseArgsConfig["options"] = {},
): { values: Record<string, string | boolean | (string | boolean)[]>; positionals: string[] } => {
  try {
    const parsed = parseArgs({
      args,
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: true,
    });
    return {
      values: parsed.values as Record<string, string | boolean | (string | boolean)[]>,
      positionals: parsed.positionals,
    };
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
};

/** Read a string flag value (undefined when unset or boolean). */
export const strFlag = (
  values: Record<string, string | boolean | (string | boolean)[]>,
  name: string,
): string | undefined => {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
};

/** Read a boolean flag value (true only when explicitly set). */
export const boolFlag = (
  values: Record<string, string | boolean | (string | boolean)[]>,
  name: string,
): boolean => values[name] === true;

/**
 * Resolve the `--timeout` flag (in seconds) to a positive, finite number. A
 * non-numeric value (e.g. `--timeout 3m`) is a `CliError` rather than a silent
 * `NaN` — an unvalidated `NaN` deadline makes every poll loop compare false and
 * wait forever.
 */
export const resolveTimeoutSec = (
  values: Record<string, string | boolean | (string | boolean)[]>,
  defaultSec: number,
): number => {
  const raw = strFlag(values, "timeout");
  if (raw === undefined) return defaultSec;
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new CliError(`invalid --timeout ${raw} — expected a positive number of seconds`);
  }
  return sec;
};
