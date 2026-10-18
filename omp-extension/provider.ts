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
import type { ConversationPlanner } from "./conversation";
import { EphemeralPlanner } from "./conversation";

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
  /** Persistent or ephemeral conversation strategy. */
  planner?: ConversationPlanner;
  /** Stable OMP session/subagent key for persistent mappings. */
  scopeKey?: string;
  /** Renders only messages after the previous turn, for session reuse. */
  buildIncrementalPrompt?(
    context: PromptContext,
    startIndex: number,
  ): string | null;
}

const EPHEMERAL_PLANNER = new EphemeralPlanner();

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

  let fullPrompt: string;
  try {
    fullPrompt = deps.buildPrompt(context);
  } catch (error) {
    stream.fail(tokenError(error));
    return;
  }

  const planner = deps.planner ?? EPHEMERAL_PLANNER;
  const scopeKey = deps.scopeKey ?? "";
  let plan;
  try {
    plan = planner.plan(
      scopeKey,
      context,
      fullPrompt,
      (startIndex) => deps.buildIncrementalPrompt?.(context, startIndex) ?? null,
    );
  } catch (error) {
    stream.fail(tokenError(error));
    return;
  }
  const prompt = plan.prompt;
  const invalidate = (): void => {
    if (!plan.persistent) {
      return;
    }
    try {
      planner.invalidate(scopeKey);
    } catch {
      // A store failure is not worth masking the turn result.
    }
  };

  const emitter = new StreamingCompletion(stream, model);
  emitter.start();
  deps.onStatus?.("DeepSeek Web: thinking…");

  let client: DeepSeekClientLike | null = null;
  let sessionId: string | null = plan.chatSessionId ?? null;
  let keepSession = false;
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

    if (sessionId === null) {
      sessionId = await client.createSession();
      if (plan.replacedChatSessionId !== undefined) {
        try {
          await client.deleteSession(plan.replacedChatSessionId);
        } catch {
          // Replaced native sessions are best-effort cleanup too.
        }
      }
    }

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
        parentMessageId: plan.parentMessageId,
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
      invalidate();
      emitter.fail(signal.reason ?? new Error("DeepSeek request aborted"));
      return;
    }

    const toolCalls =
      (context.tools?.length ?? 0) > 0 ? parseToolCalls(result.text) : [];
    const finalText =
      toolCalls.length > 0 ? stripToolMarkup(result.text) : result.text;
    const incomplete =
      needsNativeContinuation(result) || !result.finished;
    if (
      plan.persistent &&
      !incomplete &&
      result.messageId !== undefined &&
      !signal.aborted
    ) {
      try {
        const evicted = planner.commit(
          scopeKey,
          context,
          sessionId,
          result.messageId,
        );
        for (const record of evicted) {
          if (record.chatSessionId !== sessionId) {
            try {
              await client.deleteSession(record.chatSessionId);
            } catch {
              // Eviction cleanup is best-effort.
            }
          }
        }
        keepSession = true;
      } catch {
        // A failed metadata write must not leave an unreachable chat behind.
        invalidate();
        keepSession = false;
      }
    } else if (plan.persistent) {
      invalidate();
    }
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
    invalidate();
    keepSession = false;
    const failure = signal.aborted ? (signal.reason ?? error) : tokenError(error);
    emitter.fail(failure);
    deps.onStatus?.("DeepSeek Web: error");
  } finally {
    if (!keepSession && client !== null && sessionId !== null) {
      try {
        await client.deleteSession(sessionId);
      } catch {
        // Session cleanup is best-effort; the turn result is already settled.
      }
    }
  }
}
