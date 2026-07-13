/**
 * `.mcp.json` management — registers (or removes) the Glassray remote MCP server
 * so the customer's AI clients keep the 28-tool cloud surface after setup. Merges
 * into an existing file without disturbing other servers. Also reports which AI
 * clients are present in the repo (`.claude/`, `.cursor/`).
 *
 * SECURITY: the raw org key is NEVER written into `.mcp.json` —
 * repos commonly commit that file, which would persist a writable bearer token in
 * source control. The Authorization header is written as `Bearer ${GLASSRAY_TOKEN}`
 * (Claude Code expands `${VAR}` from the environment at load time); the actual key
 * stays in `~/.config/glassray/credentials.json` and is exported via
 * `export GLASSRAY_TOKEN="$(glassray token)"`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "./errors.js";

/** The `.mcp.json` server entry for a remote (HTTP) MCP server. */
interface McpServerEntry {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Minimal `.mcp.json` shape (only the part we own). */
interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/** The server key the CLI registers under. */
const SERVER_KEY = "glassray";

/** AI clients the CLI can detect by their config directory. */
export interface DetectedClients {
  claudeCode: boolean;
  cursor: boolean;
}

/** Detect installed AI clients in a repo by their marker directories. */
export const detectClients = (cwd: string): DetectedClients => ({
  claudeCode: existsSync(path.join(cwd, ".claude")),
  cursor: existsSync(path.join(cwd, ".cursor")),
});

/**
 * Read `<cwd>/.mcp.json`; an empty config when absent. A file that exists but
 * fails to parse is a hard error — returning `{}` here would let a later write
 * silently overwrite the file and destroy the user's other MCP servers.
 */
const readMcp = (cwd: string): McpConfigFile => {
  const file = path.join(cwd, ".mcp.json");
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  try {
    return JSON.parse(text) as McpConfigFile;
  } catch {
    throw new CliError(
      `${file} is not valid JSON — fix or remove it before running this command (refusing to overwrite it and lose any other MCP servers)`,
    );
  }
};

/** Write `<cwd>/.mcp.json` (pretty, trailing newline). */
const writeMcp = (cwd: string, config: McpConfigFile): void => {
  writeFileSync(path.join(cwd, ".mcp.json"), `${JSON.stringify(config, null, 2)}\n`);
};

/** Result of an add/remove operation. */
export interface McpMutationResult {
  file: string;
  changed: boolean;
}

/** The env var the `.mcp.json` bearer header references (expanded by the AI client at load time). */
export const MCP_TOKEN_ENV_VAR = "GLASSRAY_TOKEN";

/**
 * Register the Glassray MCP server in `.mcp.json` (idempotent). The bearer
 * header references `${GLASSRAY_TOKEN}` via env expansion — never the raw key —
 * so the file stays safe to commit (see the file-header security note).
 */
export const addMcpServer = (cwd: string, mcpUrl: string): McpMutationResult => {
  const config = readMcp(cwd);
  const entry: McpServerEntry = {
    type: "http",
    url: mcpUrl,
    headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV_VAR}}` },
  };
  const existing = config.mcpServers?.[SERVER_KEY];
  const changed = JSON.stringify(existing) !== JSON.stringify(entry);
  config.mcpServers = { ...config.mcpServers, [SERVER_KEY]: entry };
  if (changed) writeMcp(cwd, config);
  return { file: path.join(cwd, ".mcp.json"), changed };
};

/** Remove the Glassray MCP server from `.mcp.json`. Returns whether anything changed. */
export const removeMcpServer = (cwd: string): McpMutationResult => {
  const config = readMcp(cwd);
  const changed = Boolean(config.mcpServers && SERVER_KEY in config.mcpServers);
  if (changed && config.mcpServers) {
    delete config.mcpServers[SERVER_KEY];
    writeMcp(cwd, config);
  }
  return { file: path.join(cwd, ".mcp.json"), changed };
};

/** Whether the Glassray MCP server is already registered in `.mcp.json`. */
export const hasMcpServer = (cwd: string): boolean =>
  Boolean(readMcp(cwd).mcpServers && SERVER_KEY in (readMcp(cwd).mcpServers ?? {}));
