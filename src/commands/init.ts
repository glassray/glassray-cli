/**
 * `glassray init` — install the bundled agent skill into the repo, dual-written
 * to both standard locations (ported from `coach/bin/glassray.mjs`): `.claude/`
 * for Claude Code and `.agents/` for the open Agent Skills standard (Codex, VS
 * Code, Copilot). Refuses to clobber a locally-edited copy without `--force`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boolFlag, parseCommand, type Context } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { bullet, card, dim, link, printData, GUIDES } from "../lib/ui.js";

/** Relative install destinations (both AI-tool skill directories). */
const SKILL_DESTS = [
  path.join(".claude", "skills", "glassray", "SKILL.md"),
  path.join(".agents", "skills", "glassray", "SKILL.md"),
];

/** Resolve the bundled SKILL.md asset, tolerating both the built bundle and `tsx` dev. */
const resolveSkillSource = (): string => {
  const candidates = [
    // From the built bundle: dist/bin.js → ../assets/skill/SKILL.md
    fileURLToPath(new URL("../assets/skill/SKILL.md", import.meta.url)),
    // From `tsx` dev: src/commands/init.ts → ../../assets/skill/SKILL.md
    fileURLToPath(new URL("../../assets/skill/SKILL.md", import.meta.url)),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new CliError(`bundled skill asset not found (looked in: ${candidates.join(", ")})`);
  return found;
};

/** The `init` command. */
export const cmdInit = async (ctx: Context, args: string[]): Promise<void> => {
  const { values } = parseCommand(args, { force: { type: "boolean" } });
  const force = boolFlag(values, "force");
  const source = readFileSync(resolveSkillSource(), "utf8");
  const dests = SKILL_DESTS.map((rel) => path.join(process.cwd(), rel));

  // Refuse before touching anything if either copy was edited (unless --force).
  if (!force) {
    for (const dest of dests) {
      if (existsSync(dest) && readFileSync(dest, "utf8") !== source) {
        throw new CliError(`${dest} exists with different content — pass --force to overwrite`);
      }
    }
  }

  let wrote = 0;
  for (const dest of dests) {
    if (!force && existsSync(dest) && readFileSync(dest, "utf8") === source) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, source);
    wrote += 1;
  }

  if (ctx.json) {
    printData({ installed: dests, wrote });
    return;
  }
  card([
    `  ${bullet("ok")} agent skill ${wrote === 0 ? "already installed (up to date)" : "installed"}`,
    `    ${dests[0]}   ${dim("(Claude Code)")}`,
    `    ${dests[1]}   ${dim("(Agent Skills standard — Codex, VS Code, Copilot)")}`,
    ``,
    `  Docs: ${link(GUIDES.cli)}`,
  ]);
};
