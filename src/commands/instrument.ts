/**
 * `glassray instrument` — the seam between deterministic and semantic setup.
 * Builds a scoped prompt (add the tracing SDK + the four metadata tags). By
 * default it does NOT auto-run anything: it shows the prompt (copied to your
 * clipboard) so you can run it in whatever coding agent you like, and — when the
 * `claude` binary is present — offers to run it for you. `--run` skips the
 * question and runs Claude Code; `--prompt-only` always just prints.
 */
import { parseCommand, strFlag, boolFlag, type Context } from "../lib/context.js";
import { hasClaude, runClaude, type ClaudeRunResult } from "../lib/claude-runner.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { detect } from "../lib/detect.js";
import { CliError } from "../lib/errors.js";
import { getConfig } from "../lib/http.js";
import { buildInstrumentPrompt } from "../lib/instrument-prompt.js";
import { confirm } from "../lib/prompt.js";
import { INGEST_KEY_ENV_VAR } from "../lib/env-file.js";
import { bullet, card, detail, dim, info, paintErr, PALETTE, printData, spinner, success, warn } from "../lib/ui.js";

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

/** A CliError for a non-zero Claude exit, folding in a stderr tail when we have one. */
const claudeFailed = (result: ClaudeRunResult): CliError => {
  const tail = result.errorTail ? ` — ${result.errorTail.split("\n").pop()?.trim() ?? ""}` : "";
  // No printData on failure — a partial JSON object would let a caller like
  // `setup --json` lose ownership of stdout. The exit code rides the error.
  return new CliError(
    `Claude Code exited (code ${result.code})${tail} — re-run \`glassray instrument\`, or \`--prompt-only\` to do it yourself`,
  );
};

/** Left-pad a summary label so the values line up in a column. */
const row = (label: string, value: string): string => `    ${dim(label.padEnd(9))} ${value}`;

/** Prefix a live activity label with `Claude ·` so it's clear the user's own Claude is acting, not us. */
const claudeLabel = (text: string): string =>
  `${paintErr("Claude", PALETTE.brandBright)} ${paintErr("·", PALETTE.muted)} ${text}`;

/**
 * Render what Claude actually did — installs + edited files, grounded in the
 * tool calls it made (not its prose) — so the user can review before committing.
 */
const printClaudeSummary = (result: ClaudeRunResult): void => {
  const lines = [`  ${bullet("ok")} Claude Code finished`];
  if (result.installs.length > 0) lines.push(row("installed", result.installs.join(", ")));
  const shown = result.edits.slice(0, 6);
  for (const file of shown) lines.push(row("edited", file));
  if (result.edits.length > shown.length) lines.push(row("edited", `…and ${result.edits.length - shown.length} more`));
  lines.push("", `    ${dim("→ review the diff, then commit when you're happy")}`);
  card(lines);
};

/**
 * Hand the prompt to the local `claude` binary. Claude Code runs HEADLESSLY — it
 * applies the change and exits, returning control here (no getting stuck inside
 * an interactive Claude session). We parse its `stream-json` events into a live
 * spinner (so the run never looks frozen) and a grounded summary of what changed.
 * Throws on a non-zero exit; on a zero-change run it warns instead of claiming
 * success, so a silent no-op can't masquerade as done.
 */
const runWithClaude = async (prompt: string, cwd: string, json: boolean): Promise<void> => {
  if (json) {
    // JSON mode owns stdout — no live feed; run, then emit the structured result.
    const result = await runClaude(prompt, cwd);
    if (result.code !== 0) throw claudeFailed(result);
    printData({ mode: "claude", exitCode: result.code, installs: result.installs, edits: result.edits });
    return;
  }

  info("Adding tracing to your code with Claude Code…");
  detail("it installs the SDK and edits your entry point · never commits or pushes · returns here when done");
  const spin = spinner(claudeLabel("starting up…"));
  let result: ClaudeRunResult;
  try {
    result = await runClaude(prompt, cwd, (label) => spin.update(claudeLabel(label)));
  } catch (err) {
    spin.fail("couldn't start Claude Code");
    throw err;
  }
  if (result.code !== 0) {
    spin.fail(`Claude Code exited (code ${result.code})`);
    throw claudeFailed(result);
  }
  // Nothing changed — don't claim success; tell the user how to proceed.
  if (result.edits.length === 0 && result.installs.length === 0) {
    spin.stop();
    warn("Claude Code finished but didn't change any files.");
    detail("re-run `glassray instrument`, or `glassray instrument --prompt-only` to wire it in yourself");
    return;
  }
  spin.succeed("Claude Code finished");
  printClaudeSummary(result);
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
