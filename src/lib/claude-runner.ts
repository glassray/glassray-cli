/**
 * The `claude` execution seam — the customer's OWN Claude does the semantic
 * instrumentation (their code never transits our infra). It runs Claude Code
 * HEADLESSLY (`claude -p`): Claude applies the change autonomously and then
 * EXITS, returning control to `glassray`. (An interactive TUI would leave the
 * user stuck inside Claude, having to quit it to get back to the setup flow.)
 * Its output streams to the terminal so the run is visible. A scoped permission
 * set keeps it safe and non-interactive:
 *   - `--permission-mode acceptEdits` — auto-approve file edits (else `-p` runs read-only)
 *   - `--allowedTools`   — permit ONLY installs of the `@glassray` npm scope, nothing else
 *   - `--disallowedTools`— HARD-deny `git commit`/`git push` (deny beats acceptEdits)
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
 * Deny rules that HARD-BLOCK the spawned Claude from committing or pushing. Deny
 * beats acceptEdits and the allow-list, so it can't be worked around. Read-only
 * git (`status`, `diff`) stays allowed so Claude can still inspect the diff.
 * Covers the bare + arg forms and the `git -C <path>` escape.
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
 * Scoped install allow-list: pre-approve ONLY installs of the `@glassray` npm
 * scope, never arbitrary packages. Two forms per manager — `<pm> <verb>
 * @glassray/*` (the exact command the prompt runs, plus any version/flags after
 * it) and `<pm> <verb> * @glassray/*` (a flag placed BEFORE the package).
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

/** `claude -p` permission flags: auto-approve edits, permit only `@glassray` installs, deny git writes. */
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
 * Run the customer's `claude` on the instrument prompt in `cwd`, headless — it
 * applies the change and exits. The prompt is piped over stdin; stdout/stderr
 * are inherited so the run is visible. Resolves with the exit code (0 = success);
 * rejects only if the process could not be spawned.
 */
export const runClaude = (prompt: string, cwd: string = process.cwd()): Promise<number> =>
  new Promise((resolve, reject) => {
    const onWindows = process.platform === "win32";
    // On Windows the npm-installed `claude` is a `.cmd` shim Node can only exec
    // through a shell; `windowsVerbatimArguments: false` lets Node quote the
    // spacey permission-rule args instead of splitting them on spaces.
    const child = spawn("claude", HEADLESS_ARGS, {
      cwd,
      stdio: ["pipe", "inherit", "inherit"],
      shell: onWindows,
      ...(onWindows ? { windowsVerbatimArguments: false } : {}),
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });
