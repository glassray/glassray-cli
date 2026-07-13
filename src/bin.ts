#!/usr/bin/env node
/**
 * `glassray` — the umbrella CLI entry point. Locates the command word + global
 * flags with a lenient first pass (globals may sit anywhere), builds the shared
 * `Context`, and dispatches. stdout = data (JSON / cards); stderr = status.
 * Exit codes: 0 ok · 1 handled failure · 2 a dependency was unreachable.
 */
import { parseArgs } from "node:util";
import { buildContext, GLOBAL_OPTIONS } from "./lib/context.js";
import { CliError, EXIT } from "./lib/errors.js";
import { errorLine, setJsonMode, VERSION } from "./lib/ui.js";
import { cmdConnect } from "./commands/connect.js";
import { cmdDetect } from "./commands/detect.js";
import { cmdDoctor } from "./commands/doctor.js";
import { showLanding } from "./commands/help.js";
import { cmdInit } from "./commands/init.js";
import { cmdInstrument } from "./commands/instrument.js";
import { cmdLogin } from "./commands/login.js";
import { cmdLogout } from "./commands/logout.js";
import { cmdMcp } from "./commands/mcp.js";
import { cmdSetup } from "./commands/setup.js";
import { cmdStatus } from "./commands/status.js";
import { cmdToken } from "./commands/token.js";
import { cmdUpgrade } from "./commands/upgrade.js";
import { cmdVerify } from "./commands/verify.js";
import { cmdWhoami } from "./commands/whoami.js";
import { cmdStart, LOCAL_DATA_COMMANDS, runLocalData } from "./commands/local/index.js";
import type { Context } from "./lib/context.js";

// A consumer closing the pipe (`| head`, `| jq -e`) is a normal end of output.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err?.code === "EPIPE") process.exit(0);
  throw err;
});

/** A cloud/manage command handler: takes the resolved context + the args after the command word. */
type Handler = (ctx: Context, args: string[]) => Promise<void>;

/** Dispatch table for the non-local commands. */
const HANDLERS: Record<string, Handler> = {
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  setup: cmdSetup,
  detect: cmdDetect,
  connect: cmdConnect,
  instrument: cmdInstrument,
  verify: cmdVerify,
  status: cmdStatus,
  token: cmdToken,
  init: cmdInit,
  mcp: cmdMcp,
  doctor: cmdDoctor,
  upgrade: cmdUpgrade,
};

/** Value-taking global flags — used to find the command word past their values. */
const VALUE_GLOBALS = new Set(["--endpoint", "--api-key", "--port"]);

/** Locate the command word: the first token that isn't a flag or a value-flag's value. */
const findCommandIndex = (argv: string[]): number => {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (VALUE_GLOBALS.has(arg)) {
      i += 1; // skip the flag's value
      continue;
    }
    if (arg.startsWith("-")) continue; // boolean flag or --flag=value
    return i;
  }
  return -1;
};

/** Run the CLI. Resolves normally on success; throws `CliError` on a handled failure. */
const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);

  // Lenient first pass: find the command + read the global flags (tolerate the rest).
  const probe = parseArgs({
    args: argv,
    options: { ...GLOBAL_OPTIONS, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "V" } },
    allowPositionals: true,
    strict: false,
  });

  if (probe.values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const commandIndex = findCommandIndex(argv);
  const command = commandIndex >= 0 ? argv[commandIndex] : undefined;

  // Bare command, the `help` word, and `--help`/-h anywhere → the landing screen
  // (the CLI's global help). Keeps `glassray <cmd> --help` from erroring.
  if (command === undefined || command === "help" || probe.values.help === true) {
    showLanding();
    return;
  }

  setJsonMode(probe.values.json === true);
  const ctx = buildContext(probe.values);
  const rest = argv.slice(commandIndex + 1);

  if (command === "start") {
    await cmdStart(ctx, rest);
    return;
  }
  if (LOCAL_DATA_COMMANDS.has(command)) {
    await runLocalData(command, ctx, rest);
    return;
  }
  const handler = HANDLERS[command];
  if (!handler) {
    throw new CliError(`unknown command "${command}" — run \`glassray --help\``);
  }
  await handler(ctx, rest);
};

main().then(
  () => {
    // Success — let the event loop drain (detached update-check child is unref'd).
  },
  (err: unknown) => {
    if (err instanceof CliError) {
      errorLine(err.message);
      process.exitCode = err.exitCode;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    errorLine(message);
    if (process.argv.includes("--debug") && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = EXIT.FAILURE;
  },
);
