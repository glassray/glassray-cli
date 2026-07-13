/**
 * glassray CLI branding kit — zero-dependency, ported from the Coach CLI's
 * `bin/ui.mjs` (converted to TypeScript). Owns everything human-facing: terminal
 * color-capability detection (truecolor → 256 → 16 → plain, honoring NO_COLOR /
 * FORCE_COLOR / dumb / pipes), the brand palette, the pixel-exact Glassray mark,
 * text primitives, clickable OSC-8 links, the branded-card writers, a small
 * spinner, and the npm update check (retargeted to the `@glassray/cli`
 * package).
 *
 * Output discipline: cards + machine JSON go to STDOUT; all status, progress,
 * and error chrome go to STDERR. Data commands (loopback JSON) print verbatim
 * JSON only and never touch these decorators.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The CLI's own version, read from package.json (this bundle lives in dist/). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Terminal color depth for one output stream. */
export type ColorMode = "truecolor" | "256" | "16" | "plain";

/** Detect the color depth to use for one stream. */
const detectMode = (stream: NodeJS.WriteStream): ColorMode => {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "plain";
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0";
  if (!forced) {
    if (stream.isTTY !== true) return "plain";
    if (env.TERM === "dumb") return "plain";
  }
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || forced) return "truecolor";
  if ((env.TERM ?? "").includes("256color")) return "256";
  return "16";
};

/** Color mode for stdout (the landing/help/cards stream). */
export const MODE_OUT: ColorMode = detectMode(process.stdout);
/** Color mode for stderr (errors + progress lines). */
export const MODE_ERR: ColorMode = detectMode(process.stderr);

/** One palette entry: the truecolor hex plus its 16-color ANSI fallback code. */
interface PaletteEntry {
  hex: string;
  ansi16: string;
}

/** One palette entry factory. */
const entry = (hex: string, ansi16: string): PaletteEntry => ({ hex, ansi16 });

/** The brand palette, mapped from the product tokens (parity with Coach). */
export const PALETTE = {
  /** Forest green — ok-states and the mark's base. */
  brand: entry("#166534", "32"),
  /** Luminous brand green — readable as TEXT on dark terminals. */
  brandBright: entry("#3fb950", "92"),
  /** Acid — the accent; update notices. */
  acid: entry("#ddff1a", "93"),
  /** Muted ink — secondary text, headings. */
  muted: entry("#787872", "90"),
  /** Warning amber. */
  warn: entry("#ffb347", "33"),
  /** Error red. */
  error: entry("#ff5f4d", "31"),
} as const;

/** A color argument is either a palette entry or a raw `#rrggbb` string. */
type Color = PaletteEntry | string;

/** Parse `#rrggbb` into [r, g, b]. */
const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Nearest xterm-256 cube index for an rgb triple. */
const to256 = ([r, g, b]: [number, number, number]): number =>
  16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);

/** The SGR color prefix for a color at a given mode; '' when plain. */
const colorCode = (color: Color, mode: ColorMode): string => {
  const hex = typeof color === "string" ? color : color.hex;
  switch (mode) {
    case "truecolor": {
      const [r, g, b] = hexToRgb(hex);
      return `\x1b[38;2;${r};${g};${b}m`;
    }
    case "256":
      return `\x1b[38;5;${to256(hexToRgb(hex))}m`;
    case "16":
      return `\x1b[${typeof color === "string" ? "39" : color.ansi16}m`;
    default:
      return "";
  }
};

/** Paint text in a color for stdout; no-op when plain. */
export const paint = (text: string, color: Color, mode: ColorMode = MODE_OUT): string => {
  const code = colorCode(color, mode);
  return code === "" ? text : `${code}${text}\x1b[39m`;
};

/** Paint for stderr (errors, progress). */
export const paintErr = (text: string, color: Color): string => paint(text, color, MODE_ERR);

/** Bold text (stdout); no-op when plain. */
export const bold = (text: string, mode: ColorMode = MODE_OUT): string =>
  mode === "plain" ? text : `\x1b[1m${text}\x1b[22m`;

