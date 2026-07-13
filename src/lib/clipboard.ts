/**
 * Best-effort OS clipboard copy — zero-dependency, via the platform's native
 * tool (`pbcopy` on macOS, `clip` on Windows, `wl-copy` / `xclip` / `xsel` on
 * Linux). Returns whether the copy succeeded; never throws, so callers can
 * always fall back to "here's the text, copy it yourself".
 */
import { spawnSync } from "node:child_process";

/** Platform-ordered clipboard writers: [command, args]. First that succeeds wins. */
const writers = (): [string, string[]][] => {
  if (process.platform === "darwin") return [["pbcopy", []]];
  if (process.platform === "win32") return [["clip", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
};

/** Copy `text` to the clipboard; `true` on success, `false` when no tool is available. */
export const copyToClipboard = (text: string): boolean => {
  for (const [cmd, args] of writers()) {
    try {
      const r = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
      if (r.status === 0) return true;
    } catch {
      // Tool missing / not permitted — try the next one.
    }
  }
  return false;
};
