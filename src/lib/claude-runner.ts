/**
 * The `claude` execution seam. When the Claude Code binary is on PATH, the CLI
 * runs `claude -p <prompt>` and streams its output — the customer's OWN Claude
 * does the semantic instrumentation work (their code never transits our infra).
 * Otherwise the prompt is returned for `--prompt-only` to print. See
 * docs/onboarding-wizard.md §2.
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
 * Run `claude -p <prompt>` in the given cwd, inheriting stdio so the user sees
 * the session live. Resolves with the exit code (0 = success). Rejects only if
 * the process could not be spawned.
 */
export const runClaude = (prompt: string, cwd: string = process.cwd()): Promise<number> =>
  new Promise((resolve, reject) => {
    // Pass the prompt over stdin (`claude -p` reads it) instead of as an argv
    // element, so there is nothing for a shell to re-parse. `shell: true` on
    // Windows lets the npm-installed `claude.cmd` shim resolve — Node refuses to
    // exec a `.cmd` directly without a shell, which otherwise ENOENTs even though
    // `hasClaude()` (via `where`) reports it available.
    const child = spawn("claude", ["-p"], {
      cwd,
      stdio: ["pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });
