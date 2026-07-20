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
import { connectOtlp, getConfig, getStatus, selectSetupProject } from "../lib/http.js";
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
    `    ${dim("Traces")}     ${sourceLabel}${s.tracePath === "pull" ? " (existing provider)" : s.tracePath === "otlp" ? " (SDK)" : s.tracePath === "vercel" ? " (Vercel drain)" : ""}`,
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
      `Running in ${cwd}, which doesn't look like your project - no package.json / pyproject.toml and not inside a git repo. cd into your project and re-run \`glassray setup\`.`,
      EXIT.FAILURE,
      "not-in-project",
    );
  }
  warn(`This doesn't look like a project directory: ${cwd}`);
  detail("setup wires the SDK and writes .mcp.json here - point it at your project instead.");
  for (;;) {
    const answer = await prompt("Path to your project:");
    const res = resolveProjectDir(answer);
    if (!res.ok) {
      warn(res.error);
      continue;
    }
    // Chosen dir still doesn't look like a project — let them override, but confirm.
    if (!res.root.ok && !(await confirm(`${res.dir} doesn't look like a project either - use it anyway?`, false))) {
      continue;
    }
    process.chdir(res.dir);
    success(`Working in ${bold(res.dir)}${res.root.reason ? dim(` · ${res.root.reason}`) : ""}`);
    return;
  }
};

/** One project as the setup surface reports it — `SetupProjectRef` + the default marker. */
type ProjectOption = SetupStatusResponse["projects"][number];

/**
 * Create a project from the terminal: ask for a name, send it to
 * `POST /v1/setup/project` (slug derived server-side, key pinned there), and
 * re-ask on a duplicate name instead of dying. TTY-only (the caller gates).
 */
const createProjectLoop = async (ctx: Context, apiKey: string): Promise<ProjectOption> => {
  for (;;) {
    const name = await prompt("New project name:");
    try {
      const res = await selectSetupProject(ctx.endpoint, apiKey, { createName: name });
      success(`Created project ${bold(`"${res.project.name}"`)} ${dim(`(${res.project.slug})`)}`);
      return res.project;
    } catch (err) {
      if (err instanceof CliError && err.code === "project-exists") {
        warn(err.message);
        continue;
      }
      throw err;
    }
  }
};

/**
 * The project step's outcome: the workspace this run operates in, and whether
 * the server CONFIRMED the key is pinned there (`pinned: false` only on the
 * rollout-staggered fallback where the project endpoint doesn't exist yet — the
 * caller must then not wait for the binding to show up in status).
 */
type ProjectChoice = { project: ProjectOption; pinned: boolean };

/**
 * The project step — which workspace this setup run operates in. Runs BEFORE
 * the browser wizard so onboarding, integrations, AND the new source all land
 * in the chosen project (they're all project-owned). Branches on the key's
 * binding (`boundProjectId`): a key already pinned to a NON-default project is
 * hard-bound (the server uses that binding regardless), so we announce instead
 * of asking. Otherwise on a TTY: a numbered picker over the org's projects
 * (bound-or-default preselected, so Enter keeps the golden path) plus a
 * "create a new project" option; the choice is sent to `POST /v1/setup/project`,
 * which pins the key there. Non-interactive → the bound-or-default project,
 * no prompt, no server call. `undefined` only when the server predates the
 * projects field (rollout stagger) — the server default then applies.
 */
