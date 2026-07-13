/**
 * The `claude` execution seam — the customer's OWN Claude does the semantic
 * instrumentation (their code never transits our infra). It runs Claude Code
 * HEADLESSLY (`claude -p`): Claude applies the change autonomously and then
 * EXITS, returning control to `glassray`. (An interactive TUI would leave the
 * user stuck inside Claude, having to quit it to get back to the setup flow.)
 *
 * We stream Claude's work back as a live activity feed by asking for
 * `--output-format stream-json`, so the run never looks frozen and we can build
 * a real "here's what changed" summary from the tool calls it actually made.
 *
 * The permission model is deliberately SIMPLE — the earlier "allow only
 * `@glassray` installs" allowlist backfired: in headless mode a non-allowlisted
 * tool can't prompt, so every benign `ls` / `which` / `npm view` Claude tried
 * got auto-DENIED, and it churned turns without ever reaching the edit. So now:
 *   - `--permission-mode acceptEdits` — auto-approve file edits (else `-p` runs read-only)
 *   - `--allowedTools Bash`           — let Claude run the shell it needs (install, inspect)
 *   - `--disallowedTools <git writes>`— HARD-deny `git commit`/`git push` (deny beats allow,
 *                                       verified), so nothing is ever committed or pushed
 * The human reviews the diff before committing — that, not install-scoping, is
 * the safety property that matters here.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

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
 * `claude -p` flags: stream events (so we can render a live feed), auto-approve
 * edits, allow the shell Claude needs, and hard-deny git writes.
 */
const HEADLESS_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "acceptEdits",
  "--allowedTools",
  "Bash",
  "--disallowedTools",
  GIT_WRITE_DENY,
];

/** File-mutating tools whose target we surface as an edit in the summary. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Update"]);

/** What a completed Claude run touched — built from the tool calls it actually made. */
export interface ClaudeRunSummary {
  /** Repo-relative paths Claude wrote or edited (successful edits only). */
  edits: string[];
  /** Packages Claude installed (successful installs only). */
  installs: string[];
  /** Claude's closing message, if any — shown only when nothing else surfaced. */
  finalText: string;
}

/** Outcome of a headless run: the process exit code plus the summary. */
export interface ClaudeRunResult extends ClaudeRunSummary {
  code: number;
  /** Tail of stderr, surfaced by the caller when the run fails. */
  errorTail: string;
}

/** A pending tool call awaiting its result, carrying what to record on success. */
interface Pending {
  entry: { kind: "edit"; file: string } | { kind: "install"; packages: string[] } | { kind: "other" };
}

/** If `cmd` is a package install, the packages it installs; else `null`. */
const parseInstall = (cmd: string): string[] | null => {
  const m = cmd.match(/^\s*(?:pnpm add|npm (?:install|i)|yarn add|bun add)\b\s*(.*)$/);
  if (!m) return null;
  // Stop at the first shell operator so a piped/redirected install
  // (`pnpm add x 2>&1 | tail`) doesn't drag `2>&1`/`|`/`tail` into the list.
  const args = (m[1] ?? "").split(/\s*(?:\||&&|;|>|<|2>&1)\s*/)[0] ?? "";
  const specs = args.split(/\s+/).filter((t) => t && !t.startsWith("-"));
  return specs.length > 0 ? specs : null;
};

/** A repo-relative path for display (absolute → relative to cwd, falling back to the input). */
const relPath = (cwd: string, p: string): string =>
  path.isAbsolute(p) ? path.relative(cwd, p) || p : p;

/** Shorten a shell command to a single readable clause. */
const shortCmd = (cmd: string): string => {
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
};

/**
 * A stateful fold over Claude's `stream-json` events. `push(line)` returns a
 * fresh human label when a tool starts (for the live spinner), or `null`
 * otherwise; `summary()` reports what actually landed. Kept pure (no I/O) so it
 * can be unit-tested against a recorded transcript.
 */
