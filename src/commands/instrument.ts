/**
 * `glassray instrument` — the seam between deterministic and semantic setup.
 * Builds a scoped prompt (add the tracing SDK + the four metadata tags). By
 * default it does NOT auto-run anything: it shows the prompt (copied to your
 * clipboard) so you can run it in whatever coding agent you like, and — when the
 * `claude` binary is present — offers to run it for you. `--run` skips the
 * question and runs Claude Code; `--prompt-only` always just prints.
 */
import { parseCommand, strFlag, boolFlag, type Context } from "../lib/context.js";
import { hasClaude, runClaude } from "../lib/claude-runner.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { detect } from "../lib/detect.js";
import { CliError } from "../lib/errors.js";
import { getConfig } from "../lib/http.js";
import { buildInstrumentPrompt } from "../lib/instrument-prompt.js";
import { confirm } from "../lib/prompt.js";
import { INGEST_KEY_ENV_VAR } from "../lib/env-file.js";
import { detail, dim, info, printData, success, warn } from "../lib/ui.js";

/** Resolve the OTLP endpoint: `--otlp-endpoint` > `${appUrl}/api/public/otel/v1/traces`. */
const resolveOtlpEndpoint = async (ctx: Context, flag: string | undefined): Promise<string> => {
  if (flag) return flag;
  const config = await getConfig(ctx.endpoint);
  return `${config.appUrl.replace(/\/+$/, "")}/api/public/otel/v1/traces`;
};

/** Show the prompt: copy it to the clipboard (best-effort) and print it to stdout for pasting. */
const showPrompt = (prompt: string, json: boolean): void => {
  const copied = process.stdout.isTTY ? copyToClipboard(prompt) : false;
  if (json) {
    printData({ mode: "prompt", copiedToClipboard: copied, prompt });
    return;
  }
  info(
    copied
      ? "Copied the prompt to your clipboard — paste it into your coding agent to add tracing:"
      : "Paste this prompt into your coding agent to add tracing:",
  );
  // The prompt is the deliverable — stdout, verbatim, so it can be piped/copied.
  process.stdout.write(`\n${prompt}\n\n`);
  detail("then re-run `glassray verify --wait` to confirm traces are arriving");
};

/**
 * Hand the prompt to the local `claude` binary. Claude Code runs HEADLESSLY — it
 * applies the change and exits, returning control here (no getting stuck inside
 * an interactive Claude session). Its work streams to the terminal, so there's
 * no spinner to fight the output. Throws on a non-zero exit so the process
 * surfaces the failure.
 */
const runWithClaude = async (prompt: string, cwd: string, json: boolean): Promise<void> => {
  info("Wiring the SDK into your code with Claude Code…");
  detail("installs @glassray only · never commits or pushes · returns here when done");
  const code = await runClaude(prompt, cwd);
  if (code !== 0) {
    // No printData on failure — a partial JSON object would let a caller like
    // `setup --json` lose ownership of stdout. The exit code rides the error.
    throw new CliError(
      `Claude Code exited (code ${code}) — re-run \`glassray instrument\`, or \`--prompt-only\` to do it yourself`,
    );
  }
  success("Done — your agent now sends traces; review the changes before you commit");
  if (json) printData({ mode: "claude", exitCode: code });
};

/**
 * Add tracing to the customer's code — the shared step used by `setup` and the
 * standalone `instrument` command. Default is transparent: show the prompt
 * (clipboard) and, on a TTY with `claude` available, ASK before running it.
 * `forceRun` runs Claude without asking; `promptOnly` always just prints.
 */
export const performInstrument = async (opts: {
  prompt: string;
  cwd: string;
  json: boolean;
  forceRun?: boolean;
  promptOnly?: boolean;
}): Promise<void> => {
  const claude = hasClaude();

  if (opts.promptOnly || !claude) {
    if (!opts.promptOnly && !opts.json) {
      warn("Claude Code isn't installed — here's the prompt to run in your own coding agent:");
    }
    showPrompt(opts.prompt, opts.json);
    return;
  }

  if (opts.forceRun) {
    await runWithClaude(opts.prompt, opts.cwd, opts.json);
    return;
  }

  // On a TTY: default to handing over the prompt; offer to run Claude Code (headless).
  if (process.stdin.isTTY) {
    info("Time to add tracing to your code. I can run Claude Code for you, or give you the prompt to run yourself.");
    if (await confirm("Run Claude Code now?", false)) {
      await runWithClaude(opts.prompt, opts.cwd, opts.json);
    } else {
      showPrompt(opts.prompt, opts.json);
    }
    return;
  }

  // Non-interactive without --run: never auto-run; hand over the prompt.
  showPrompt(opts.prompt, opts.json);
};

/** The `instrument` command. */
export const cmdInstrument = async (ctx: Context, args: string[]): Promise<void> => {
  const { values } = parseCommand(args, {
    "prompt-only": { type: "boolean" },
    run: { type: "boolean" },
    "otlp-endpoint": { type: "string" },
  });
  const report = detect();
  if (report.tracing.glassraySdk) {
    success("Your code already sends traces with @glassray/tracing");
    if (!ctx.json) detail(dim("nothing to do — re-run `glassray verify --wait` to confirm traces are arriving"));
    return;
  }
  const endpoint = await resolveOtlpEndpoint(ctx, strFlag(values, "otlp-endpoint"));
  const prompt = buildInstrumentPrompt({ endpoint, ingestKeyEnvVar: INGEST_KEY_ENV_VAR, detect: report });

  await performInstrument({
    prompt,
    cwd: process.cwd(),
    json: ctx.json,
    forceRun: boolFlag(values, "run"),
    promptOnly: boolFlag(values, "prompt-only"),
  });
};
