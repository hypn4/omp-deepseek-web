/** Sleeps for `milliseconds`, rejecting when the signal aborts. */
export async function sleepWithSignal(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  if (signal.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  await promise;
}

export interface RequestGateOptions {
  /** Minimum spacing between requests in this process. */
  minIntervalMs?: number;
}

/**
 * Process-wide pacing for the web account. Rate limits are account-level, so
 * every conversation and tool loop shares the same gate.
 */
export class RequestGate {
  readonly #minIntervalMs: number;
  #nextAt = 0;
  #cooldownUntil = 0;

  constructor(options: RequestGateOptions = {}) {
    this.#minIntervalMs = Math.max(
      0,
      Math.trunc(options.minIntervalMs ?? 0),
    );
  }

  async wait(signal: AbortSignal): Promise<void> {
    while (true) {
      const now = Date.now();
      const until = Math.max(this.#nextAt, this.#cooldownUntil);
      if (until <= now) {
        // Check-and-reserve is synchronous, so concurrent callers cannot both
        // pass the gate on the same tick.
        this.#nextAt = now + this.#minIntervalMs;
        return;
      }
      // Re-check after sleeping: another request may extend the cooldown.
      await sleepWithSignal(until - now, signal);
    }
  }

  /** Applies a cooldown to every request, not just the current turn. */
  cooldown(milliseconds: number): void {
    if (milliseconds > 0) {
      this.#cooldownUntil = Math.max(
        this.#cooldownUntil,
        Date.now() + milliseconds,
      );
    }
  }
}

/**
 * Parses a standard `Retry-After` value: either delta seconds or an HTTP date.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000;
    return Number.isFinite(milliseconds) && milliseconds >= 0
      ? milliseconds
      : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - Date.now());
}

/**
 * Reads common rate-limit reset headers. DeepSeek's web endpoint currently
 * sends none, but supporting them here makes the wait exact if the server
 * starts providing a reset hint.
 */
export function retryAfterFromHeaders(headers: Headers): number | undefined {
  const delta = parseRetryAfter(
    headers.get("retry-after") ?? headers.get("x-ds-retry-after"),
  );
  if (delta !== undefined) {
    return delta;
  }

  for (const name of ["x-ratelimit-reset", "x-rate-limit-reset"]) {
    const value = headers.get(name);
    if (value === null || value.trim() === "") {
      continue;
    }
    const numeric = Number(value);
    const now = Date.now();
    if (Number.isFinite(numeric) && numeric > 0) {
      if (numeric > 1_000_000_000_000) {
        return Math.max(0, numeric - now);
      }
      if (numeric > 1_000_000_000) {
        return Math.max(0, numeric * 1000 - now);
      }
      return numeric * 1000;
    }
    const date = Date.parse(value);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - now);
    }
  }
  return undefined;
}
