import { DeepSeekApiError } from "./client";
import { DeepSeekSseParser } from "./sse";
import type { DeepSeekSseResult } from "./sse";

export type CompletionProgress = (result: DeepSeekSseResult) => void;

/**
 * Reads the upstream stream and returns the accumulated answer. A stream that
 * breaks after producing text yields the partial answer; a stream that breaks
 * before any text is an upstream error.
 */
export async function collectCompletion(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onProgress?: CompletionProgress,
): Promise<DeepSeekSseResult> {
  const parser = new DeepSeekSseParser();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parser.feed(decoder.decode(value, { stream: true }));
      onProgress?.(parser.result());
    }
    parser.feed(decoder.decode());
    const result = parser.result();
    onProgress?.(result);
    if (!result.finished && result.text === "" && result.thinking === "") {
      throw new DeepSeekApiError(
        -1,
        "DeepSeek closed the completion stream before producing a response",
        502,
      );
    }
    return result;
  } catch (error) {
    const partial = parser.result();
    if (signal.aborted) {
      return partial;
    }
    if (partial.text !== "" || partial.thinking !== "") {
      return partial;
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