export const createClaudeReducer = (cwd: string) => {
  const pending = new Map<string, Pending>();
  const edits = new Set<string>();
  const installs = new Set<string>();
  let finalText = "";

  /** Derive the pending record + live label for a tool call. */
  const classify = (name: string, input: Record<string, unknown>): { entry: Pending["entry"]; label: string } => {
    const file = typeof input.file_path === "string" ? input.file_path : undefined;
    if (EDIT_TOOLS.has(name) && file) {
      const rel = relPath(cwd, file);
      return { entry: { kind: "edit", file: rel }, label: `editing ${rel}` };
    }
    if (name === "Bash" && typeof input.command === "string") {
      const packages = parseInstall(input.command);
      if (packages) return { entry: { kind: "install", packages }, label: `installing ${packages.join(" ")}` };
      return { entry: { kind: "other" }, label: `running ${shortCmd(input.command)}` };
    }
    if (name === "Read" && file) return { entry: { kind: "other" }, label: `reading ${path.basename(file)}` };
    if (name === "Grep" || name === "Glob") return { entry: { kind: "other" }, label: "searching the codebase" };
    return { entry: { kind: "other" }, label: `${name.toLowerCase()}…` };
  };

  return {
    /** Feed one transcript line; returns a live label when a tool starts, else null. */
    push(line: string): string | null {
      const trimmed = line.trim();
      if (!trimmed) return null;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(trimmed);
      } catch {
        return null; // non-JSON line (shouldn't happen with stream-json) — ignore
      }
      if (e.type === "assistant") {
        const content = (e.message as { content?: unknown[] })?.content ?? [];
        let label: string | null = null;
        for (const b of content) {
          const block = b as { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
          if (block.type === "tool_use" && block.id && block.name) {
            const { entry, label: l } = classify(block.name, block.input ?? {});
            pending.set(block.id, { entry });
            label = l; // last tool in the message wins the spinner label
          }
        }
        return label;
      }
      if (e.type === "user") {
        const content = (e.message as { content?: unknown[] })?.content ?? [];
        for (const b of content) {
          const block = b as { type?: string; tool_use_id?: string; is_error?: boolean };
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const p = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          if (!p || block.is_error) continue; // only record tools that SUCCEEDED
          if (p.entry.kind === "edit") edits.add(p.entry.file);
          else if (p.entry.kind === "install") for (const pkg of p.entry.packages) installs.add(pkg);
        }
        return null;
      }
      if (e.type === "result" && typeof e.result === "string") finalText = e.result;
      return null;
    },
    /** Snapshot of what the run installed / edited. */
    summary(): ClaudeRunSummary {
      return { edits: [...edits], installs: [...installs], finalText };
    },
  };
};

/**
 * Run the customer's `claude` on the instrument prompt in `cwd`, headless — it
 * applies the change and exits. The prompt is piped over stdin; stdout is parsed
 * as a `stream-json` event feed (never shown raw), driving `onActivity(label)`
 * for the live spinner and the returned summary. Resolves with the exit code
 * (0 = success) and the summary; rejects only if the process can't be spawned.
 */
export const runClaude = (
  prompt: string,
  cwd: string = process.cwd(),
  onActivity?: (label: string) => void,
): Promise<ClaudeRunResult> =>
  new Promise((resolve, reject) => {
    const onWindows = process.platform === "win32";
    // On Windows the npm-installed `claude` is a `.cmd` shim Node can only exec
    // through a shell; `windowsVerbatimArguments: false` lets Node quote the
    // spacey permission-rule args instead of splitting them on spaces.
    const child = spawn("claude", HEADLESS_ARGS, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: onWindows,
      ...(onWindows ? { windowsVerbatimArguments: false } : {}),
    });

    const reducer = createClaudeReducer(cwd);
    let stdoutBuf = "";
    let sawEvent = false;
    let stderrTail = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      // stream-json is newline-delimited JSON — process whole lines, keep the tail.
      let nl = stdoutBuf.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.trim()) sawEvent = true;
        const label = reducer.push(line);
        if (label && onActivity) onActivity(label);
        nl = stdoutBuf.indexOf("\n");
      }
    });
    // Keep only the tail of stderr — enough to explain a failure, never a flood.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (stdoutBuf.trim()) reducer.push(stdoutBuf); // flush any trailing partial line
      // If we somehow parsed no events (format drift), don't hide Claude's output.
      if (!sawEvent && stderrTail.trim()) process.stderr.write(stderrTail);
      resolve({ code: code ?? 0, errorTail: stderrTail.trim(), ...reducer.summary() });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });
