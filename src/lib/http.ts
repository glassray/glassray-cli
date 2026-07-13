/**
 * Typed fetch wrappers for the Glassray public REST API, plus the raw WorkOS
 * device-flow client. Zero-dependency (native `fetch`). Errors surface the
 * server's `{ error }` / `{ message }` field so the caller shows the real reason.
 *
 * The ONLY runtime coupling to Glassray is these HTTP calls — no shared code is
 * imported (the contract types are defined locally in `./types.js`).
 */
import { ApiError, CliError, EXIT } from "./errors.js";
import type {
  ConnectOtlpRequest,
  ConnectOtlpResponse,
  ConnectPullRequest,
  ConnectPullResponse,
  DeviceAuthResponse,
  DeviceTokenResponse,
  SetupConfigResponse,
  SetupExchangeRequest,
  SetupExchangeResponse,
  SetupStatusResponse,
} from "./types.js";

/** Default per-request budget (ms). Device polling passes its own signals. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Pull a human error message out of a parsed error body. */
const errorMessage = (body: unknown, fallback: string): string => {
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    if (typeof rec.error === "string" && rec.error !== "") return rec.error;
    if (typeof rec.message === "string" && rec.message !== "") return rec.message;
  }
  return fallback;
};

/** Pull the machine-readable `code` discriminator out of a parsed error body. */
const errorCode = (body: unknown): string | null => {
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    if (typeof rec.code === "string" && rec.code !== "") return rec.code;
  }
  return null;
};

/** Parse a response body as JSON, tolerating an empty body. Non-JSON bodies (an
 * HTML error page) are NOT surfaced verbatim — a 404 must read as one line, not
 * a page dump. */
const parseBody = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
};

/** A JSON request that throws a `CliError` carrying the server's message on non-2xx. */
const requestJson = async <T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> => {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError(`could not reach ${url} — ${reason}`, EXIT.UNREACHABLE);
  }
  const body = await parseBody(res);
  if (!res.ok) {
    const fallback = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""} from ${new URL(url).pathname}`;
    throw new ApiError(errorMessage(body, fallback), res.status, errorCode(body));
  }
  return body as T;
};

/** Bearer-auth headers plus JSON content-type. */
const authJsonHeaders = (bearer: string): Record<string, string> => ({
  authorization: `Bearer ${bearer}`,
  "content-type": "application/json",
});

// ── Glassray setup API ─────────────────────────────────────────────────────────

/** `GET /api/public/setup/config` — the CLI's discovery call (no auth). */
export const getConfig = (endpoint: string): Promise<SetupConfigResponse> =>
  requestJson<SetupConfigResponse>(`${endpoint}/api/public/setup/config`);

/** `POST /api/public/setup/exchange` — swap an AuthKit access token for an org API key. */
export const exchange = (
  endpoint: string,
  accessToken: string,
  body: SetupExchangeRequest,
): Promise<SetupExchangeResponse> =>
  requestJson<SetupExchangeResponse>(`${endpoint}/api/public/setup/exchange`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(body),
  });

/** `GET /api/public/v1/setup/status` — the aggregate the CLI polls (bearer = org key). */
export const getStatus = (endpoint: string, apiKey: string): Promise<SetupStatusResponse> =>
  requestJson<SetupStatusResponse>(`${endpoint}/api/public/v1/setup/status`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });

/** `POST /api/public/v1/setup/connect/otlp` — create a push (OTLP/SDK) trace source. */
export const connectOtlp = (
  endpoint: string,
  apiKey: string,
  body: ConnectOtlpRequest,
): Promise<ConnectOtlpResponse> =>
  requestJson<ConnectOtlpResponse>(`${endpoint}/api/public/v1/setup/connect/otlp`, {
    method: "POST",
    headers: authJsonHeaders(apiKey),
    body: JSON.stringify(body),
  });

/** `POST /api/public/v1/setup/connect/pull` — connect a pull trace source. */
export const connectPull = (
  endpoint: string,
  apiKey: string,
  body: ConnectPullRequest,
): Promise<ConnectPullResponse> =>
  requestJson<ConnectPullResponse>(`${endpoint}/api/public/v1/setup/connect/pull`, {
    method: "POST",
    headers: authJsonHeaders(apiKey),
    body: JSON.stringify(body),
  });

// ── WorkOS device flow (RFC 8628, raw fetch — the SDK has no device methods) ────

/**
 * `POST {workosApi}/user_management/authorize/device` — start the device grant.
 * RFC 8628 §3.1 uses `application/x-www-form-urlencoded`.
 *
 * NOTE: the exact device-endpoint base host (api.workos.com vs the AuthKit
 * domain) is UNCONFIRMED; the base is env-overridable via `GLASSRAY_WORKOS_API`.
 */
export const authorizeDevice = async (
  workosApi: string,
  clientId: string,
): Promise<DeviceAuthResponse> => {
  const form = new URLSearchParams({ client_id: clientId });
  return requestJson<DeviceAuthResponse>(`${workosApi}/user_management/authorize/device`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
};

/**
 * One poll of `POST {workosApi}/user_management/authenticate` with the
 * device-code grant. Returns the parsed body EVEN on a 4xx (RFC 8628 signals
 * `authorization_pending` / `slow_down` / `expired_token` / `access_denied` as a
 * `{ error }` body with a 400) so the caller can branch; only a network failure
 * throws.
 */
export const pollDeviceToken = async (
  workosApi: string,
  clientId: string,
  deviceCode: string,
): Promise<DeviceTokenResponse> => {
  let res: Response;
  try {
    res = await fetch(`${workosApi}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError(`could not reach WorkOS at ${workosApi} — ${reason}`, EXIT.UNREACHABLE);
  }
  const body = (await parseBody(res)) as DeviceTokenResponse;
  // A 5xx with no structured error is a genuine outage, not a poll signal.
  if (!res.ok && typeof body.error !== "string") {
    throw new CliError(
      errorMessage(body, `${res.status} ${res.statusText} from WorkOS authenticate`),
      EXIT.FAILURE,
    );
  }
  return body;
};
