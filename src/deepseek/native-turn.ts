import { DeepSeekApiError } from "./client";
import { collectCompletion } from "./collect";
import type { DeepSeekSseResult } from "./sse";
import type {
  DeepSeekCompletionRequest,
  DeepSeekContinueRequest,
  DeepSeekResumeRequest,
} from "./types";
import { mergeContinuation } from "./stream-merge";

export interface NativeCompletionTransport {
  complete(
    request: DeepSeekCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
  continueCompletion(
    request: DeepSeekContinueRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
  resumeStream(
    request: DeepSeekResumeRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
}

export type NativeCompletionProgress = (result: DeepSeekSseResult) => void;
export type NativeRecovery = "continue" | "resume" | "rate-limit";

export interface NativeCompletionOptions {
  /** Additional requests after a rate-limit hint. */
  rateLimitRetries?: number;
  /** Initial backoff delay; doubles per retry. */
  rateLimitDelayMs?: number;
}

const MAX_NATIVE_RECOVERIES = 2;
const INCOMPLETE_FINISH_REASONS = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "incomplete",
]);

/**
 * Uses the native completion indicators, not text heuristics:
 * - `incomplete_message` / a length finish reason -> `/api/v0/chat/continue`
 * - a stream that never reached FINISHED -> `/api/v0/chat/resume_stream`
 */
export function needsNativeContinuation(result: DeepSeekSseResult): boolean {
  if (result.incompleteMessage !== undefined) {
    return true;
  }
  return (
    result.finishReason !== undefined &&
    INCOMPLETE_FINISH_REASONS.has(result.finishReason.toLowerCase())
  );
}

function hasUnresolvedOutput(result: DeepSeekSseResult): boolean {
  return needsNativeContinuation(result) || !result.finished;
}

export function isRateLimitResult(result: DeepSeekSseResult): boolean {
  const reason = result.finishReason?.toLowerCase();
  if (
    reason === "rate_limit_reached" ||
    reason === "rate_limited" ||
    reason === "too_many_requests"
  ) {
    return true;
  }
  return /too frequent|rate limit|try again later/i.test(
    result.errorMessage ?? "",
  );
}

function hasVisibleContent(result: DeepSeekSseResult): boolean {
  return result.text.length > 0 || result.thinking.length > 0;
}

async function waitForRetry(
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

/**
 * Runs a completion and follows only native recovery paths. There is no
 * model-free text fallback: if the server does not provide a recoverable
 * message, the partial result is surfaced with `finished: false`.
 */
export async function runNativeCompletion(
  transport: NativeCompletionTransport,
  request: DeepSeekCompletionRequest,
  signal: AbortSignal,
  onProgress?: NativeCompletionProgress,
  onRecovery?: (recovery: NativeRecovery) => void,
  options: NativeCompletionOptions = {},
): Promise<DeepSeekSseResult> {
  const maxRateLimitRetries = Math.max(
    0,
    Math.trunc(options.rateLimitRetries ?? 2),
  );
  const rateLimitDelayMs = Math.max(
    0,
    Math.trunc(options.rateLimitDelayMs ?? 5_000),
  );
  const collect = async (
    makeStream: () => Promise<ReadableStream<Uint8Array>>,
    progress?: NativeCompletionProgress,
  ): Promise<DeepSeekSseResult> => {
    for (let attempt = 0; ; attempt += 1) {
      const next = await collectCompletion(
        await makeStream(),
        signal,
        progress,
      );
      if (!isRateLimitResult(next)) {
        if (next.errorMessage !== undefined) {
          throw new DeepSeekApiError(-1, next.errorMessage, 200);
        }
        return next;
      }
      const message = next.errorMessage ?? "DeepSeek rate limit reached";
      if (hasVisibleContent(next) || attempt >= maxRateLimitRetries) {
        throw new DeepSeekApiError(-1, message, 429);
      }
      onRecovery?.("rate-limit");
      await waitForRetry(rateLimitDelayMs * 2 ** attempt, signal);
    }
  };

  let result = await collect(
    () => transport.complete(request, signal),
    onProgress,
  );
  let text = result.text;
  let thinking = result.thinking;

  for (let attempt = 0; attempt < MAX_NATIVE_RECOVERIES; attempt += 1) {
    if (signal.aborted || !hasUnresolvedOutput(result)) {
      break;
    }
    if (result.messageId === undefined) {
      throw new DeepSeekApiError(
        -1,
        "DeepSeek reported an incomplete answer without a message id",
        502,
      );
    }

    const progress = (snapshot: DeepSeekSseResult): void => {
      onProgress?.({
        ...snapshot,
        text: mergeContinuation(text, snapshot.text),
        thinking: mergeContinuation(thinking, snapshot.thinking),
      });
    };

    if (needsNativeContinuation(result)) {
      onRecovery?.("continue");
      const next = await collect(
        () =>
          transport.continueCompletion(
            {
              chatSessionId: request.chatSessionId,
              messageId: result.messageId,
              fallbackToResume: true,
            },
            signal,
          ),
        progress,
      );
      text = mergeContinuation(text, next.text);
      thinking = mergeContinuation(thinking, next.thinking);
      result = next;
      continue;
    }

    if (!result.finished) {
      onRecovery?.("resume");
      const next = await collect(
        () =>
          transport.resumeStream(
            {
              chatSessionId: request.chatSessionId,
              messageId: result.messageId,
            },
            signal,
          ),
        progress,
      );
      text = mergeContinuation(text, next.text);
      thinking = mergeContinuation(thinking, next.thinking);
      result = next;
    }
  }

  return { ...result, text, thinking };
}
