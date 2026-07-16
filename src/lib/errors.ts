/**
 * The CLI's typed failure channel. A thrown `CliError` carries a process exit
 * code; `bin.ts` catches it, prints the message to stderr, and exits with that
 * code. Anything else bubbles up as an unexpected error (stack shown under
 * `--debug`).
 */

/** Conventional exit codes across the CLI. */
export const EXIT = {
  OK: 0,
  /** A handled failure: bad input, API error, unmet precondition. */
  FAILURE: 1,
  /** A required local dependency was unreachable (e.g. no Coach server). */
  UNREACHABLE: 2,
} as const;

/** A handled CLI failure with an explicit exit code. */
export class CliError extends Error {
  /** Process exit code to surface. */
  readonly exitCode: number;
  /** Machine-readable code from the server's `{ code }` field, for callers that branch on it (e.g. `org-name-required`). */
  readonly code?: string;
  /** An optional remediation shown under the error (e.g. "run `glassray logout`"). */
  readonly hint?: string;
  /** The server's full parsed error body, for callers that need structured fields beyond `code` (e.g. the multi-org 409's `orgs` list). */
  readonly payload?: Record<string, unknown>;
  constructor(
    message: string,
    exitCode: number = EXIT.FAILURE,
    code?: string,
    hint?: string,
    payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.hint = hint;
    this.payload = payload;
  }
}

/** Throw a handled failure (exit 1 by default). */
export const fail = (message: string, exitCode: number = EXIT.FAILURE): never => {
  throw new CliError(message, exitCode);
};