/** Dim text (stdout); no-op when plain. */
export const dim = (text: string, mode: ColorMode = MODE_OUT): string =>
  mode === "plain" ? text : `\x1b[2m${text}\x1b[22m`;

/** A section heading: bold, muted, already-uppercase label. */
export const heading = (text: string): string => bold(paint(text, PALETTE.muted));

/** Status-bullet state → color. */
type BulletState = "ok" | "warn" | "down";

/** A status bullet: ● in green (ok) / amber (warn) / red (down), for stdout cards. */
export const bullet = (state: BulletState): string =>
  paint("●", state === "ok" ? PALETTE.brand : state === "warn" ? PALETTE.warn : PALETTE.error);

/** A status bullet for stderr status lines. */
export const bulletErr = (state: BulletState): string =>
  paintErr("●", state === "ok" ? PALETTE.brand : state === "warn" ? PALETTE.warn : PALETTE.error);

/** A red ✗ error prefix for stderr lines. */
export const cross = (): string => paintErr("✗", PALETTE.error);

/**
 * A styled URL — an OSC-8 clickable hyperlink on truecolor terminals, a colored
 * URL elsewhere, the bare URL when plain.
 */
export const link = (url: string, mode: ColorMode = MODE_OUT): string => {
  if (mode === "plain") return url;
  const painted = paint(url, PALETTE.brandBright, mode);
  return mode === "truecolor" ? `\x1b]8;;${url}\x1b\\${painted}\x1b]8;;\x1b\\` : painted;
};

// ── the mark ─────────────────────────────────────────────────────────────────

/**
 * The Glassray mark, verbatim from glassray-mark.svg's rect grid: a 15×11 bitmap.
 * '#' = pixel.
 */
export const MARK_BITMAP: string[] = [
  "......#.#......",
  ".....#####.....",
  "..###########..",
  "###############",
  ".#############.",
  "...#########...",
  ".....#####.....",
  "......###......",
  ".......#.......",
  ".......#.......",
  ".......#.......",
];

/** The mark's own fill, verbatim from the SVG (near-white). */
const MARK_COLOR = entry("#f4f5f7", "97");

