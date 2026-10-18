import {
  DEFAULT_BASE_URL,
  DEFAULT_HOSTNAME,
  DEFAULT_MAX_PROMPT_CHARS,
  DEFAULT_PORT,
  loadConfig,
} from "./config";
import type {
  CompletionClient,
  LogLevel,
  ServerConfig,
} from "./config";
import { DeepSeekApiError, DeepSeekClient, TokenError } from "./deepseek/client";
import { PowError } from "./deepseek/pow";
import { DeepSeekSseParser } from "./deepseek/sse";
import type { DeepSeekSseResult } from "./deepseek/sse";
import {
  buildPrompt,
  stripToolMarkup,
  toOpenAIChunks,
  toOpenAICompletion,
} from "./openai/translate";
import type {
  OpenAIChatRequest,
  OpenAIError,
  OpenAIMessage,
  OpenAIModelList,
  OpenAITool,
  OpenAIToolCall,
} from "./openai/types";
import { parseToolCalls } from "./tools/parser";
import type { ParsedToolCall } from "./tools/parser";

const MODEL_ID = "deepseek-web";

interface ResolvedConfig {
  port: number;
  hostname: string;
  maxPromptChars: number;
  thinking: boolean;
  search: boolean;
  logLevel: LogLevel;
  createClient: (token: string) => CompletionClient;
}

/** A running proxy; `stop()` releases the listening socket. */
export interface RunningServer {
  port: number;
  stop(): void;
}

function resolveConfig(config: ServerConfig): ResolvedConfig {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const deviceId = config.deviceId ?? globalThis.crypto.randomUUID();
  return {
    port: config.port ?? DEFAULT_PORT,
    hostname: config.hostname ?? DEFAULT_HOSTNAME,
    maxPromptChars: config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
    thinking: config.thinking ?? false,
    search: config.search ?? false,
    logLevel: config.logLevel ?? "info",
    createClient:
      config.createClient ??
      ((token) =>
        new DeepSeekClient({
          baseUrl,
          token,
          deviceId,
        })),
  };
}

function errorResponse(
  status: number,
  message: string,
  type: string,
  code: string | null,
): Response {
  const body: OpenAIError = { error: { message, type, code } };
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token !== "" ? token : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseToolCall(value: unknown): OpenAIToolCall | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const fn = asRecord(record.function);
  if (fn === null || typeof fn.name !== "string" || fn.name === "") {
    return null;
  }
  if (record.id !== undefined && typeof record.id !== "string") {
    return null;
  }
  const id =
    typeof record.id === "string" ? record.id : globalThis.crypto.randomUUID();
  return {
    id,
    type: "function",
    function: {
      name: fn.name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : "",
    },
  };
}

function parseMessage(value: unknown): OpenAIMessage | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const role = record.role;
  if (
    role !== "system" &&
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool"
  ) {
    return null;
  }
  const content = record.content;
  if (content !== undefined && content !== null && typeof content !== "string") {
    return null;
  }

  const message: OpenAIMessage = {
    role,
    content: typeof content === "string" ? content : null,
  };
  if (typeof record.name === "string") {
    message.name = record.name;
  }
  if (typeof record.tool_call_id === "string") {
    message.tool_call_id = record.tool_call_id;
  }
  if (record.tool_calls !== undefined) {
    if (!Array.isArray(record.tool_calls)) {
      return null;
    }
    const calls: OpenAIToolCall[] = [];
    for (const raw of record.tool_calls) {
      const call = parseToolCall(raw);
      if (call === null) {
        return null;
      }
      calls.push(call);
    }
    if (calls.length > 0) {
      message.tool_calls = calls;
    }
  }
  return message;
}

function parseTools(value: unknown): OpenAITool[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const tools: OpenAITool[] = [];
  for (const raw of value) {
    const record = asRecord(raw);
    if (record === null) {
      return null;
    }
    const fn = asRecord(record.function);
    if (fn === null || typeof fn.name !== "string") {
      return null;
    }
    const tool: OpenAITool = {
      type: "function",
      function: { name: fn.name },
    };
    if (typeof fn.description === "string") {
      tool.function.description = fn.description;
    }
    const parameters = asRecord(fn.parameters);
    if (parameters !== null) {
      tool.function.parameters = parameters;
    }
    tools.push(tool);
  }
  return tools;
}

function parseChatRequest(value: unknown): OpenAIChatRequest | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const rawMessages = record.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return null;
  }
  const messages: OpenAIMessage[] = [];
  for (const raw of rawMessages) {
    const message = parseMessage(raw);
    if (message === null) {
      return null;
    }
    messages.push(message);
  }

  const tools = parseTools(record.tools);
  if (tools === null) {
    return null;
  }

  return {
    messages,
    tools,
    stream: typeof record.stream === "boolean" ? record.stream : false,
    thinking_enabled:
      typeof record.thinking_enabled === "boolean"
        ? record.thinking_enabled
        : undefined,
    search_enabled:
      typeof record.search_enabled === "boolean"
        ? record.search_enabled
        : undefined,
  };
}

/**
 * Reads the upstream stream and returns the accumulated answer. A stream that
 * breaks after producing text yields the partial answer, as the spec requires;
 * a stream that breaks before any text is an upstream error.
 */
