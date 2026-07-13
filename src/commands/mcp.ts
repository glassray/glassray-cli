/**
 * `glassray mcp add|remove [client]` — register (or remove) the Glassray remote
 * MCP server in `.mcp.json`, so the customer's Claude keeps the cloud tool
 * surface after setup. The bearer header references `${GLASSRAY_TOKEN}` (env
 * expansion) — never the raw key — so `.mcp.json` stays safe to commit.
 */
import { resolveApiKey } from "../lib/config.js";
import { parseCommand, type Context } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { getConfig } from "../lib/http.js";
import { addMcpServer, detectClients, MCP_TOKEN_ENV_VAR, removeMcpServer } from "../lib/mcp-config.js";
import { bullet, card, detail, dim, paint, PALETTE, printData, success } from "../lib/ui.js";

/** Human summary of which AI clients were detected in the repo. */
const detectedClientsNote = (cwd: string): string => {
  const clients = detectClients(cwd);
  const names: string[] = [];
  if (clients.claudeCode) names.push("Claude Code");
  if (clients.cursor) names.push("Cursor");
  return names.length > 0 ? names.join(", ") : "none detected";
};

/** The shell line that exports the token the `.mcp.json` entry references. */
export const tokenExportHint = (): string =>
  `export ${MCP_TOKEN_ENV_VAR}="$(glassray token)"`;

/** `mcp add` — write the Glassray server into `.mcp.json` (env-referenced token, no secret in the file). */
const mcpAdd = async (ctx: Context, args: string[]): Promise<void> => {
  const { positionals } = parseCommand(args);
  const key = resolveApiKey(ctx.endpoint, ctx.apiKeyOverride);
  if (!key) throw new CliError(`not logged in to ${ctx.endpoint} — run \`glassray login\``);
  const config = await getConfig(ctx.endpoint);
  const result = addMcpServer(process.cwd(), config.mcpUrl);

  if (ctx.json) {
    printData({
      file: result.file,
      changed: result.changed,
      mcpUrl: config.mcpUrl,
      tokenEnvVar: MCP_TOKEN_ENV_VAR,
      exportHint: tokenExportHint(),
      client: positionals[0] ?? null,
    });
    return;
  }
  card([
    `  ${bullet("ok")} MCP server ${result.changed ? "registered" : "already registered"}`,
    `    ${dim("File")}      ${result.file} ${dim("(no secret inside — safe to commit)")}`,
    `    ${dim("URL")}       ${config.mcpUrl}`,
    `    ${dim("Auth")}      Bearer \${${MCP_TOKEN_ENV_VAR}} ${dim("— expanded from your shell env")}`,
    `    ${dim("Clients")}   ${detectedClientsNote(process.cwd())}`,
    ``,
    `  Export the token before launching your AI client:`,
    `    ${paint(tokenExportHint(), PALETTE.brandBright)}`,
  ]);
  detail("restart your AI client (or reload MCP) to pick up the server");
};

/** `mcp remove` — delete the Glassray server from `.mcp.json`. */
const mcpRemove = async (ctx: Context, args: string[]): Promise<void> => {
  parseCommand(args);
  const result = removeMcpServer(process.cwd());
  if (ctx.json) {
    printData({ file: result.file, changed: result.changed });
    return;
  }
  if (result.changed) success(`removed the Glassray MCP server from ${result.file}`);
  else success("no Glassray MCP server was registered");
};

/** The `mcp` command dispatcher. */
export const cmdMcp = async (ctx: Context, args: string[]): Promise<void> => {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "add":
      return mcpAdd(ctx, rest);
    case "remove":
      return mcpRemove(ctx, rest);
    default:
      throw new CliError(
        verb === undefined ? "usage: glassray mcp add|remove [client]" : `unknown mcp verb "${verb}"`,
      );
  }
};
