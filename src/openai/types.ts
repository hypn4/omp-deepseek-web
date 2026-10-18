/**
 * Minimal OpenAI wire types shared by the tool bridge and (from Task 5) the
 * server. Task 5 extends this file; do not duplicate these definitions.
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
