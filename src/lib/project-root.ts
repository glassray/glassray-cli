/**
 * Guard for "am I standing in the user's project?". `glassray setup` writes the
 * ingest key, `.mcp.json`, and the SDK wiring into the CURRENT directory — run
 * from home, a bare shell, or a Spotlight-launched terminal, all of that lands
 * in the wrong place (or nowhere useful). These pure helpers decide whether a
 * directory is a plausible project root and resolve a user-typed replacement;
 * the interactive prompt loop lives in `setup`.
 */
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Manifest files that mark a directory as the top of a project. One is enough —
 * it's the strong signal that "this is where code + config live". Kept broad so
 * non-JS/Python stacks (Go, Rust, Java, Ruby, PHP) aren't false-negatives.
 */
const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
] as const;

/** The verdict for a directory: whether it's a plausible root, and why (for the status line). */
export interface RootCheck {
  /** True when `dir` holds a project manifest or sits inside a git working tree. */
  ok: boolean;
  /** Human reason it passed (markers found, or "git repository"); null when it didn't. */
  reason: string | null;
}

/** The project-marker files present directly in `dir`. */
const markersIn = (dir: string): string[] => PROJECT_MARKERS.filter((m) => existsSync(path.join(dir, m)));

/**
 * Whether `dir` sits inside a git working tree — a `.git` in `dir` or any
 * ancestor below the home directory. We stop at home (and never cross it) so a
 * dotfiles repo at `~/.git` can't make an arbitrary `~/somewhere` look like a
 * project.
 */
const insideGitRepo = (dir: string): boolean => {
  const home = path.resolve(os.homedir());
  let cur = path.resolve(dir);
  for (;;) {
    if (cur === home) return false;
    if (existsSync(path.join(cur, ".git"))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false; // reached the filesystem root
    cur = parent;
  }
};

/**
 * Decide whether `dir` is a plausible place to instrument. A project manifest
 * in the directory, or being inside a git repo, both qualify. The home directory
 * and the filesystem root are NEVER plausible — running setup there (a bare
 * shell, Spotlight) is the exact mistake this guards, even if a stray manifest
 * or dotfiles `.git` happens to live there.
 */
export const checkProjectRoot = (dir: string): RootCheck => {
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(os.homedir()) || resolved === path.parse(resolved).root) {
    return { ok: false, reason: null };
  }
  const markers = markersIn(resolved);
  if (markers.length > 0) return { ok: true, reason: markers.slice(0, 3).join(", ") };
  if (insideGitRepo(resolved)) return { ok: true, reason: "git repository" };
  return { ok: false, reason: null };
};

/** Expand a leading `~` to the home directory (so a typed `~/code/app` resolves). */
const expandHome = (p: string): string =>
  p === "~" ? os.homedir() : p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(2)) : p;

/** The outcome of resolving a user-typed project path. */
export type DirResolution =
  | { ok: true; dir: string; root: RootCheck }
  | { ok: false; error: string };

/**
 * Resolve a user-typed path (relative to `base`, `~` expanded) to an existing
 * directory, reporting why it failed when it doesn't. On success it also carries
 * the `RootCheck` so the caller can warn when the chosen dir still doesn't look
 * like a project.
 */
export const resolveProjectDir = (input: string, base: string = process.cwd()): DirResolution => {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "enter a path" };
  const resolved = path.resolve(base, expandHome(trimmed));
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return { ok: false, error: `no such directory: ${resolved}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `not a directory: ${resolved}` };
  return { ok: true, dir: resolved, root: checkProjectRoot(resolved) };
};
