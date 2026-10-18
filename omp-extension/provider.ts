import { TokenError } from "../src/deepseek/client";
import type {
  DeepSeekCompletionRequest,
  DeepSeekContinueRequest,
  DeepSeekResumeRequest,
} from "../src/deepseek/types";
import type { DeepSeekSseResult } from "../src/deepseek/sse";
import {
  needsNativeContinuation,
  runNativeCompletion,
} from "../src/deepseek/native-turn";
import { resolveNonNegativeInt } from "../src/deepseek/options";
import type { RequestGate } from "../src/deepseek/rate-limit";
import { stripToolMarkup } from "../src/openai/translate";
import { parseToolCalls } from "../src/tools/parser";
import type { EventSink, ModelIdentity } from "./events";
import { StreamingCompletion } from "./events";
import { collectTurnImages } from "./prompt";
import type { PromptContext, PromptImage } from "./prompt";

export interface DeepSeekClientLike {
  createSession(): Promise<string>;
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
  retryAfterMs?(): number | undefined;
  deleteSession(sessionId: string): Promise<void>;
  uploadFile?(file: {
    data: Uint8Array;
    name: string;
    mimeType: string;
  }): Promise<string>;
  waitForFileReady?(id: string, signal?: AbortSignal): Promise<void>;
}

export interface ProviderDeps {
  readToken(): string | null;
  readDeviceId(): string | null;
  createClient(token: string, deviceId: string): DeepSeekClientLike;
  buildPrompt(context: PromptContext): string;
  onStatus?(status: string | null): void;
  requestGate?: RequestGate;
}

