/**
 * Builds the scoped instrumentation prompt handed to the customer's Claude (or
 * printed with `--prompt-only`): wire the `@glassray/tracing` SDK and stamp the
 * four Glassray metadata tags. Single-source so the prompt and the SDK can't
 * drift.
 *
 * The four attribute NAMES are hardcoded here (not imported) to keep this package
 * dependency-free. Keep them in sync with the Glassray trace metadata convention
 * (the `glassray.*` vocabulary): if the convention changes, update this list.
 */
import type { DetectReport } from "./detect.js";

/** The four Glassray metadata attribute names the instrumented agent must emit. */
export const GLASSRAY_TAGS = {
  customer: "glassray.customer",
  environment: "glassray.environment",
  agent: "glassray.agent",
  flow: "glassray.flow",
} as const;

/** Inputs to the prompt template. */
export interface InstrumentPromptInput {
  /** The OTLP endpoint the SDK exporter should target. */
  endpoint: string;
  /** The env var name the ingest key lives under (`.env.local`). */
  ingestKeyEnvVar: string;
  /** Repo detection (framework/pkg manager), so the prompt is concrete. */
  detect: DetectReport;
}

/** Compose the instrumentation prompt as a single string. */
export const buildInstrumentPrompt = (input: InstrumentPromptInput): string => {
  const { endpoint, ingestKeyEnvVar, detect } = input;
  const fw = detect.framework ? `${detect.framework} ` : "";
  const pm = detect.packageManager === "unknown" ? "your package manager" : detect.packageManager;
  const installCmd =
    detect.packageManager === "unknown" ? "npm install @glassray/tracing" : `${detect.packageManager} add @glassray/tracing`;
  const tagList = Object.entries(GLASSRAY_TAGS)
    .map(([label, attr]) => `    - \`${attr}\` — the ${label}`)
    .join("\n");

  return [
    `You are wiring Glassray tracing into this ${fw}repository. Make a small, reviewable change — nothing more.`,
    ``,
    `## 1. Install the SDK`,
    ``,
    detect.language === "python"
      ? "Add the OpenTelemetry OTLP exporter for your stack (the agent already may have `@opentelemetry` deps — reuse them)."
      : `Install \`@glassray/tracing\` with ${pm} (e.g. \`${installCmd}\`).`,
    ``,
    `## 2. Initialize tracing at the process entry point`,
    ``,
    `Point the exporter at the Glassray OTLP endpoint and read the ingest key from the environment:`,
    ``,
    "```",
    `OTLP endpoint : ${endpoint}`,
    `Auth header   : Authorization: Bearer <${ingestKeyEnvVar}>   (already written to .env.local)`,
    "```",
    ``,
    `Initialize the SDK **before** any agent/LLM code runs, and flush on shutdown so short-lived runs don't drop spans.`,
    ``,
    `## 3. Stamp the four Glassray metadata tags`,
    ``,
    `Set these as resource-level attributes (per-process defaults), overridable on the root span per request:`,
    ``,
    tagList,
    ``,
    `Give each a real, stable value from this codebase — the agent's name, the deployment environment, the tenant/customer identifier, and the logical flow/behaviour. These tags drive every breakdown in Glassray; an untagged trace silently breaks them.`,
    ``,
    `## 4. Keep it bounded`,
    ``,
    `Touch only what wiring requires (entry point + config). Do not refactor unrelated code. Show the diff and stop.`,
    ``,
    `**Do not run \`git commit\`, \`git push\`, or any other git command that writes or publishes** — leave every change uncommitted in the working tree. The human reviews the diff and commits it themselves. Reading git state (\`git status\`, \`git diff\`) is fine.`,
  ].join("\n");
};
