/**
 * `glassray setup` — the orchestrator. Runs every discrete step in order,
 * each idempotent / skip-if-already-done, ending at the verify gate (a real
 * trace observed). Non-TTY never prompts; `--default` auto-accepts the plan.
 * See docs/onboarding-wizard.md §10 for the target DX.
 *
 * Every step is also a standalone command — this just sequences them, sharing
 * the lib layer directly so the flow controls its own spinners and report.
 */
import readline from "node:readline/promises";
import { boolFlag, parseCommand, resolveTimeoutSec, strFlag, type Context } from "../lib/context.js";
import { detect, summarizeDetect } from "../lib/detect.js";
import { CliError } from "../lib/errors.js";
import { upsertEnvLocal } from "../lib/env-file.js";
import { connectOtlp, getConfig, getStatus } from "../lib/http.js";
import { buildInstrumentPrompt } from "../lib/instrument-prompt.js";
import { addMcpServer } from "../lib/mcp-config.js";
import { pollUntil } from "../lib/poll.js";
import { track } from "../lib/telemetry.js";
import type { SetupStatusResponse } from "../lib/types.js";
import {
  banner,
  bold,
  bullet,
  card,
  detail,
  dim,
  info,
  link,
  PALETTE,
  paint,
  printData,
  rule,
  spinner,
  success,
  warn,
} from "../lib/ui.js";
import { INGEST_KEY_ENV_VAR } from "./connect.js";
import { performInstrument } from "./instrument.js";
import { ensurePaired } from "./login.js";
import { tokenExportHint } from "./mcp.js";

/** True when a trace has landed (verify gate signal). */
const tracesLanded = (s: SetupStatusResponse): boolean =>
  s.recentTraceCount >= 1 || s.traceCount >= 1 || s.sources.some((src) => src.traceCount > 0);