const projectStep = async (
  ctx: Context,
  apiKey: string,
  status: SetupStatusResponse,
  interactive: boolean,
): Promise<ProjectChoice | undefined> => {
  const projects = status.projects ?? [];
  const bound = status.boundProjectId
    ? projects.find((p) => p.id === status.boundProjectId)
    : undefined;
  const defaultProject = projects.find((p) => p.isDefault) ?? projects[0];

  // Key already pinned to a specific workspace (a re-run after a prior pick):
  // the server uses that binding regardless of what we send — announce, don't ask.
  if (bound && !bound.isDefault) {
    info(`Setting up project ${bold(`"${bound.name}"`)} ${dim("- your key is bound here")}`);
    return { project: bound, pinned: true };
  }

  if (!interactive || projects.length === 0) {
    if (defaultProject) info(`Setting up project ${bold(`"${defaultProject.name}"`)}`);
    return defaultProject ? { project: defaultProject, pinned: true } : undefined;
  }

  // Pick (bound-or-default preselected — Enter keeps it) or create a new one.
  const preselect = bound ?? defaultProject;
  const defaultIndex = Math.max(
    projects.findIndex((p) => p.id === preselect?.id),
    0,
  );
  // Skip the slug echo when it adds nothing (e.g. "Default (default)") — it
  // would collide with the picker's own "(default)" marker.
  const label = (p: ProjectOption): string =>
    p.slug === p.name.toLowerCase() ? p.name : `${p.name} ${dim(`(${p.slug})`)}`;
  const chosen = await pick(
    "Which project (workspace) are you setting up?",
    [...projects.map(label), "Create a new project…"],
    defaultIndex,
  );

  if (chosen >= projects.length) {
    return { project: await createProjectLoop(ctx, apiKey), pinned: true };
  }

  const picked = projects[chosen]!;
  // Already the key's binding — nothing to change server-side.
  if (picked.id === status.boundProjectId) {
    info(`Setting up project ${bold(`"${picked.name}"`)}`);
    return { project: picked, pinned: true };
  }
  try {
    const res = await selectSetupProject(ctx.endpoint, apiKey, { projectId: picked.id });
    info(`Setting up project ${bold(`"${res.project.name}"`)}`);
    return { project: res.project, pinned: true };
  } catch (err) {
    // Rollout-staggered server without the project endpoint: keep the choice
    // locally — the connect step still lands the source (and rebinds) with it.
    if (err instanceof CliError && err.message.startsWith("HTTP 404")) {
      info(`Setting up project ${bold(`"${picked.name}"`)}`);
      return { project: picked, pinned: false };
    }
    throw err;
  }
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

  // ── project step: pick or create the workspace this run sets up ─────────────
  // Runs BEFORE the wizard hand-off — onboarding, integrations, and the source
  // are all project-owned, so the choice has to be pinned (key rebind) first
  // for the wizard and the status poll to operate on the right workspace.
  let status = await getStatus(ctx.endpoint, cred.apiKey);
  const choice = await projectStep(ctx, cred.apiKey, status, interactive);
  const project = choice?.project;
  if (
    project &&
    choice?.pinned &&
    status.boundProjectId !== undefined &&
    project.id !== status.boundProjectId
  ) {
    // The pick moved the key's binding — every decision below (wizard needed?
    // tracePath?) must be made against the CHOSEN workspace. Don't trust one
    // blind re-read: a deployment whose auth layer caches the key→project
    // resolution (per-replica, ~60s) can keep serving the OLD workspace for a
    // short window, and deciding "already onboarded" off that stale read would
    // skip the wizard for the wrong project. Poll until the server actually
    // reports the new binding.
    const spin = spinner(`Switching to project "${project.name}"…`);
    const r = await pollUntil(
      () => getStatus(ctx.endpoint, cred.apiKey),
      (s) => s.boundProjectId === project.id,
      { timeoutSec: 90, intervalSec: 3 },
    );
    spin.stop();
    if (!r.satisfied) {
      throw new CliError(
        `the server still reports your previous workspace after switching to "${project.name}" - wait a minute and re-run \`glassray setup\` (your project choice is saved)`,
      );
    }
    status = r.value;
  } else if (project && project.id !== status.boundProjectId) {
    // Rollout-staggered server that doesn't report `boundProjectId`: a single
    // refresh is the best we can do.
    status = await getStatus(ctx.endpoint, cred.apiKey);
  }
  track(ctx, { phase: "setup", step: "project" });

  // ── onboarding: hand off to the browser wizard, mirror status ────────────────
  if (!status.onboardingCompleted) {
    // Browser-only: the wizard is a browser flow — a non-interactive session
    // (CI / no browser) cannot drive it. Point such callers at the subcommands.
    if (!interactive) {
      throw new CliError(
        "`glassray setup` needs a browser to finish first-time onboarding - there's no fully headless first run.",
        EXIT.FAILURE,
        "onboarding-needs-browser",
        `Finish onboarding once where you can open a browser - run \`glassray setup\` there, or open ${appUrl} and complete it. After that CI can re-run \`glassray setup --api-key\`: it finishes locally without a browser - minting the ingest key into .env.local on the SDK path, or just verifying an existing-provider source. (\`instrument --prompt-only\` / \`verify --wait\` alone can't: neither creates a source or mints a key.) Agents on the MCP server can instead create a source with the connect_otlp_source / connect_pull_source tools (not CLI commands).`,
      );
    }
    const wizardUrl = `${appUrl}/api/setup/enter?org=${encodeURIComponent(cred.organizationId)}&src=cli${project ? `&project=${encodeURIComponent(project.id)}` : ""}`;
    blank();
    info("Now finish setup in your browser - connect GitHub, your traces, and Slack.");
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
    bell(); // The browser step is done - nudge the user's attention back to the terminal.
    printOnboardingStatus(status);
    track(ctx, { phase: "setup", step: "onboarded" });
  } else {
    success("You're already onboarded - finishing up locally.");
  }

  // ── local SDK wiring — only when the SDK path was chosen (or traces skipped) ──
  // A `pull` source (existing provider) needs no code change. The ingest key is
  // minted HERE, into `.env.local`, so the terminal (not the browser) owns it —
  // it lands where the SDK reads it and is never surfaced in the UI.
  blank();
  const report = detect();
  let otlpEndpoint = `${appUrl}/api/public/otel/v1/traces`;
  if (status.tracePath === "pull") {
    success("You're pulling traces from an existing provider - no code change needed here.");
  } else if (status.tracePath === "vercel") {
    // Vercel drain path: the source + key live server-side and the wiring
    // happens in the Vercel dashboard — no code change, no `.env.local` key
    // (the key rides the drain's Authorization header, not this repo).
    // The browser wizard usually created the drain source already (that's how
    // tracePath became `vercel`) — server-side idempotency matches push
    // sources by display name only, so blindly connecting with the repo dir's
    // name would mint a DUPLICATE source + a second key that doesn't match
    // the drain the user configured. Only create when no vercel source exists.
    const existingDrain = status.sources.find((s) => s.provider === "vercel" && s.enabled);
    if (existingDrain) {
      success(
        `Vercel drain source already connected${existingDrain.displayName ? ` (${bold(existingDrain.displayName)})` : ""} - nothing to wire here.`,
      );
      detail(
        "lost the drain key? rotate it from the source's Configure dialog in the dashboard and update the drain's Authorization header",
      );
    } else {
      const spin = spinner("Setting up where your Vercel traces will land…");
      const res = await connectOtlp(ctx.endpoint, cred.apiKey, {
        displayName: path.basename(report.cwd) || "agent",
        platform: "vercel",
        ...(project ? { projectId: project.id } : {}),
      });
      otlpEndpoint = res.endpoint;
      const landedIn = res.project
        ? `in project ${bold(`"${res.project.name}"`)}`
        : "in your project";
      spin.succeed(
        res.existing
          ? `Vercel drain source ready - source already exists ${landedIn}`
          : `Vercel drain source ready - source created ${landedIn}`,
      );
      blank();
      if (res.guide) {
        card(res.guide.split("\n").map((line) => `  ${line}`));
      }
      if (res.existing && !res.ingestKey) {
        warn(
          "can't show the ingest key again - if the drain isn't configured yet, rotate the key in the dashboard and use the new value in the Authorization header",
        );
      }
    }
  } else {
    // tracePath is `otlp` (SDK chosen) or `none` (traces skipped) → set up push
    // ingestion. The ingest key is minted HERE, into `.env.local`, so the
    // terminal (not the browser) owns it. This ALWAYS runs on the SDK path —
    // `--skip-instrument` and an already-present @glassray/tracing only gate the
    // code-editing prompt below, NEVER the key/source (else an instrumented repo
    // with no key/source would be a dead end). The source lands in the project
    // chosen up top (the key is already pinned there; sending the id is a
    // belt-and-braces echo the server validates).
    const spin = spinner("Setting up where your traces will land…");
    const res = await connectOtlp(ctx.endpoint, cred.apiKey, {
      displayName: path.basename(report.cwd) || "agent",
      ...(project ? { projectId: project.id } : {}),
    });
    otlpEndpoint = res.endpoint;
    // `res.project` may be absent from a rollout-staggered server that predates
    // the project echo — fall back to a generic message rather than crash after
    // the source is already created (which would strand the ingest key below).
    const landedIn = res.project ? `in project ${bold(`"${res.project.name}"`)}` : "in your project";
    spin.succeed(
      res.existing
        ? `Trace ingestion ready - source already exists ${landedIn}`
        : `Trace ingestion ready - source created ${landedIn}`,
    );
    if (res.ingestKey) {
      // Show the key (it's the customer's own, on their own machine) — the CLI
      // doesn't touch your files unless you say so.
      blank();
      card([
        `  ${bullet("ok")} Here's your ingest key ${dim("- your agent sends traces with this")}`,
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
          `not auto-saving ${INGEST_KEY_ENV_VAR} - your .env.local is git-tracked (a committed secret can't be un-tracked). Run \`git rm --cached .env.local\` + gitignore it, or set ${INGEST_KEY_ENV_VAR} yourself.`,
        );
      } else {
        const save = interactive ? await confirm(`Save ${INGEST_KEY_ENV_VAR} to ${envFile}?`) : true;
        if (save) {
          const written = upsertEnvFile(process.cwd(), INGEST_KEY_ENV_VAR, res.ingestKey, envFile);
          success(`Saved to ${written.file} ${dim("(gitignored - your SDK reads it from here)")}`);
        } else {
          detail(`no problem - pop ${INGEST_KEY_ENV_VAR} into your env yourself and you're set`);
        }
      }
    } else {
      // Idempotent retry (or a source minted elsewhere): the key can't be re-shown.
      warn(
        `can't show the ingest key again - if ${INGEST_KEY_ENV_VAR} isn't set, rotate it in the dashboard`,
      );
    }

    // Wire the SDK into the code — independently skippable (the key is already set).
    if (boolFlag(values, "skip-instrument")) {
      info(
        `Skipped wiring the SDK into your code (--skip-instrument) - the ingest key is set; add @glassray/tracing yourself and read ${INGEST_KEY_ENV_VAR}.`,
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
    info("Last step - run your agent once so we can confirm traces are arriving.");
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
        "Almost there - no traces have arrived yet. Run your agent, then `glassray verify --wait`.",
      );
    }
    return;
  }

  card([
    rule(verified ? "You're all set" : "One step left"),
    ``,
    `  ${bullet(verified ? "ok" : "warn")} ${verified ? "Traces are arriving - Glassray is watching your agent" : "No traces have arrived yet"}`,
    `    ${dim("Account")}    ${cred.orgName}`,
    `    ${dim("Traces")}     ${status.traceCount} received · ${status.sources.length} source${status.sources.length === 1 ? "" : "s"}`,
    `    ${dim("GitHub")}     ${status.github === "connected" ? "connected" : "not connected"}   ${dim("Slack")} ${status.slack === "connected" ? "connected" : "not connected"}`,
    ``,
    verified
      ? `  Review the changes, commit, and get back to building - you won't need the dashboard.`
      : `  Run your agent, then ${bold(paint("glassray verify --wait", PALETTE.brandBright))} to confirm it's flowing.`,
  ]);

  if (!verified) {
    throw new CliError("Almost there - run your agent, then `glassray verify --wait`.");
  }
};
