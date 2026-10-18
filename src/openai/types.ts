/**
 * Minimal OpenAI wire types shared by the tool bridge and the proxy server.
 */

export interface OpenAIToolFunction {
  name: string;
  description?: string;
  /** JSON Schema object describing the function arguments. */
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON encoded arguments, as required by the OpenAI wire format. */
    arguments: string;
  };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

/** Request body accepted by `POST /v1/chat/completions`. */
export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  /** Sampling fields are accepted but ignored: the web API has no such knobs. */
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
  /** DeepSeek-specific extensions; both default to false. */
  thinking_enabled?: boolean;
  search_enabled?: boolean;
}

export type OpenAIFinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface OpenAIAssistantMessage {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIAssistantMessage;
    finish_reason: OpenAIFinishReason;
  }>;
  usage?: OpenAIUsage;
}

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIChunkDelta {
  role?: "assistant";
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: OpenAIChunkDelta;
    finish_reason: OpenAIFinishReason | null;
  }>;
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}
