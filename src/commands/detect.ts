/**
 * `glassray detect` — inspect the current repo and print what the wizard sees:
 * package manager, framework, existing tracing, provider env keys, and the
 * recommended ingestion path. `--json` emits the structured report.
 */
import { parseCommand, type Context } from "../lib/context.js";
import { detect, summarizeDetect } from "../lib/detect.js";
import { bullet, card, dim, printData } from "../lib/ui.js";

/** The `detect` command. */
export const cmdDetect = async (ctx: Context, args: string[]): Promise<void> => {
  parseCommand(args);
  const report = detect();
  if (ctx.json) {
    printData(report);
    return;
  }
  const alts =
    report.recommended.alternatives.length > 0
      ? `  ${dim(`(or connect ${report.recommended.alternatives.join(" / ")})`)}`
      : "";
  card([
    `  ${bullet("ok")} Your repo — ${summarizeDetect(report)}`,
    `    ${dim("Directory")}   ${report.cwd}`,
    `    ${dim("Suggested")}   ${report.recommended.reason}${alts}`,
  ]);
};