/** Ask a yes/no question on stderr (default yes). Only called on a TTY. */
const confirm = async (question: string): Promise<boolean> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`  ${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer === "y" || answer === "yes";
};

/** A plain-language, one-line description of what setup is about to do. */
const planSentence = (r: ReturnType<typeof detect>): string => {
  if (r.tracing.glassraySdk) {
    return "You already use @glassray/tracing — I'll make sure it points at this account.";
  }
  if (r.tracing.openTelemetry) {
    return "The plan: point your existing OpenTelemetry setup at Glassray so your agent's runs show up here.";
  }
  return "The plan: add Glassray's tracing SDK so every run of your agent shows up here.";
};

/** The `setup` command. */
export const cmdSetup = async (ctx: Context, args: string[]): Promise<void> => {
  const { values } = parseCommand(args, {
    default: { type: "boolean" },
    yes: { type: "boolean" },
    "org-name": { type: "string" },
    org: { type: "string" },
    "no-open": { type: "boolean" },
    "prompt-only": { type: "boolean" },
    run: { type: "boolean" },
    "skip-instrument": { type: "boolean" },
    "skip-github": { type: "boolean" },
    "skip-slack": { type: "boolean" },
    wait: { type: "boolean" },
    timeout: { type: "string" },
  });
  const autoYes = boolFlag(values, "default") || boolFlag(values, "yes");
  const open = !boolFlag(values, "no-open");
  const wait = boolFlag(values, "wait");
  const timeoutSec = resolveTimeoutSec(values, 300);
  const interactive = process.stdin.isTTY === true;

  banner("Glassray setup", "Watch your agent, catch what breaks, ship the fix.");
  track(ctx, { phase: "setup", step: "start" });

  // ── preflight ────────────────────────────────────────────────────────────
  const config = await getConfig(ctx.endpoint);
  success("Connected to Glassray");
  track(ctx, { phase: "setup", step: "preflight" });

  // ── pair ─────────────────────────────────────────────────────────────────
  const cred = await ensurePaired(ctx, {
    orgName: strFlag(values, "org-name"),
    org: strFlag(values, "org"),
    open,
  });
  success(`Signed in to ${bold(cred.orgName)}${cred.userEmail ? ` as ${dim(cred.userEmail)}` : ""}`);
  track(ctx, { phase: "setup", step: "paired" });

  // ── look at the repo + explain the plan ─────────────────────────────────────
  const report = detect();
  info(`Your repo — ${summarizeDetect(report)}`);
  info(planSentence(report));
  if (report.recommended.alternatives.length > 0 && !report.tracing.glassraySdk) {
    detail(
      `already on ${report.recommended.alternatives.join(" / ")}? connect it instead with \`glassray connect <provider>\``,
    );
  }
  if (interactive && !autoYes) {
    if (!(await confirm("Sound good?"))) {
      warn("No problem — nothing was changed.");
      return;
    }
  }
  track(ctx, { phase: "setup", step: "planned", props: { path: report.recommended.path } });

  // ── connect ingestion (OTLP push — the recommended path) ───────────────────
  let status = await getStatus(ctx.endpoint, cred.apiKey);
  let otlpEndpoint = `${config.appUrl.replace(/\/+$/, "")}/api/public/otel/v1/traces`;
  const hasPushSource = status.sources.some((s) => /otlp|otel|push|sdk/i.test(s.provider));
  if (hasPushSource) {
    success("Your account is already set up to receive traces");
  } else {
    const spin = spinner("Setting up where your traces will land…");
    const res = await connectOtlp(ctx.endpoint, cred.apiKey, { displayName: report.cwd.split("/").pop() ?? "agent" });
    otlpEndpoint = res.endpoint;
    if (res.ingestKey) {
      const written = upsertEnvLocal(process.cwd(), INGEST_KEY_ENV_VAR, res.ingestKey);
      spin.succeed(`Ready to receive traces · key saved to ${written.file}`);
    } else {
      // Idempotent retry: the source already existed, so the key can't be re-shown.
      spin.succeed("Your account is already set up to receive traces");
      warn(`the ingest key can't be shown again — if ${INGEST_KEY_ENV_VAR} is missing from .env.local, rotate it in the dashboard`);
    }
  }
  track(ctx, { phase: "setup", step: "connected" });

  // ── instrument (add tracing to the customer's code) ─────────────────────────
  if (boolFlag(values, "skip-instrument")) {
    info("Skipped adding tracing (--skip-instrument)");
  } else if (report.tracing.glassraySdk) {
    success("Your code already sends traces with @glassray/tracing");
  } else {
    const prompt = buildInstrumentPrompt({
      endpoint: otlpEndpoint,
      ingestKeyEnvVar: INGEST_KEY_ENV_VAR,
      detect: report,
    });
    // Default: hand over the prompt (clipboard) and ask before running Claude.
    // `--default`/`--run` runs it unattended; `--prompt-only` always just prints.
    await performInstrument({
      prompt,
      cwd: process.cwd(),
      json: ctx.json,
      forceRun: autoYes || boolFlag(values, "run"),
      promptOnly: boolFlag(values, "prompt-only"),
    });
  }
  track(ctx, { phase: "setup", step: "instrumented" });

  // ── connect the customer's AI assistant to Glassray's tools ─────────────────
  // The `.mcp.json` bearer is `${GLASSRAY_TOKEN}` env expansion — no secret in the file.
  const mcp = addMcpServer(process.cwd(), config.mcpUrl);
  success(
    mcp.changed
      ? "Your AI assistant can now use Glassray's tools (added to .mcp.json)"
      : "Your AI assistant already has Glassray's tools",
  );
  detail(`install the Glassray skill with \`glassray init\`, and export the token: ${tokenExportHint()}`);
  track(ctx, { phase: "setup", step: "mcp" });

  // ── GitHub / Slack (optional, browser hand-offs) ────────────────────────────
  status = await getStatus(ctx.endpoint, cred.apiKey);
  const needGithub = !boolFlag(values, "skip-github") && status.github !== "connected";
  const needSlack = !boolFlag(values, "skip-slack") && status.slack !== "connected";
  if (needGithub || needSlack) {
    info("Optional — open these to finish the loop:");
    if (needGithub) info(`  → GitHub (read-only, so Glassray can suggest fixes): ${link(`${config.appUrl}/api/github/connect`)}`);
    if (needSlack) info(`  → Slack (get pinged the moment something breaks): ${link(`${config.appUrl}/connect/slack`)}`);
  }
  if (wait && (needGithub || needSlack)) {
    const spin = spinner("waiting for you to connect GitHub / Slack…");
    const r = await pollUntil(
      () => getStatus(ctx.endpoint, cred.apiKey),
      (s) =>
        (boolFlag(values, "skip-github") || s.github === "connected") &&
        (boolFlag(values, "skip-slack") || s.slack === "connected"),
      { timeoutSec, intervalSec: 4 },
    );
    if (r.satisfied) spin.succeed("GitHub and Slack connected");
    else {
      spin.stop();
      detail("not connected yet — you can finish later with `glassray connect github` / `glassray connect slack`");
    }
  }
  track(ctx, { phase: "setup", step: "integrations" });

  // ── verify: confirm a real trace actually lands ─────────────────────────────
  status = await getStatus(ctx.endpoint, cred.apiKey);
  let verified = tracesLanded(status);
  if (!verified && wait) {
    info("Last step — run your agent once so we can confirm traces are arriving.");
    const spin = spinner("Watching for your first trace…");
    const r = await pollUntil(() => getStatus(ctx.endpoint, cred.apiKey), tracesLanded, {
      timeoutSec,
      onTick: (s, elapsed) => spin.update(`Watching for your first trace… ${s.traceCount} seen (${elapsed}s)`),
    });
    spin.stop();
    status = r.value;
    verified = r.satisfied;
  }
  track(ctx, { phase: "setup", step: verified ? "verified" : "unverified" });

  // ── report ──────────────────────────────────────────────────────────────────
  if (ctx.json) {
    printData({
      organizationId: cred.organizationId,
      orgName: cred.orgName,
      verified,
      sources: status.sources.length,
      traceCount: status.traceCount,
      github: status.github,
      slack: status.slack,
      mcpRegistered: true,
    });
    if (!verified) {
      throw new CliError(
        "Almost there — no traces have arrived yet. Run your agent, then `glassray verify --wait`.",
      );
    }
    return;
  }

  card([
    rule(verified ? "You're all set" : "One step left"),
    ``,
    `  ${bullet(verified ? "ok" : "warn")} ${verified ? "Traces are arriving — Glassray is watching your agent" : "No traces have arrived yet"}`,
    `    ${dim("Account")}    ${cred.orgName}`,
    `    ${dim("Traces")}     ${status.traceCount} received · ${status.sources.length} source${status.sources.length === 1 ? "" : "s"}`,
    `    ${dim("GitHub")}     ${status.github === "connected" ? "connected" : "not connected"}   ${dim("Slack")} ${status.slack === "connected" ? "connected" : "not connected"}`,
    ``,
    verified
      ? `  Review the changes, commit, and get back to building — you won't need the dashboard.`
      : `  Run your agent, then ${bold(paint("glassray verify --wait", PALETTE.brandBright))} to confirm it's flowing.`,
  ]);

  if (!verified) {
    throw new CliError("Almost there — run your agent, then `glassray verify --wait`.");
  }
};
