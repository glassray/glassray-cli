/**
 * The local Coach client — a zero-dependency loopback fetcher against
 * `http://127.0.0.1:<port>` (default 5899). Ported from `coach/bin/commands.mjs`
 * (NOT imported — the CLI stays decoupled from the coach package). Output
 * contract is strict: stdout carries EXACTLY the API's JSON, pretty-printed;
 * everything human-readable goes to stderr. Exit codes: 0 ok · 1 API/validation
 * error · 2 cannot reach a Coach server.
 */
import { CliError, EXIT } from "./errors.js";
import { cross, dim, MODE_ERR, printData } from "./ui.js";

/** Poll cadence for a background run while it is still pending. */
const POLL_INTERVAL_MS = 1500;

/** Default wall-clock budget (seconds) for the waiting verbs. */
export const DEFAULT_TIMEOUT_SEC = 180;

/** The ONE stdout writer for loopback data: the API JSON, verbatim. */
export const printJson = (body: unknown): void => printData(body);

/** Fail with a message that Coach is unreachable (exit 2). */
const unreachable = (port: number): never => {
  throw new CliError(
    `cannot reach a Coach server on port ${port} — run \`glassray start\` first`,
    EXIT.UNREACHABLE,
  );
};

/**
 * Call the Coach API over loopback. A network failure exits 2; a non-2xx prints
 * the API's error message and exits 1; otherwise the parsed JSON body is
 * returned.
 */
export const loopbackApi = async (
  port: number,
  pathname: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> => {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  } catch {
    return unreachable(port);
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message =
      typeof body?.error === "string" ? body.error : `${res.status} ${res.statusText} from ${pathname}`;
    throw new CliError(message, EXIT.FAILURE);
  }
  return body ?? {};
};

/** POST-JSON helper. */
export const loopbackPost = (
  port: number,
  pathname: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> =>
  loopbackApi(port, pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** PATCH-JSON helper. */
export const loopbackPatch = (
  port: number,
  pathname: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  loopbackApi(port, pathname, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** DELETE helper. */
export const loopbackDelete = (
  port: number,
  pathname: string,
): Promise<Record<string, unknown>> => loopbackApi(port, pathname, { method: "DELETE" });

/** Resolve the shared wait flags into a concrete budget. */
export interface WaitOptions {
  noWait: boolean;
  timeoutSec: number;
}

/**
 * Poll a background run until it settles, showing live `scanned N/M` progress on
 * stderr. Returns the run row on 'done'; throws (exit 1) on 'error' or timeout.
 */
export const waitForRun = async (
  port: number,
  runId: string,
  timeoutSec: number,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + timeoutSec * 1000;
  const writeProgress = (text: string): void => {
    if (process.stderr.isTTY) process.stderr.write(`\r${text}\x1b[K`);
  };
  for (;;) {
    const run = await loopbackApi(port, `/api/runs/${encodeURIComponent(runId)}`);
    if (run.status === "done") {
      if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
      return run;
    }
    if (run.status === "error") {
      if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
      process.stderr.write(`  ${cross()} run ${runId} failed: ${String(run.error ?? "unknown error")}\n`);
      printJson(run);
      throw new CliError(`run ${runId} failed`, EXIT.FAILURE);
    }
    if (Date.now() >= deadline) {
      if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
      throw new CliError(
        `run ${runId} did not finish within ${timeoutSec}s — it may still complete; check \`glassray runs get ${runId}\``,
        EXIT.FAILURE,
      );
    }
    const stats = (run.stats ?? {}) as { scanned?: number; total?: number };
    const progress =
      typeof stats.scanned === "number" && typeof stats.total === "number"
        ? ` — scanned ${stats.scanned}/${stats.total}`
        : "";
    writeProgress(`  ● ${String(run.kind ?? "run")} ${String(run.status)}${progress} …`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
};

/**
 * POST an enqueue endpoint (202 { runId, status }) and wait for the run.
 * `--no-wait` prints the 202 body instead. `after` replaces the finished run as
 * the stdout payload (e.g. re-fetching the eval detail).
 */
export const enqueueAndWait = async (
  port: number,
  pathname: string,
  body: Record<string, unknown>,
  wait: WaitOptions,
  after?: (run: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<void> => {
  const accepted = await loopbackPost(port, pathname, body);
  if (wait.noWait) {
    printJson(accepted);
    return;
  }
  process.stderr.write(
    dim(`  run ${String(accepted.runId)} ${String(accepted.status)} — polling until done (timeout ${wait.timeoutSec}s)\n`, MODE_ERR),
  );
  const run = await waitForRun(port, String(accepted.runId), wait.timeoutSec);
  printJson(after ? await after(run) : run);
};

/** Stream GET /api/tail (SSE) as ndjson on stdout until killed. */
export const tailTraces = async (port: number): Promise<void> => {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/tail`, { headers: { accept: "text/event-stream" } });
  } catch {
    unreachable(port);
    return;
  }
  if (!res.ok || !res.body) {
    throw new CliError(`${res.status} ${res.statusText} from /api/tail`, EXIT.FAILURE);
  }
  process.stderr.write(`  tailing traces on port ${port} — press Ctrl-C to stop\n`);
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data === "") continue;
        try {
          process.stdout.write(`${JSON.stringify(JSON.parse(data))}\n`);
        } catch {
          // Not JSON — skip rather than corrupt the ndjson stream.
        }
      }
    }
  } catch {
    // Fall through to the stream-closed exit.
  }
  throw new CliError("the tail stream closed — the Coach server stopped", EXIT.UNREACHABLE);
};