/** Render the mark as 6 terminal lines of Unicode half-blocks. */
export const renderMark = (mode: ColorMode = MODE_OUT): string[] => {
  const lines: string[] = [];
  for (let r = 0; r < MARK_BITMAP.length; r += 2) {
    const top = MARK_BITMAP[r] ?? "";
    const bottom = MARK_BITMAP[r + 1] ?? ".".repeat(top.length);
    let line = "";
    for (let col = 0; col < top.length; col += 1) {
      const t = top[col] === "#";
      const b = bottom[col] === "#";
      line += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.map((line) => (mode === "plain" ? line : paint(line, MARK_COLOR, mode)));
};

/** The narrow/pipe fallback brand line. */
export const compactBrand = (): string =>
  `${paint("◆", PALETTE.acid)} ${bold("glassray")} ${dim(`v${VERSION}`)}`;

/**
 * A branded banner for the top of a command (the mark beside a title + tagline).
 * Written to stderr so it never pollutes `--json` stdout; skipped entirely in
 * JSON mode and on plain/piped output.
 */
export const banner = (title: string, tagline?: string): void => {
  if (jsonMode || MODE_ERR === "plain") return;
  const mark = renderMark(MODE_ERR);
  const right = ["", `${bold(title, MODE_ERR)}`, tagline ? dim(tagline, MODE_ERR) : ""];
  const lines: string[] = [""];
  for (let i = 0; i < mark.length; i += 1) {
    lines.push(`  ${mark[i]}   ${right[i] ?? ""}`.replace(/\s+$/, ""));
  }
  process.stderr.write(`${lines.join("\n")}\n\n`);
};

// ── guide links ──────────────────────────────────────────────────────────────

/** The canonical docs/repo links used across the CLI. */
export const GUIDES = {
  setup: "https://glassray.ai/docs/cli/setup",
  cli: "https://glassray.ai/docs/cli/reference",
  coach: "https://glassray.ai/docs/coach/overview",
  quickstart: "https://glassray.ai/docs/coach/quickstart",
  github: "https://github.com/glassray/glassray-cli",
} as const;

// ── json mode + status writers ───────────────────────────────────────────────

/** When true, commands emit machine JSON to stdout; status chrome still goes to stderr. */
let jsonMode = false;
/** Enable/disable machine-JSON mode (set once from the global `--json` flag). */
export const setJsonMode = (value: boolean): void => {
  jsonMode = value;
};
/** Whether machine-JSON mode is active. */
export const isJsonMode = (): boolean => jsonMode;

/** The ONE machine-data writer: pretty JSON on stdout, nothing else. */
export const printData = (body: unknown): void => {
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
};

/** Print a branded card block to stdout (blank line above and below; lines carry their own indent). */
export const card = (lines: string[]): void => {
  if (jsonMode) return;
  process.stdout.write(`\n${lines.join("\n")}\n\n`);
};

/** Compose a divider rule with a centered-left label, brand-styled (for report headers). */
export const rule = (label: string): string =>
  `  ${paint("──", PALETTE.muted)} ${bold(label)} ${paint("─".repeat(Math.max(2, 52 - label.length)), PALETTE.muted)}`;

/** A neutral status line on stderr (suppressed in JSON mode). */
export const info = (message: string): void => {
  if (!jsonMode) process.stderr.write(`  ${message}\n`);
};

/** A green-● success line on stderr (suppressed in JSON mode). */
export const success = (message: string): void => {
  if (!jsonMode) process.stderr.write(`  ${bulletErr("ok")} ${message}\n`);
};

/** An amber-● warning line on stderr (suppressed in JSON mode). */
export const warn = (message: string): void => {
  if (!jsonMode) process.stderr.write(`  ${bulletErr("warn")} ${message}\n`);
};

/** A red-✗ error line on stderr (always shown — errors matter even in JSON mode). */
export const errorLine = (message: string): void => {
  process.stderr.write(`  ${cross()} ${message}\n`);
};

/** A dim, indented secondary line on stderr (suppressed in JSON mode). */
export const detail = (message: string): void => {
  if (!jsonMode) process.stderr.write(`    ${dim(message, MODE_ERR)}\n`);
};

// ── spinner ──────────────────────────────────────────────────────────────────

/** Braille spinner frames. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A live-updating stderr spinner handle. */
export interface Spinner {
  /** Replace the spinner's label. */
  update: (text: string) => void;
  /** Stop and print a green-● success line. */
  succeed: (text?: string) => void;
  /** Stop and print a red-✗ failure line. */
  fail: (text?: string) => void;
  /** Stop and clear the line, printing nothing. */
  stop: () => void;
}

/**
 * Start a single-line stderr spinner. Animates only on an interactive TTY and
 * outside JSON mode; otherwise it degrades to one static status line so logs
 * stay clean.
 */
export const spinner = (initial: string): Spinner => {
  const animated = process.stderr.isTTY === true && !jsonMode;
  let text = initial;
  let frame = 0;
  let timer: NodeJS.Timeout | null = null;
  let lastLen = 0;

  /** Erase the current spinner line in place. */
  const clearLine = (): void => {
    if (lastLen > 0) process.stderr.write(`\r${" ".repeat(lastLen)}\r`);
    lastLen = 0;
  };
  /** Redraw the spinner line in place. */
  const render = (): void => {
    const line = `  ${paintErr(SPINNER_FRAMES[frame] ?? "", PALETTE.acid)} ${text}`;
    process.stderr.write(`\r${line}`);
    lastLen = Math.max(lastLen, stripAnsiLength(line));
  };
  /** Stop the animation loop. */
  const halt = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  if (animated) {
    render();
    timer = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      render();
    }, 90);
    if (typeof timer.unref === "function") timer.unref();
  } else if (!jsonMode) {
    process.stderr.write(`  ${text}\n`);
  }

  return {
    update: (next) => {
      text = next;
      if (animated) render();
    },
    succeed: (next) => {
      halt();
      if (animated) clearLine();
      success(next ?? text);
    },
    fail: (next) => {
      halt();
      if (animated) clearLine();
      errorLine(next ?? text);
    },
    stop: () => {
      halt();
      if (animated) clearLine();
    },
  };
};

