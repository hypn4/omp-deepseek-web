import { TokenError } from "../src/deepseek/client";
import type { DeepSeekCompletionRequest } from "../src/deepseek/types";
import { stripToolMarkup } from "../src/openai/translate";
import { parseToolCalls } from "../src/tools/parser";
import { collectCompletion } from "./collect";
import type {
  BufferedCompletion,
  EventSink,
  ModelIdentity,
} from "./events";
import type { PromptContext } from "./prompt";

export interface DeepSeekClientLike {
  createSession(): Promise<string>;
  complete(
    request: DeepSeekCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface ProviderDeps {
  readToken(): string | null;
  readDeviceId(): string | null;
  createClient(token: string, deviceId: string): DeepSeekClientLike;
  buildPrompt(context: PromptContext): string;
  emit(
    stream: EventSink,
    model: ModelIdentity,
    completion: BufferedCompletion,
  ): void;
}

function tokenError(error: unknown): Error {
  if (error instanceof TokenError) {
    return new Error(
      "DeepSeek token is invalid or expired. Open chat.deepseek.com with the DeepSeek Token Bridge extension installed.",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface ProviderTurnOptions {
  signal?: AbortSignal;
  /** DeepThink; enabled by default. */
  thinkingEnabled?: boolean;
  /** Web search; enabled by default. */
  searchEnabled?: boolean;
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

  let client: DeepSeekClientLike | null = null;
  let sessionId: string | null = null;
  const signal = options.signal ?? new AbortController().signal;
  // DeepSeek web only emits tool calls with thinking disabled. Search is
  // independent and stays on by default.
  const hasTools = (context.tools?.length ?? 0) > 0;

  try {
    client = deps.createClient(token, deviceId);
    sessionId = await client.createSession();
    const upstream = await client.complete(
      {
        chatSessionId: sessionId,
        prompt,
        thinkingEnabled: hasTools ? false : (options.thinkingEnabled ?? true),
        searchEnabled: options.searchEnabled ?? true,
      },
      signal,
    );
    const result = await collectCompletion(upstream, signal);
    if (signal.aborted) {
      stream.fail(signal.reason ?? new Error("DeepSeek request aborted"));
      return;
    }

    const toolCalls =
      (context.tools?.length ?? 0) > 0 ? parseToolCalls(result.text) : [];
    const text =
      toolCalls.length > 0 ? stripToolMarkup(result.text) : result.text;
    deps.emit(stream, model, {
      text,
      thinking: result.thinking,
      toolCalls,
    });
  } catch (error) {
    if (signal.aborted) {
      stream.fail(signal.reason ?? error);
    } else {
      stream.fail(tokenError(error));
    }
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
