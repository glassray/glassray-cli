/**
 * `glassray setup` — the v3 launcher. It is NOT a terminal orchestrator: it
 * signs you in, hands the whole onboarding (GitHub · trace sources · Slack) to
 * the browser wizard, mirrors the wizard's per-step status back to the terminal,
 * and then does the one thing that must be local — wiring the SDK into your code
 * (only when the SDK path was chosen or traces were skipped) — before the verify
 * gate. Browser-only; CI uses the granular subcommands with `--api-key`.
 */
import path from "node:path";
import { boolFlag, parseCommand, resolveTimeoutSec, strFlag, type Context } from "../lib/context.js";
import { openBrowser } from "../lib/browser.js";
import { detect } from "../lib/detect.js";
import { CliError, EXIT } from "../lib/errors.js";
import { detectEnvFile, INGEST_KEY_ENV_VAR, upsertEnvFile } from "../lib/env-file.js";
import { connectOtlp, getConfig, getStatus } from "../lib/http.js";
import { buildInstrumentPrompt } from "../lib/instrument-prompt.js";
import { addMcpServer } from "../lib/mcp-config.js";
import { pollUntil } from "../lib/poll.js";
import { checkProjectRoot, resolveProjectDir } from "../lib/project-root.js";
import { confirm, pick, prompt } from "../lib/prompt.js";
import { track } from "../lib/telemetry.js";
import type { SetupStatusResponse } from "../lib/types.js";
import {
  banner,
  bell,
  blank,
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
import { performInstrument } from "./instrument.js";
import { ensurePaired } from "./login.js";
import { tokenExportHint } from "./mcp.js";

/** Generous budget for the human-paced browser wizard poll (30 min). Not tied to `--timeout`. */
const ONBOARDING_WAIT_SEC = 1800;

/** True when a real trace has landed (the verify gate). */
const tracesLanded = (s: SetupStatusResponse): boolean =>
  s.recentTraceCount >= 1 || s.traceCount >= 1 || s.sources.some((src) => src.traceCount > 0);

/** A one-line live summary of the wizard's per-step progress, for the waiting spinner. */
const liveStatusLine = (s: SetupStatusResponse): string => {
  const mark = (ok: boolean): string => (ok ? paint("✓", PALETTE.brandBright) : dim("·"));
  return `GitHub ${mark(s.github === "connected")}   Slack ${mark(s.slack === "connected")}   Traces ${mark(s.sources.length > 0)}`;
};

/** Whether any browser step has landed yet — until then we don't show the per-step breakdown. */
const onboardingStarted = (s: SetupStatusResponse): boolean =>
  s.github === "connected" || s.slack === "connected" || s.sources.length > 0;

/** Print the completed-onboarding status as a compact, data-rich card. */
const printOnboardingStatus = (s: SetupStatusResponse): void => {
  const yn = (ok: boolean): string => (ok ? "connected" : "not connected");
  const sourceLabel =
    s.sources.length > 0
      ? `${s.sources.length} source${s.sources.length === 1 ? "" : "s"}`
      : s.tracePath === "none"
        ? "skipped"
        : "none";
  card([
    `  ${bullet("ok")} Onboarding complete`,
    `    ${dim("GitHub")}     ${yn(s.github === "connected")}`,
    `    ${dim("Slack")}      ${yn(s.slack === "connected")}`,
    `    ${dim("Traces")}     ${sourceLabel}${s.tracePath === "pull" ? " (existing provider)" : s.tracePath === "otlp" ? " (SDK)" : ""}`,
  ]);
};

/**
 * Make sure we're standing in the user's project before wiring anything in.
 * `setup` writes the ingest key, `.mcp.json`, and the SDK edits into the CURRENT
 * directory — so if the cwd doesn't look like a project root (home, a bare
 * shell, a Spotlight-launched terminal), ask for the directory and `chdir` into
 * it so every downstream `process.cwd()` step lands there. Non-interactive with
 * a bad cwd is a hard error — we won't silently instrument an arbitrary location.
 */
const ensureInProject = async (interactive: boolean): Promise<void> => {
  const cwd = process.cwd();
  const check = checkProjectRoot(cwd);
  if (check.ok) {
    success(`Working in ${bold(cwd)}${check.reason ? dim(` · ${check.reason}`) : ""}`);
    return;
  }
  if (!interactive) {
    throw new CliError(
      `Running in ${cwd}, which doesn't look like your project — no package.json / pyproject.toml and not inside a git repo. cd into your project and re-run \`glassray setup\`.`,
      EXIT.FAILURE,
      "not-in-project",
    );
  }
  warn(`This doesn't look like a project directory: ${cwd}`);
  detail("setup wires the SDK and writes .mcp.json here — point it at your project instead.");
  for (;;) {
    const answer = await prompt("Path to your project:");
    const res = resolveProjectDir(answer);
    if (!res.ok) {
      warn(res.error);
      continue;
    }
    // Chosen dir still doesn't look like a project — let them override, but confirm.
    if (!res.root.ok && !(await confirm(`${res.dir} doesn't look like a project either — use it anyway?`, false))) {
      continue;
    }
    process.chdir(res.dir);
    success(`Working in ${bold(res.dir)}${res.root.reason ? dim(` · ${res.root.reason}`) : ""}`);
    return;
  }
};

/**
 * Pick which project the new source's traces should land in (an interactive
 * onboarding step, never a flag), and always tell the user which one that is —
 * onboarding was otherwise project-blind. Branches on the key's current binding
 * (`boundProjectId`): a key already pinned to a NON-default project is
 * hard-bound (the server uses that binding regardless of what we send), so we
 * DON'T prompt — we just announce where traces land. Otherwise: one project →
 * announce + use it; several on a TTY → numbered picker with the bound (else
 * default) project preselected; non-interactive → `undefined`, so the server
 * falls back to the default (and an idempotent retry keeps the source's own
 * project). Creating a project stays a dashboard action.
 */
const selectProject = async (
  projects: SetupStatusResponse["projects"],
  boundProjectId: string | null | undefined,
  interactive: boolean,
): Promise<string | undefined> => {
  const bound = boundProjectId ? projects.find((p) => p.id === boundProjectId) : undefined;
  const defaultProject = projects.find((p) => p.isDefault) ?? projects[0];

  // Key already pinned to a specific workspace (a re-run after a prior pick): the
  // server ignores any requested project, so skip the prompt and just say where
  // this run lands — hitting Enter on a preselected Default would otherwise lie.
  if (bound && !bound.isDefault) {
    info(`Setting up project ${bold(`"${bound.name}"`)} ${dim("— your key is bound here")}`);
    return bound.id;
  }

  // One project (or nothing to choose): announce it so the user isn't blind to
  // where traces land; non-interactive with several → undefined (server default).
  if (projects.length <= 1) {
    if (defaultProject) info(`Setting up project ${bold(`"${defaultProject.name}"`)}`);
    return defaultProject?.id;
  }
  if (!interactive) return undefined;

  // Several projects, key still on Default: pick, preselecting the bound-or-default one.
  const preselect = bound ?? defaultProject;
  const defaultIndex = Math.max(
    projects.findIndex((p) => p.id === preselect?.id),
    0,
  );
  const chosen = await pick(
    "Which project should this source's traces land in?",
    projects.map((p) => `${p.name} ${dim(`(${p.slug})`)}`),
    defaultIndex,
  );
  detail("need a new project? create it in the dashboard (Settings → Projects) and re-run");
  return projects[chosen]!.id;
};

/** The `setup` command — the v3 launcher. */
export const cmdSetup = async (ctx: Context, args: string[]): Promise<void> => {
  const { values } = parseCommand(args, {
    "org-name": { type: "string" },
    org: { type: "string" },
    "no-open": { type: "boolean" },
    "prompt-only": { type: "boolean" },
    run: { type: "boolean" },
    "skip-instrument": { type: "boolean" },
    timeout: { type: "string" },
  });
  const open = !boolFlag(values, "no-open");
  const interactive = process.stdin.isTTY === true;
  const verifyWaitSec = resolveTimeoutSec(values, 300);

  banner("Glassray setup", "Watch your agent, catch what breaks, ship the fix.");
  track(ctx, { phase: "setup", step: "start" });

  // ── preflight ──────────────────────────────────────────────────────────────
  const config = await getConfig(ctx.endpoint);
  const appUrl = config.appUrl.replace(/\/+$/, "");
  success("Connected to Glassray");
  track(ctx, { phase: "setup", step: "preflight" });

  // ── sign in (device grant → org key) ─────────────────────────────────────────
  const cred = await ensurePaired(ctx, {
    orgName: strFlag(values, "org-name"),
    org: strFlag(values, "org"),
    open,
  });
  success(`Signed in to ${bold(cred.orgName)}${cred.userEmail ? ` as ${dim(cred.userEmail)}` : ""}`);
  track(ctx, { phase: "setup", step: "paired" });

  // ── make sure we're in the project we're about to instrument ─────────────────
  // Everything local below (ingest key, .mcp.json, SDK wiring) writes into the
  // cwd — confirm it's a real project (or chdir into one) BEFORE the long browser
  // wizard, so a wrong-directory run fails fast instead of at the very end.
  await ensureInProject(interactive);
  track(ctx, { phase: "setup", step: "project-dir" });

  // ── onboarding: hand off to the browser wizard, mirror status ────────────────
  let status = await getStatus(ctx.endpoint, cred.apiKey);
  if (!status.onboardingCompleted) {
    // Browser-only: the wizard is a browser flow — a non-interactive session
    // (CI / no browser) cannot drive it. Point such callers at the subcommands.
    if (!interactive) {
      throw new CliError(
        "`glassray setup` needs a browser to finish first-time onboarding — there's no fully headless first run.",
        EXIT.FAILURE,
        "onboarding-needs-browser",
        `Finish onboarding once where you can open a browser — run \`glassray setup\` there, or open ${appUrl} and complete it. After that CI can re-run \`glassray setup --api-key\`: it finishes locally without a browser — minting the ingest key into .env.local on the SDK path, or just verifying an existing-provider source. (\`instrument --prompt-only\` / \`verify --wait\` alone can't: neither creates a source or mints a key.) Agents on the MCP server can instead create a source with the connect_otlp_source / connect_pull_source tools (not CLI commands).`,
      );
    }
    const wizardUrl = `${appUrl}/api/setup/enter?org=${encodeURIComponent(cred.organizationId)}&src=cli`;
    blank();
    info("Now finish setup in your browser — connect GitHub, your traces, and Slack.");
    if (open) openBrowser(wizardUrl);
    info(`Opening ${link(wizardUrl)}`);
    detail("(or open that URL on any device)");

    const spin = spinner("Waiting for you in the browser…");
    const r = await pollUntil(
      () => getStatus(ctx.endpoint, cred.apiKey),
      (s) => s.onboardingCompleted,
      {
        timeoutSec: ONBOARDING_WAIT_SEC,
        intervalSec: 3,
        onTick: (s) =>
          spin.update(
            onboardingStarted(s)
              ? `In your browser…   ${liveStatusLine(s)}`
              : "Waiting for you to finish setup in your browser…",
          ),
      },
    );
    spin.stop();
    if (!r.satisfied) {
      throw new CliError(
        "Didn't see onboarding finish in the browser. Re-run `glassray setup` once you've completed those steps.",
      );
    }
    status = r.value;
    bell(); // The browser step is done — nudge the user's attention back to the terminal.
    printOnboardingStatus(status);
    track(ctx, { phase: "setup", step: "onboarded" });
  } else {
    success("You're already onboarded — finishing up locally.");
  }

  // ── local SDK wiring — only when the SDK path was chosen (or traces skipped) ──
  // A `pull` source (existing provider) needs no code change. The ingest key is
  // minted HERE, into `.env.local`, so the terminal (not the browser) owns it —
  // it lands where the SDK reads it and is never surfaced in the UI.
  blank();
  const report = detect();
  let otlpEndpoint = `${appUrl}/api/public/otel/v1/traces`;
  if (status.tracePath === "pull") {
    success("You're pulling traces from an existing provider — no code change needed here.");
  } else {
    // tracePath is `otlp` (SDK chosen) or `none` (traces skipped) → set up push
    // ingestion. The ingest key is minted HERE, into `.env.local`, so the
    // terminal (not the browser) owns it. This ALWAYS runs on the SDK path —
    // `--skip-instrument` and an already-present @glassray/tracing only gate the
    // code-editing prompt below, NEVER the key/source (else an instrumented repo
    // with no key/source would be a dead end).
    // Project step (after pairing, before connect): which workspace the
    // source's traces land in — sent with the connect, echoed back below.
    const projectId = await selectProject(status.projects, status.boundProjectId, interactive);
    const spin = spinner("Setting up where your traces will land…");
    const res = await connectOtlp(ctx.endpoint, cred.apiKey, {
      displayName: path.basename(report.cwd) || "agent",
      ...(projectId ? { projectId } : {}),
    });
    otlpEndpoint = res.endpoint;
    spin.succeed(
      res.existing
        ? `Trace ingestion ready — source already exists in project ${bold(`"${res.project.name}"`)}`
        : `Trace ingestion ready — source created in project ${bold(`"${res.project.name}"`)}`,
    );
    if (res.ingestKey) {
      // Show the key (it's the customer's own, on their own machine) — the CLI
      // doesn't touch your files unless you say so.
      blank();
      card([
        `  ${bullet("ok")} Here's your ingest key ${dim("— your agent sends traces with this")}`,
        `    ${dim("Env var")}   ${INGEST_KEY_ENV_VAR}`,
        `    ${dim("Key")}       ${res.ingestKey}`,
        `    ${dim("Endpoint")}  ${otlpEndpoint}`,
      ]);
      // Offer to save it into the repo's env file — writes ONLY if you say yes.
      const envFile = detectEnvFile(process.cwd());
      if (envFile === null) {
        // The only `.env.local` is git-tracked — auto-saving would commit the
        // secret, and `.gitignore` can't un-track it. The key is shown above, so
        // surface it instead of writing (this is the non-interactive path too).
        warn(
          `not auto-saving ${INGEST_KEY_ENV_VAR} — your .env.local is git-tracked (a committed secret can't be un-tracked). Run \`git rm --cached .env.local\` + gitignore it, or set ${INGEST_KEY_ENV_VAR} yourself.`,
        );
      } else {
        const save = interactive ? await confirm(`Save ${INGEST_KEY_ENV_VAR} to ${envFile}?`) : true;
        if (save) {
          const written = upsertEnvFile(process.cwd(), INGEST_KEY_ENV_VAR, res.ingestKey, envFile);
          success(`Saved to ${written.file} ${dim("(gitignored — your SDK reads it from here)")}`);
        } else {
          detail(`no problem — pop ${INGEST_KEY_ENV_VAR} into your env yourself and you're set`);
        }
      }
    } else {
      // Idempotent retry (or a source minted elsewhere): the key can't be re-shown.
      warn(
        `can't show the ingest key again — if ${INGEST_KEY_ENV_VAR} isn't set, rotate it in the dashboard`,
      );
    }

    // Wire the SDK into the code — independently skippable (the key is already set).
    if (boolFlag(values, "skip-instrument")) {
      info(
        `Skipped wiring the SDK into your code (--skip-instrument) — the ingest key is set; add @glassray/tracing yourself and read ${INGEST_KEY_ENV_VAR}.`,
      );
    } else if (report.tracing.glassraySdk) {
      success("Your code already sends traces with @glassray/tracing");
    } else {
      const prompt = buildInstrumentPrompt({
        endpoint: otlpEndpoint,
        ingestKeyEnvVar: INGEST_KEY_ENV_VAR,
        detect: report,
      });
      await performInstrument({
        prompt,
        cwd: process.cwd(),
        json: ctx.json,
        forceRun: boolFlag(values, "run"),
        promptOnly: boolFlag(values, "prompt-only"),
      });
    }
  }
  track(ctx, { phase: "setup", step: "instrumented" });

  // ── register Glassray's tools in the repo (local, idempotent) ────────────────
  const mcp = addMcpServer(process.cwd(), config.mcpUrl);
  success(
    mcp.changed
      ? "Your AI assistant can now use Glassray's tools (added to .mcp.json)"
      : "Your AI assistant already has Glassray's tools",
  );
  detail(`install the Glassray skill with \`glassray init\`, and export the token: ${tokenExportHint()}`);
  track(ctx, { phase: "setup", step: "mcp" });

  // ── verify: confirm a real trace actually lands ──────────────────────────────
  blank();
  status = await getStatus(ctx.endpoint, cred.apiKey);
  let verified = tracesLanded(status);
  if (!verified) {
    info("Last step — run your agent once so we can confirm traces are arriving.");
    const spin = spinner("Watching for your first trace…");
    const r = await pollUntil(() => getStatus(ctx.endpoint, cred.apiKey), tracesLanded, {
      timeoutSec: verifyWaitSec,
      onTick: (s, elapsed) => spin.update(`Watching for your first trace… ${s.traceCount} seen (${elapsed}s)`),
    });
    spin.stop();
    status = r.value;
    verified = r.satisfied;
  }
  track(ctx, { phase: "setup", step: verified ? "verified" : "unverified" });

  // ── report ───────────────────────────────────────────────────────────────────
  if (ctx.json) {
    printData({
      organizationId: cred.organizationId,
      orgName: cred.orgName,
      verified,
      onboardingCompleted: status.onboardingCompleted,
      tracePath: status.tracePath,
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