/** Visible length of a string, ignoring ANSI SGR + OSC-8 escapes (for line clearing). */
const stripAnsiLength = (s: string): number =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").length;

// ── update check (retargeted to the `@glassray/cli` package) ───────────────

/** Base config dir for the CLI (mirrors config.ts without importing it, to stay cycle-free). */
const cacheDir = (): string =>
  process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "glassray")
    : path.join(os.homedir(), ".config", "glassray");

/** Cache file recording the last registry check. */
const updateCachePath = (): string => path.join(cacheDir(), "update-check.json");

/** How long a registry answer stays fresh before a background refresh (24 h). */
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;

/** The npm registry endpoint for the `@glassray/cli` package. */
const REGISTRY_URL = "https://registry.npmjs.org/@glassray%2Fcli/latest";

/** True when the user (or the environment) opted out of update checks entirely. */
export const updateCheckOptedOut = (): boolean =>
  Boolean(process.env.GLASSRAY_NO_UPDATE_CHECK) ||
  Boolean(process.env.NO_UPDATE_NOTIFIER) ||
  Boolean(process.env.CI);

/** True when the passive check may run at all: not opted out, and a human is watching. */
const updateCheckEnabled = (): boolean => !updateCheckOptedOut() && process.stdout.isTTY === true;

/** Compare two `x.y.z` versions: 1 when a > b, -1 when a < b, 0 when equal/unparseable. */
export const compareVersions = (a: string, b: string): number => {
  const parse = (v: string): RegExpExecArray | null => /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v.trim());
  const pa = parse(String(a));
  const pb = parse(String(b));
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]) ? 1 : -1;
  }
  if (Boolean(pa[4]) !== Boolean(pb[4])) return pa[4] ? -1 : 1;
  return 0;
};

/** Shape of the update-check cache file. */
interface UpdateCache {
  lastCheckedAt?: number;
  latest?: string | null;
}

/** Read the cached check; null when absent/corrupt. */
const readUpdateCache = (): UpdateCache | null => {
  try {
    const cache = JSON.parse(readFileSync(updateCachePath(), "utf8")) as unknown;
    return typeof cache === "object" && cache !== null ? (cache as UpdateCache) : null;
  } catch {
    return null;
  }
};

/** The one-line update notice from the CACHE (never the network), or null when current/unknown. */
export const readUpdateNotice = (): string | null => {
  if (updateCheckOptedOut()) return null;
  const cache = readUpdateCache();
  if (typeof cache?.latest !== "string") return null;
  if (compareVersions(cache.latest, VERSION) <= 0) return null;
  return `${paint("▲", PALETTE.acid)} Update available ${VERSION} → ${bold(cache.latest)} — run ${paint("npm i -g @glassray/cli", PALETTE.brand)}`;
};

/** The detached-child refresh script (runs as `node -e <script> <cachePath>`). */
const REFRESH_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const cachePath = process.argv[1];
(async () => {
  let latest = null;
  try {
    const res = await fetch('${REGISTRY_URL}', { signal: AbortSignal.timeout(3000) });
    if (res.ok) { const body = await res.json(); if (typeof body.version === 'string') latest = body.version; }
  } catch {}
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latest: latest ?? prev?.latest ?? null }));
  } catch {}
})();
`;

/** True when the cache is stale enough that a background refresh is due. */
const updateRefreshDue = (cache: UpdateCache | null, now = Date.now()): boolean => {
  if (typeof cache?.lastCheckedAt !== "number") return true;
  const age = now - cache.lastCheckedAt;
  return !(age >= 0 && age < UPDATE_TTL_MS);
};

/** Kick a detached background update refresh when enabled and due. */
export const maybeScheduleUpdateRefresh = (): void => {
  if (!updateCheckEnabled()) return;
  if (!updateRefreshDue(readUpdateCache())) return;
  try {
    const child = spawn(process.execPath, ["-e", REFRESH_SCRIPT, updateCachePath()], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best effort only — an update check must never break a command.
  }
};

/** Live registry probe for `glassray doctor`; null on any failure. */
export const fetchLatestVersion = async (timeoutMs = 3000): Promise<string | null> => {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  }
};