function tokenError(error: unknown): Error {
  if (error instanceof TokenError) {
    return new Error(
      "DeepSeek token is invalid or expired. Open chat.deepseek.com with the DeepSeek Token Bridge extension installed.",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function imageName(image: PromptImage, index: number): string {
  const extension = IMAGE_EXTENSIONS[image.mimeType] ?? "bin";
  return `image-${index + 1}.${extension}`;
}

function searchStatusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("search")) {
    return "DeepSeek Web: searching…";
  }
  if (
    normalized.includes("finish") ||
    normalized.includes("done") ||
    normalized.includes("complete") ||
    normalized.includes("composing")
  ) {
    return "DeepSeek Web: composing…";
  }
  return `DeepSeek Web: ${normalized}`;
}

export interface ProviderTurnOptions {
  signal?: AbortSignal;
  /** DeepThink; enabled by default. */
  thinkingEnabled?: boolean;
  /** Web search; enabled by default. */
  searchEnabled?: boolean;
  /** Override rate-limit retries; defaults to DEEPSEEK_WEB_RATE_LIMIT_RETRIES. */
  rateLimitRetries?: number;
  /** Override initial rate-limit backoff; defaults to DEEPSEEK_WEB_RATE_LIMIT_DELAY_MS. */
  rateLimitDelayMs?: number;
}

/**
 * Runs one DeepSeek web turn and emits canonical omp events. Thinking and
 * search default on; set the corresponding option to false to disable them.
 */
export async function runDeepSeekTurn(
  deps: ProviderDeps,
  model: ModelIdentity,
  context: PromptContext,
  options: ProviderTurnOptions,
  stream: EventSink,
): Promise<void> {
  const token = deps.readToken();
  if (token === null) {
    stream.fail(
      new Error(
        "No DeepSeek token is stored. Open chat.deepseek.com with the DeepSeek Token Bridge extension installed and sign in.",
      ),
    );
    return;
  }

  const deviceId = deps.readDeviceId();
  if (deviceId === null) {
    stream.fail(
      new Error(
        "No DeepSeek device id is stored. Open chat.deepseek.com with the DeepSeek Token Bridge extension installed.",
      ),
    );
    return;
  }

  let prompt: string;
  try {
    prompt = deps.buildPrompt(context);
  } catch (error) {
    stream.fail(tokenError(error));
    return;
  }

  const emitter = new StreamingCompletion(stream, model);
  emitter.start();
  deps.onStatus?.("DeepSeek Web: thinking…");

  let client: DeepSeekClientLike | null = null;
  let sessionId: string | null = null;
  const signal = options.signal ?? new AbortController().signal;

  try {
    client = deps.createClient(token, deviceId);
    const images = collectTurnImages(context);
    const refFileIds: string[] = [];
    if (images.length > 0) {
      if (client.uploadFile === undefined || client.waitForFileReady === undefined) {
        throw new Error("This client does not support image input.");
      }
      deps.onStatus?.("DeepSeek Web: uploading image…");
      for (const [index, image] of images.entries()) {
        const id = await client.uploadFile({
          data: Buffer.from(image.data, "base64"),
          name: imageName(image, index),
          mimeType: image.mimeType,
        });
        await client.waitForFileReady(id, signal);
        refFileIds.push(id);
      }
    }

    sessionId = await client.createSession();

    let lastText = "";
    let lastThinking = "";
    let lastSearchStatus: string | undefined;
    const onProgress = (snapshot: DeepSeekSseResult): void => {
      if (snapshot.thinking !== lastThinking) {
        const delta = snapshot.thinking.startsWith(lastThinking)
          ? snapshot.thinking.slice(lastThinking.length)
          : snapshot.thinking;
        if (delta.length > 0) {
          emitter.thinkingDelta(delta);
        }
        lastThinking = snapshot.thinking;
      }
      if (snapshot.text !== lastText) {
        const delta = snapshot.text.startsWith(lastText)
          ? snapshot.text.slice(lastText.length)
          : snapshot.text;
        if (delta.length > 0) {
          emitter.textDelta(delta);
        }
        lastText = snapshot.text;
      }
      if (
        snapshot.searchStatus !== undefined &&
        snapshot.searchStatus !== lastSearchStatus
      ) {
        lastSearchStatus = snapshot.searchStatus;
        deps.onStatus?.(searchStatusLabel(snapshot.searchStatus));
      }
    };

    const result = await runNativeCompletion(
      client,
      {
        chatSessionId: sessionId,
        prompt,
        refFileIds,
        thinkingEnabled: options.thinkingEnabled ?? true,
        searchEnabled: options.searchEnabled ?? true,
      },
      signal,
      onProgress,
      (recovery) => {
        deps.onStatus?.(
          recovery === "continue"
            ? "DeepSeek Web: continuing…"
            : recovery === "resume"
              ? "DeepSeek Web: resuming…"
              : "DeepSeek Web: rate limited, retrying…",
        );
      },
      {
        rateLimitRetries:
          options.rateLimitRetries ??
          resolveNonNegativeInt(process.env.DEEPSEEK_WEB_RATE_LIMIT_RETRIES, 2),
        rateLimitDelayMs:
          options.rateLimitDelayMs ??
          resolveNonNegativeInt(
            process.env.DEEPSEEK_WEB_RATE_LIMIT_DELAY_MS,
            10_000,
          ),
        gate: deps.requestGate,
      },
    );

    if (signal.aborted) {
      emitter.fail(signal.reason ?? new Error("DeepSeek request aborted"));
      return;
    }

    const toolCalls =
      (context.tools?.length ?? 0) > 0 ? parseToolCalls(result.text) : [];
    const finalText =
      toolCalls.length > 0 ? stripToolMarkup(result.text) : result.text;
    const incomplete =
      needsNativeContinuation(result) || !result.finished;
    emitter.finish({
      text: finalText,
      thinking: result.thinking,
      toolCalls,
      ...(incomplete ? { stopReason: "length" as const } : {}),
    });
    deps.onStatus?.(
      incomplete ? "DeepSeek Web: truncated" : "DeepSeek Web ✓",
    );
  } catch (error) {
    const failure = signal.aborted ? (signal.reason ?? error) : tokenError(error);
    emitter.fail(failure);
    deps.onStatus?.("DeepSeek Web: error");
  } finally {
    if (client !== null && sessionId !== null) {
      try {
        await client.deleteSession(sessionId);
      } catch {
        // Session cleanup is best-effort; the turn result is already settled.
      }
    }
  }
}
