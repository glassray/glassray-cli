/**
 * The branded landing screen — what bare `glassray` and `glassray --help` print:
 * the mark, the command reference, and the guide links. Ported in spirit from
 * `coach/bin/landing.mjs`, retargeted to the umbrella CLI's command surface.
 */
import {
  bold,
  compactBrand,
  dim,
  GUIDES,
  heading,
  link,
  maybeScheduleUpdateRefresh,
  MODE_OUT,
  PALETTE,
  paint,
  readUpdateNotice,
  renderMark,
  VERSION,
} from "../lib/ui.js";

/** The command reference, grouped the way people use it. */
const COMMAND_SECTIONS: { title: string; note?: string; rows: [string, string][] }[] = [
  {
    title: "SET UP (cloud)",
    rows: [
      ["setup", "One-shot: pair · connect · instrument · verify (the orchestrator)"],
      ["login / logout", "Pair this machine with your Glassray org (device grant)"],
      ["detect", "Inspect this repo: framework, tracing, provider keys"],
      ["connect <target>", "otlp · langsmith · langfuse · posthog · github · slack"],
      ["instrument", "Wire the SDK + tags (runs `claude -p`, or --prompt-only)"],
      ["verify", "The exit gate: poll until a real trace lands"],
      ["status / whoami", "Account aggregate · who the key resolves to"],
    ],
  },
  {
    title: "LOCAL COACH",
    note: "start runs the local server · data verbs print JSON verbatim (:5899)",
    rows: [
      ["start", "Run the local Coach server (installs @glassray/coach on demand)"],
      ["traces", "list · get <id> · tail"],
      ["flows / evals", "list · get · create · update · delete · run · audit · discover"],
      ["deviations", "list · get <id> · resolve <id> · discover"],
      ["deviations discover", "Find recurring failures across recent traces (alias: discovery run)"],
      ["experiments", "list · get <id>"],
      ["fix <deviationId>", "Generate a fix doc for your coding agent"],
      ["runs · stats · usage", "Background runs · store rollups · LLM spend"],
      ["pull / push / check", "glassray.yaml round-trip · the CI gate (via @glassray/coach)"],
      ["run / compare / link", "Label a run · A/B two labels · link a cloud project"],
    ],
  },
  {
    title: "MANAGE",
    rows: [
      ["init", "Install the agent skill (.claude/ + .agents/)"],
      ["mcp add|remove", "Register the cloud MCP server in .mcp.json (token via ${GLASSRAY_TOKEN})"],
      ["token", "Print the stored org key — export GLASSRAY_TOKEN=\"$(glassray token)\""],
      ["doctor", "Local + cloud health checks"],
      ["upgrade", "How to self-update"],
    ],
  },
];

/** Two-column row: fixed-width bright-bold command cell + its description. */
const row = (cell: string, description: string, cellWidth: number): string =>
  `    ${bold(paint(cell.padEnd(cellWidth), PALETTE.brandBright))}  ${description}`;

/** Render the landing screen as one string. */
export const renderLanding = (width: number = process.stdout.columns ?? 80): string => {
  const out: string[] = [];
  const wide = width >= 50 && MODE_OUT !== "plain";

  if (wide) {
    const mark = renderMark(MODE_OUT);
    const right = ["", `${bold("g l a s s r a y")}   ${dim(`v${VERSION}`)}`, "", "The self-improving AI-agent platform CLI.", "", ""];
    for (let i = 0; i < mark.length; i += 1) out.push(`  ${mark[i]}      ${right[i] ?? ""}`.trimEnd());
  } else {
    out.push(`  ${compactBrand()}`);
    out.push("  The self-improving AI-agent platform CLI.");
  }
  out.push("");

  const cellWidth = Math.max(...COMMAND_SECTIONS.flatMap((s) => s.rows.map(([cell]) => cell.length)));
  for (const section of COMMAND_SECTIONS) {
    out.push(`  ${heading(section.title)}${section.note ? `   ${dim(section.note)}` : ""}`);
    for (const [cell, description] of section.rows) out.push(row(cell, description, cellWidth));
    out.push("");
  }

  out.push(`  ${heading("LEARN")}`);
  out.push(`    ${"Setup guide".padEnd(cellWidth)}  ${link(GUIDES.setup)}`);
  out.push(`    ${"CLI reference".padEnd(cellWidth)}  ${link(GUIDES.cli)}`);
  out.push(`    ${"Local Coach".padEnd(cellWidth)}  ${link(GUIDES.coach)}`);
  out.push(`    ${"Source".padEnd(cellWidth)}  ${link(GUIDES.github)}`);
  out.push("");
  out.push(`  Run ${bold(paint("glassray <command> --help", PALETTE.brandBright))} for flags, or ${bold(paint("glassray setup", PALETTE.brandBright))} to begin.`);

  const notice = readUpdateNotice();
  if (notice) {
    out.push("");
    out.push(`  ${notice}`);
  }
  out.push("");
  return out.join("\n");
};

/** Print the landing screen (bare command / `--help`). */
export const showLanding = (): void => {
  maybeScheduleUpdateRefresh();
  process.stdout.write(`${renderLanding()}\n`);
};
