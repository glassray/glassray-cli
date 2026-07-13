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
  constructor(message: string, exitCode: number = EXIT.FAILURE) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/** Throw a handled failure (exit 1 by default). */
export const fail = (message: string, exitCode: number = EXIT.FAILURE): never => {
  throw new CliError(message, exitCode);
};

/**
 * A non-2xx response from the Glassray API. Carries the HTTP status and the
 * server's optional machine-readable `code` (e.g. `org-name-required`) so
 * callers can branch on a failure and recover — never by matching the human
 * message.
 */
export class ApiError extends CliError {
  /** HTTP status of the failed response. */
  readonly status: number;
  /** The server's `{ code }` discriminator, when it sent one. */
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message, EXIT.FAILURE);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
