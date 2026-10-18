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
export type NativeRecovery = "continue" | "resume";

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
): Promise<DeepSeekSseResult> {
  let result = await collectCompletion(
    await transport.complete(request, signal),
    signal,
    onProgress,
  );
  if (result.errorMessage !== undefined) {
    throw new DeepSeekApiError(-1, result.errorMessage, 200);
  }
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
      const next = await collectCompletion(
        await transport.continueCompletion(
          {
            chatSessionId: request.chatSessionId,
            messageId: result.messageId,
            fallbackToResume: true,
          },
          signal,
        ),
        signal,
        progress,
      );
      text = mergeContinuation(text, next.text);
      thinking = mergeContinuation(thinking, next.thinking);
      result = next;
      continue;
    }

    if (!result.finished) {
      onRecovery?.("resume");
      const next = await collectCompletion(
        await transport.resumeStream(
          {
            chatSessionId: request.chatSessionId,
            messageId: result.messageId,
          },
          signal,
        ),
        signal,
        progress,
      );
      text = mergeContinuation(text, next.text);
      thinking = mergeContinuation(thinking, next.thinking);
      result = next;
    }
  }

  return { ...result, text, thinking };
}
