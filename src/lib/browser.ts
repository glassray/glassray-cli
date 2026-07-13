/**
 * Best-effort browser launcher for the CLI's two hand-off points (device pairing
 * and GitHub/Slack consent). Failures are swallowed — the caller ALWAYS also
 * prints the URL as text, so SSH / headless sessions never get stuck.
 */
import { spawn } from "node:child_process";

/** Open `url` in the platform browser. Never throws; returns whether a launcher was spawned. */
export const openBrowser = (url: string): boolean => {
  // Defense-in-depth: only ever hand a well-formed http(s) URL to a launcher, so a
  // hostile server-supplied value can't smuggle shell/handler arguments. The Windows
  // path uses rundll32 (not `cmd /c start`, which re-parses `&` and friends).
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;

  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
};
