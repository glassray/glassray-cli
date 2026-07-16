/**
 * The Glassray public REST contract, defined LOCALLY as plain TypeScript so this
 * package stays dependency-free and self-contained — its only couplings are
 * runtime boundaries (HTTPS to the Glassray API, and shelling out to
 * `npx @glassray/coach`). Kept in sync with the API by hand.
 */

/** `GET /api/public/setup/config` — WorkOS coordinates the CLI needs to run the device flow. */
export interface SetupConfigResponse {
  /** AuthKit domain — the OAuth issuer + device-endpoint host. `null` when CLI-auth is disabled. */
  authkitDomain: string | null;
  /** WorkOS client id for the public CLI app (device grant `client_id`). */
  clientId: string | null;
  /** Absolute URL of the customer-facing MCP server, for `glassray mcp add`. */
  mcpUrl: string;
  /** Human-facing base URL of this Glassray deployment (dashboard, connect deep-links). */
  appUrl: string;
}

/** `POST /api/public/setup/exchange` request body. Bearer header = AuthKit access token. */
export interface SetupExchangeRequest {
  /** Org name to provision when the signed-in user has no organization yet. */
  orgName?: string;
  /** Which org to scope to when the user belongs to several (id, slug, or name) — validated against their memberships. */
  organizationId?: string;
}

/** `POST /api/public/setup/exchange` success — the minted org API key, returned exactly once. */
export interface SetupExchangeResponse {
  /** WorkOS `org_<ulid>` the CLI is now scoped to. */
  organizationId: string;
  /** Display name of that organization. */
  orgName: string;
  /** The org API key (carries `mcp:read` + `mcp:write`). `value` is shown ONCE. */
  apiKey: { id: string; value: string };
  /** True when this call provisioned a brand-new organization. */
  created: boolean;
  /** Email of the signed-in user, for the CLI's "signed in as" line. */
  userEmail: string | null;
}

/** `POST /api/public/v1/setup/connect/otlp` request — create a push (OTLP/SDK) trace source. */
export interface ConnectOtlpRequest {
  /** Human label for the source (e.g. the repo or service name). */
  displayName: string;
  /** Project (`proj_<ulid>`) the source's traces should land in. Omitted → the org's default project. */
  projectId?: string;
}

/** Minimal project echo — where a connected source's traces will land. */
export interface SetupProjectRef {
  id: string;
  name: string;
  slug: string;
}

/** `POST /api/public/v1/setup/connect/otlp` success — the new (or already-connected) source and its ingest key. */
export interface ConnectOtlpResponse {
  traceSourceId: string;
  /** Ingest key carrying `traces:write` — shown once at creation; `null` when `existing` (rotate in the dashboard if lost). */
  ingestKey: string | null;
  /** The OTLP traces endpoint the SDK/exporter should target. */
  endpoint: string;
  /** True when an already-connected source matched (idempotent retry) — nothing new was minted. */
  existing: boolean;
  /** The project the source landed in (the EXISTING source's project on an idempotent retry). */
  project: SetupProjectRef;
}

/** Per-integration connection state used across the status payload. */
export type SetupConnectionState = "connected" | "not_connected";

/** One connected trace source in the status payload. */
export interface SetupStatusSource {
  id: string;
  provider: string;
  displayName: string | null;
  status: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Traces ingested for this source (all-time). */
  traceCount: number;
}

/** `GET /api/public/v1/setup/status` — the aggregate the CLI polls to decide what's left. */
export interface SetupStatusResponse {
  organizationId: string;
  sources: SetupStatusSource[];
  /** The org's projects (workspaces) — what the interactive project step offers before connect. */
  projects: Array<SetupProjectRef & { isDefault: boolean }>;
  /**
   * The project the calling key is currently hard-bound to. Lets the picker
   * preselect (or skip) the real binding rather than guessing the org default.
   * Absent on older servers; `null` for keyless callers with no binding.
   */
  boundProjectId?: string | null;
  /** Total traces ingested across the org (the "are traces landing" signal). */
  traceCount: number;
  /** Traces ingested in the last hour — the verify gate's recency signal. */
  recentTraceCount: number;
  github: SetupConnectionState;
  slack: SetupConnectionState;
  /** Whether the browser onboarding wizard is finished — the terminal's "wizard complete" poll signal (v3). */
  onboardingCompleted: boolean;
  /**
   * The trace path the wizard settled on. `otlp` (SDK push) or `none` (skipped)
   * → the terminal wires the SDK (`instrument`) + verifies; `pull` (existing
   * langfuse/langsmith/posthog source) → the terminal just verifies.
   */
  tracePath: "otlp" | "pull" | "none";
}

/**
 * WorkOS device-authorization response (RFC 8628 §3.2). Raw-fetched — the
 * `@workos-inc/node` SDK has no device methods.
 */
export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  /** Minimum poll interval in seconds (defaults to 5 when absent). */
  interval?: number;
}

/**
 * WorkOS device token-poll response. On success the OAuth fields are present; on
 * a pending/slow-down/failure poll the `error` field carries the RFC 8628 code.
 */
export interface DeviceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  organization_id?: string | null;
  user?: { id?: string; email?: string | null } | null;
  /** RFC 8628 poll error: `authorization_pending` | `slow_down` | `expired_token` | `access_denied`. */
  error?: string;
  error_description?: string;
}
