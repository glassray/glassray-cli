/**
 * `glassray connect <target>` — open the dashboard page where you wire up an
 * integration in the browser. This is a thin launcher: it resolves your Glassray
 * app URL and opens the browser at the right settings page. The actual connecting
 * happens in the web UI, which owns the WorkOS session and every provider's OAuth
 * / credential flow — so there is no headless REST path here, and no login needed
 * to open the page. `glassray setup` orchestrates the full browser flow; agents
 * and CI connect sources programmatically through the `connect_*_source` MCP tools.
 */
import { boolFlag, parseCommand, type Context } from "../lib/context.js";
import { openBrowser } from "../lib/browser.js";
import { CliError } from "../lib/errors.js";
import { getConfig } from "../lib/http.js";
import { bullet, card, dim, link, printData } from "../lib/ui.js";

/**
 * Where each connect target lands in the dashboard, and whether it's a trace
 * source (verify-able) or an integration. Trace-source providers all open the
 * unified sources page — the provider is chosen there, since there's no
 * per-provider deep-link. Slack and GitHub each open their own settings page,
 * which owns that integration's OAuth flow.
 */
const CONNECT_TARGETS = {
  otlp: { page: "/settings/sources", kind: "source" },
  langsmith: { page: "/settings/sources", kind: "source" },
  langfuse: { page: "/settings/sources", kind: "source" },
  posthog: { page: "/settings/sources", kind: "source" },
  slack: { page: "/settings/notifications", kind: "integration" },
  github: { page: "/settings/integrations", kind: "integration" },
} as const satisfies Record<string, { page: string; kind: "source" | "integration" }>;

/** A valid `connect` target. */
type ConnectTarget = keyof typeof CONNECT_TARGETS;

/** The accepted targets, in help/usage order. */
const TARGET_NAMES = Object.keys(CONNECT_TARGETS) as ConnectTarget[];

/** Type guard: is `t` one of the known connect targets? */
const isConnectTarget = (t: string | undefined): t is ConnectTarget =>
  t !== undefined && t in CONNECT_TARGETS;

/** The `connect` command — open the dashboard page for wiring up `<target>` in the browser. */
export const cmdConnect = async (ctx: Context, args: string[]): Promise<void> => {
  const { values, positionals } = parseCommand(args, { "no-open": { type: "boolean" } });
  const target = positionals[0];
  if (!isConnectTarget(target)) {
    throw new CliError(
      target === undefined
        ? `usage: glassray connect <${TARGET_NAMES.join("|")}>`
        : `unknown connect target "${target}" — expected ${TARGET_NAMES.join("|")}`,
    );
  }

  const { page, kind } = CONNECT_TARGETS[target];
  const config = await getConfig(ctx.endpoint);
  const url = `${config.appUrl.replace(/\/+$/, "")}${page}`;
  const open = !boolFlag(values, "no-open");
  const opened = open && openBrowser(url);

  if (ctx.json) {
    // `connect` only opens the dashboard — it does NOT provision a source or mint
    // an ingest key. Say so explicitly so a headless caller can't read exit 0 as
    // "source created" and then wait on `verify` for traces that can't arrive.
    printData({ action: "open-dashboard", target, url, opened, provisioned: false });
    return;
  }

  // A trace source isn't live until traces land, so point the user at the verify
  // gate; an integration (Slack/GitHub) is done once the browser flow completes.
  const next =
    kind === "source"
      ? `Pick ${target} in the dashboard, then ${link("glassray verify --wait")} to confirm traces are arriving.`
      : `Finish connecting ${target} in the dashboard.`;
  card([
    `  ${bullet("ok")} Connect ${target} in your browser`,
    `    ${dim(open ? "Opening" : "Open")}   ${link(url)}`,
    ``,
    `  ${next}`,
  ]);
};
