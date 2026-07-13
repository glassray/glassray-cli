/**
 * A generic "poll until a condition holds, with a timeout" helper used by the
 * `--wait` flows (connect github/slack, verify). Every wait in the CLI has a
 * bounded budget and a named diagnosis on timeout (docs/onboarding-wizard.md §10).
 */

/** Options for `pollUntil`. */
export interface PollOptions<T> {
  /** Total budget in seconds before giving up. */
  timeoutSec: number;
  /** Delay between polls in seconds (default 3). */
  intervalSec?: number;
  /** Called with each fresh value (for progress). */
  onTick?: (value: T, elapsedSec: number) => void;
}

/** The outcome of a poll: the last value plus whether the predicate was met. */
export interface PollResult<T> {
  value: T;
  satisfied: boolean;
  elapsedSec: number;
}

/** Sleep for `seconds`. */
const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Repeatedly call `fetchValue` until `predicate` returns true or the budget is
 * spent. Always polls at least once. Returns the final value and whether it was
 * satisfied (the caller decides how a timeout is surfaced).
 */
export const pollUntil = async <T>(
  fetchValue: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: PollOptions<T>,
): Promise<PollResult<T>> => {
  const intervalSec = options.intervalSec ?? 3;
  const start = Date.now();
  const deadline = start + options.timeoutSec * 1000;
  for (;;) {
    const value = await fetchValue();
    const elapsedSec = Math.round((Date.now() - start) / 1000);
    options.onTick?.(value, elapsedSec);
    if (predicate(value)) return { value, satisfied: true, elapsedSec };
    if (Date.now() + intervalSec * 1000 > deadline) {
      return { value, satisfied: false, elapsedSec };
    }
    await sleep(intervalSec);
  }
};
