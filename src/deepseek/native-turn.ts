import { DeepSeekApiError } from "./client";
import { collectCompletion } from "./collect";
import type { DeepSeekSseResult } from "./sse";
import type {
  DeepSeekCompletionRequest,
  DeepSeekContinueRequest,
  DeepSeekResumeRequest,
} from "./types";
import { RequestGate } from "./rate-limit";
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
  /** Latest response header delay, when the provider advertises one. */
  retryAfterMs?(): number | undefined;
}

export type NativeCompletionProgress = (result: DeepSeekSseResult) => void;
export type NativeRecovery = "continue" | "resume" | "rate-limit";

export interface RateLimitRecovery {
  /** 1-based retry number. */
  retry: number;
  maxRetries: number;
  /** Wait before the next request; zero when giving up. */
  delayMs: number;
  final: boolean;
}

export interface NativeCompletionOptions {
  /** Additional requests after a rate-limit hint. */
  rateLimitRetries?: number;
  /** Initial backoff delay; doubles per retry up to the cap. */
  rateLimitDelayMs?: number;
  /** Upper bound for exponential backoff. */
  rateLimitMaxDelayMs?: number;
  /** Shared pacing gate for this process/account. */
  gate?: RequestGate;
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
  onRecovery?: (recovery: NativeRecovery, info?: RateLimitRecovery) => void,
  options: NativeCompletionOptions = {},
): Promise<DeepSeekSseResult> {
  const maxRateLimitRetries = Math.min(
    100,
    Math.max(0, Math.trunc(options.rateLimitRetries ?? 100)),
  );
  const rateLimitDelayMs = Math.max(
    0,
    Math.trunc(options.rateLimitDelayMs ?? 5_000),
  );
  const rateLimitMaxDelayMs = Math.max(
    0,
    Math.trunc(options.rateLimitMaxDelayMs ?? 60_000),
  );
  const gate = options.gate ?? new RequestGate();
  const collect = async (
    makeStream: () => Promise<ReadableStream<Uint8Array>>,
    progress?: NativeCompletionProgress,
  ): Promise<DeepSeekSseResult> => {
    for (let attempt = 0; ; attempt += 1) {
      await gate.wait(signal);
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
      const advertisedDelay = transport.retryAfterMs?.();
      const backoff = rateLimitDelayMs * 2 ** Math.min(attempt, 20);
      const delayMs =
        advertisedDelay !== undefined && advertisedDelay >= 0
          ? advertisedDelay
          : Math.min(backoff, rateLimitMaxDelayMs);
      gate.cooldown(delayMs);
      if (hasVisibleContent(next) || attempt >= maxRateLimitRetries) {
        onRecovery?.("rate-limit", {
          retry: Math.min(attempt + 1, maxRateLimitRetries),
          maxRetries: maxRateLimitRetries,
          delayMs: 0,
          final: true,
        });
        const attempts = attempt + 1;
        throw new DeepSeekApiError(
          -1,
          `${message} (after ${attempts} attempt${attempts === 1 ? "" : "s"})`,
          429,
        );
      }
      onRecovery?.("rate-limit", {
        retry: attempt + 1,
        maxRetries: maxRateLimitRetries,
        delayMs,
        final: false,
      });
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
