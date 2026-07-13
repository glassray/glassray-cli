/**
 * Endpoint resolution + the on-disk credential store.
 *
 * Credentials live at `~/.config/glassray/credentials.json` (0600, dir 0700),
 * keyed by endpoint so one machine can pair with several Glassray deployments.
 * For CI / headless use, an explicit `--api-key` flag or the `GLASSRAY_TOKEN`
 * env var overrides the stored key. `GLASSRAY_TOKEN` is deliberately DISTINCT
 * from the SDK's `GLASSRAY_API_KEY` (the per-source ingest key written into a
 * repo's `.env.local`) so a shell that exports the ingest key can't be mistaken
 * for the org key here. See docs/onboarding-wizard.md §3.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Default Glassray deployment when neither `--endpoint` nor `GLASSRAY_APP_URL` is set. */
export const DEFAULT_ENDPOINT = "https://app.glassray.ai";

/** Guards the one-time `GLASSRAY_ENDPOINT` deprecation nudge so it fires at most once per process. */
let legacyEndpointWarned = false;

/**
 * Resolve the CLI's Glassray base URL. Precedence: `--endpoint` flag >
 * `GLASSRAY_APP_URL` env > `GLASSRAY_ENDPOINT` env (DEPRECATED) > default;
 * trailing slash trimmed. `GLASSRAY_ENDPOINT` is being reserved for the SDK's
 * trace-ingest endpoint — it stays a fallback so existing 0.1.1 users keep
 * working, with a one-time stderr nudge to switch to `GLASSRAY_APP_URL`.
 */
export const resolveEndpoint = (flag?: string): string => {
  const fromAppUrl = process.env.GLASSRAY_APP_URL;
  const fromLegacy = process.env.GLASSRAY_ENDPOINT;
  let raw: string;
  if (flag !== undefined && flag !== "") {
    raw = flag;
  } else if (fromAppUrl !== undefined && fromAppUrl !== "") {
    raw = fromAppUrl;
  } else if (fromLegacy !== undefined && fromLegacy !== "") {
    if (!legacyEndpointWarned) {
      legacyEndpointWarned = true;
      process.stderr.write(
        "  warning: GLASSRAY_ENDPOINT is deprecated for the CLI — set GLASSRAY_APP_URL instead " +
          "(GLASSRAY_ENDPOINT is being reserved for the SDK's trace-ingest endpoint).\n",
      );
    }
    raw = fromLegacy;
  } else {
    raw = DEFAULT_ENDPOINT;
  }
  return raw.replace(/\/+$/, "");
};

/** The CLI's config directory (honors `XDG_CONFIG_HOME`). */
export const configDir = (): string =>
  process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "glassray")
    : path.join(os.homedir(), ".config", "glassray");

/** Path to the credential store file. */
const credentialsPath = (): string => path.join(configDir(), "credentials.json");

/** One stored org credential set, keyed by endpoint. */
export interface StoredCredential {
  organizationId: string;
  orgName: string;
  apiKey: string;
  userEmail: string | null;
  updatedAt: string;
}

/** The whole credential file shape. */
interface CredentialStore {
  /** Endpoint base URL → the org key paired for it. */
  endpoints: Record<string, StoredCredential>;
}

/** Read the credential store; an empty store when absent/corrupt. */
const readStore = (): CredentialStore => {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && "endpoints" in parsed) {
      return parsed as CredentialStore;
    }
    return { endpoints: {} };
  } catch {
    return { endpoints: {} };
  }
};

/** Write the credential store with locked-down permissions (dir 0700, file 0600). */
const writeStore = (store: CredentialStore): void => {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsPath();
  // Write-then-rename so a crash/full-disk mid-write can't truncate the live file:
  // `readStore` maps a corrupt file to an empty store, and the next write would then
  // clobber every other endpoint's key. rename is atomic within the same directory.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  // mkdir's `mode` is ignored when the dir already exists; enforce it explicitly.
  try {
    chmodSync(dir, 0o700);
    chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes (Windows).
  }
};

/** The stored credential for an endpoint, or null when unpaired. */
export const getStoredCredential = (endpoint: string): StoredCredential | null =>
  readStore().endpoints[endpoint] ?? null;

/** Persist (or replace) the credential paired for an endpoint. */
export const setStoredCredential = (
  endpoint: string,
  cred: Omit<StoredCredential, "updatedAt">,
): void => {
  const store = readStore();
  store.endpoints[endpoint] = { ...cred, updatedAt: new Date().toISOString() };
  writeStore(store);
};

/** Clear the credential paired for an endpoint. Returns whether anything was removed. */
export const clearStoredCredential = (endpoint: string): boolean => {
  const store = readStore();
  if (!(endpoint in store.endpoints)) return false;
  delete store.endpoints[endpoint];
  writeStore(store);
  return true;
};

/**
 * The org API key to use for an endpoint. Precedence follows the universal CLI
 * convention "explicit beats ambient": a `--api-key` override wins, then the
 * `GLASSRAY_TOKEN` env var, then the stored key. Null when none resolves.
 */
export const resolveApiKey = (endpoint: string, override?: string): string | null => {
  if (override !== undefined && override !== "") return override;
  const fromEnv = process.env.GLASSRAY_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return getStoredCredential(endpoint)?.apiKey ?? null;
};

/** Path to the credential file, for `whoami`/`doctor` to display. */
export const credentialsFilePath = (): string => credentialsPath();