async function collectCompletion(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  logLevel: LogLevel,
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
    }
    parser.feed(decoder.decode());
    return parser.result();
  } catch (error) {
    const partial = parser.result();
    if (signal.aborted) {
      return partial;
    }
    if (partial.text !== "" || partial.thinking !== "") {
      if (logLevel === "debug") {
        console.error(
          `[deepseek-web] completion stream ended early: ${errorMessage(error)}`,
        );
      }
      return partial;
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapError(error: unknown): Response {
  if (error instanceof TokenError) {
    return errorResponse(
      401,
      "DeepSeek token is invalid or expired. Run `bun run login` to refresh it.",
      "authentication_error",
      "invalid_api_key",
    );
  }
  if (error instanceof PowError) {
    return errorResponse(
      502,
      "DeepSeek proof-of-work failed. Try the request again.",
      "upstream_error",
      "pow_failed",
    );
  }
  if (error instanceof DeepSeekApiError) {
    if (error.code === 50006 || error.status === 429) {
      return errorResponse(429, error.message, "rate_limit_error", "rate_limited");
    }
    return errorResponse(
      502,
      `DeepSeek request failed: ${error.message}`,
      "upstream_error",
      "deepseek_error",
    );
  }
  console.error(`[deepseek-web] request failed: ${errorMessage(error)}`);
  return errorResponse(
    502,
    "DeepSeek request failed.",
    "upstream_error",
    "upstream_error",
  );
}

function modelsResponse(): Response {
  const body: OpenAIModelList = {
    object: "list",
    data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "deepseek" }],
  };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

function completionResponse(
  text: string,
  thinking: string,
  toolCalls: ParsedToolCall[],
  stream: boolean,
): Response {
  if (!stream) {
    return Response.json(toOpenAICompletion(text, thinking, toolCalls), {
      headers: { "cache-control": "no-store" },
    });
  }
  return new Response(toOpenAIChunks(text, thinking, toolCalls), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

async function handleChatCompletion(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  const token = bearerToken(request);
  if (token === null) {
    return errorResponse(
      401,
      "Missing bearer token. Run `bun run login` to obtain a DeepSeek token.",
      "authentication_error",
      "invalid_api_key",
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(
      400,
      "Request body must be valid JSON.",
      "invalid_request_error",
      "invalid_json",
    );
  }

  const parsed = parseChatRequest(raw);
  if (parsed === null) {
    return errorResponse(
      400,
      "messages must be a non-empty array of valid chat messages.",
      "invalid_request_error",
      "invalid_request",
    );
  }

  const tools = parsed.tools ?? [];
  const prompt = buildPrompt(parsed.messages, tools);
  if (prompt.length > config.maxPromptChars) {
    return errorResponse(
      413,
      `Prompt is ${prompt.length} characters, over the ${config.maxPromptChars} character limit.`,
      "invalid_request_error",
      "prompt_too_long",
    );
  }

  // The web model only supports tool calls with thinking disabled.
  const thinkingEnabled =
    tools.length === 0 && (parsed.thinking_enabled ?? config.thinking);
  const searchEnabled = parsed.search_enabled ?? config.search;

  const client = config.createClient(token);
  let sessionId: string | null = null;
  try {
    sessionId = await client.createSession();
    const upstream = await client.complete(
      {
        chatSessionId: sessionId,
        prompt,
        thinkingEnabled,
        searchEnabled,
      },
      request.signal,
    );
    const result = await collectCompletion(
      upstream,
      request.signal,
      config.logLevel,
    );
    const toolCalls = parseToolCalls(result.text);
    const content =
      toolCalls.length > 0 ? stripToolMarkup(result.text) : result.text;
    return completionResponse(
      content,
      result.thinking,
      toolCalls,
      parsed.stream === true,
    );
  } catch (error) {
    return mapError(error);
  } finally {
    if (sessionId !== null) {
      try {
        await client.deleteSession(sessionId);
      } catch (error) {
        console.error(
          `[deepseek-web] failed to delete session ${sessionId}: ${errorMessage(error)}`,
        );
      }
    }
  }
}

async function handleRequest(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/v1/models") {
    return modelsResponse();
  }
  if (request.method === "POST" && pathname === "/v1/chat/completions") {
    return handleChatCompletion(request, config);
  }
  return errorResponse(
    404,
    `Unknown endpoint: ${request.method} ${pathname}`,
    "invalid_request_error",
    "not_found",
  );
}

/**
 * Starts the OpenAI-compatible proxy. The server binds to loopback by default
 * and returns the bound port (relevant when `port: 0` is used in tests).
 */
export function startServer(config: ServerConfig): RunningServer {
  const resolved = resolveConfig(config);
  const server = Bun.serve({
    port: resolved.port,
    hostname: resolved.hostname,
    fetch: (request) => handleRequest(request, resolved),
  });
  return {
    port: server.port,
    stop: () => {
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const server = startServer(config);
  const hostname = config.hostname ?? DEFAULT_HOSTNAME;
  console.log(`deepseek-web listening on http://${hostname}:${server.port}`);
  const shutdown = (): void => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
