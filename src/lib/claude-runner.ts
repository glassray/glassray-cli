/**
 * The `claude` execution seam — the customer's OWN Claude does the semantic
 * instrumentation (their code never transits our infra). Two modes, both with a
 * hard git-write block so the spawned session can never commit or push:
 *
 * - **interactive** (default when a human is at the terminal): launch the full
 *   `claude` TUI in the SAME terminal, seeded with the prompt, inheriting stdio.
 *   The user watches it work and approves its edits through Claude Code's own
 *   permission prompts; control returns here when they exit. No forced
 *   auto-accept — normal interactive approval applies — but `@glassray` installs
 *   are pre-approved (same scoped allow-list as headless) and `git commit`/`push`
 *   are HARD-denied (a deny rule can't be clicked past).
 * - **headless** (`claude -p`, for non-TTY / CI / `--json`): pipe the prompt over
 *   stdin. Because `-p` cannot approve any tool on its own (it would run
 *   read-only), we grant a SCOPED permission set: auto-accept file edits, allow
 *   ONLY installs of the `@glassray` npm scope, and deny git writes.
 *
 * Rule precedence is deny → allow, so the git-deny beats acceptEdits, the
 * allow-list, AND interactive approval in every mode. See docs/onboarding-wizard.md §2.
 */
import { spawn, spawnSync } from "node:child_process";

/** Whether the `claude` binary is resolvable on PATH. */
export const hasClaude = (): boolean => {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(probe, ["claude"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
};

/**
 * Deny rules that HARD-BLOCK the spawned Claude from committing or pushing in
 * BOTH modes. Deny beats acceptEdits, the allow-list, and interactive approval,
 * so it can't be clicked past. Read-only git (`status`, `diff`) stays allowed so
 * Claude can still show the diff. Covers the bare + arg forms and the
 * `git -C <path>` escape (compound `a && b` is checked per-subcommand upstream).
 */
const GIT_WRITE_DENY = [
  "Bash(git commit)",
  "Bash(git commit *)",
  "Bash(git push)",
  "Bash(git push *)",
  "Bash(git -C * commit*)",
  "Bash(git -C * push*)",
].join(",");

/**
 * Scoped install allow-list, applied in BOTH modes: pre-approve ONLY installs of
 * the `@glassray` npm scope, never arbitrary packages (headless auto-runs them;
 * interactive skips the approval prompt for them). Two forms per manager —
 * `<pm> <verb> @glassray/*` (the exact command the prompt runs, plus any
 * version/flags after it) and `<pm> <verb> * @glassray/*` (a flag placed
 * BEFORE the package). Both require `@glassray/`, so nothing else installs.
 */
const GLASSRAY_INSTALL_ALLOW = [
  "Bash(pnpm add @glassray/*)",
  "Bash(pnpm add * @glassray/*)",
  "Bash(npm install @glassray/*)",
  "Bash(npm install * @glassray/*)",
  "Bash(npm i @glassray/*)",
  "Bash(npm i * @glassray/*)",
  "Bash(yarn add @glassray/*)",
  "Bash(yarn add * @glassray/*)",
  "Bash(bun add @glassray/*)",
  "Bash(bun add * @glassray/*)",
].join(",");

/**
 * Headless (`claude -p`) permission flags: auto-approve file edits, permit only
 * `@glassray` installs, deny git writes. Without these `-p` approves no tools and
 * runs read-only.
 */
const HEADLESS_ARGS = [
  "-p",
  "--permission-mode",
  "acceptEdits",
  "--allowedTools",
  GLASSRAY_INSTALL_ALLOW,
  "--disallowedTools",
  GIT_WRITE_DENY,
];

/**
 * Interactive flags: the same scoped permission shape as headless — `@glassray`
 * installs are pre-approved (no prompt for the one install the task needs) and
 * git writes stay hard-denied regardless of what the user clicks. Everything
 * else (edits, other commands) still goes through Claude Code's normal
 * interactive approval prompts.
 */
const INTERACTIVE_ARGS = [
  "--allowedTools",
  GLASSRAY_INSTALL_ALLOW,
  "--disallowedTools",
  GIT_WRITE_DENY,
];

/**
 * Run the customer's `claude` on the instrument prompt in `cwd`.
 *
 * `interactive` (default) launches the full TUI seeded with the prompt so the
 * user drives and approves it; `false` runs headless `claude -p` with the scoped
 * permission set above. Resolves with the exit code (0 = success); rejects only
 * if the process could not be spawned.
 */
export const runClaude = (
  prompt: string,
  cwd: string = process.cwd(),
  interactive = true,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const onWindows = process.platform === "win32";
    // On Windows the npm-installed `claude` is a `.cmd` shim Node can only exec
    // through a shell — but a shell re-parses argv, which would mangle a
    // multi-line prompt. So Windows always takes the headless stdin path (prompt
    // piped, never in argv); posix gets the interactive TUI when asked.
    const useInteractive = interactive && !onWindows;
    const child = useInteractive
      ? // Interactive: prompt is a positional arg (stdin is the live TTY); the
        // user approves edits through Claude Code's prompts, git stays denied.
        spawn("claude", [prompt, ...INTERACTIVE_ARGS], { cwd, stdio: "inherit" })
      : // Headless: prompt over stdin, scoped permission flags so edits apply.
        // `windowsVerbatimArguments: false` lets Node quote the spacey rule args
        // for cmd (shell:true otherwise passes them verbatim and splits on spaces).
        spawn("claude", HEADLESS_ARGS, {
          cwd,
          stdio: ["pipe", "inherit", "inherit"],
          shell: onWindows,
          ...(onWindows ? { windowsVerbatimArguments: false } : {}),
        });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
    if (!useInteractive) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
    }
  });
