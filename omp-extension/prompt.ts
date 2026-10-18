import type { OpenAIMessage, OpenAITool, OpenAIToolCall } from "../src/openai/types";
import { buildPrompt } from "../src/openai/translate";

export interface PromptTextPart {
  type: "text";
  text: string;
}

export interface PromptImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PromptThinkingPart {
  type: "thinking";
  thinking: string;
}

export interface PromptToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type PromptUserContent = string | Array<PromptTextPart | PromptImagePart>;

export type PromptMessage =
  | { role: "user"; content: PromptUserContent }
  | { role: "developer"; content: PromptUserContent }
  | {
      role: "assistant";
      content: Array<PromptTextPart | PromptThinkingPart | PromptToolCall>;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: Array<PromptTextPart | PromptImagePart>;
      isError: boolean;
    };

export interface PromptTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface PromptContext {
  systemPrompt?: string[];
  messages: PromptMessage[];
  tools?: PromptTool[];
}

/** Converts a host tool schema into the JSON Schema sent to DeepSeek. */
export type ToolSchemaResolver = (
  tool: PromptTool,
) => Record<string, unknown> | undefined;

function textContent(content: PromptUserContent | PromptMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "thinking") {
      continue;
    }
    if (part.type === "image") {
      throw new Error("deepseek-web supports text input only");
    }
  }
  return parts.join("\n");
}

function toToolCall(call: PromptToolCall): OpenAIToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  };
}

/**
 * Converts omp's canonical conversation into the single DeepSeek prompt.
 * The OpenAI-shaped intermediate keeps the existing tool renderer and parser
 * as the single source of truth for the DSML protocol.
 */
export function buildOmpPrompt(
  context: PromptContext,
  toolSchema: ToolSchemaResolver,
): string {
  const systemParts = [...(context.systemPrompt ?? [])];
  const messages: OpenAIMessage[] = [];

  for (const message of context.messages) {
    switch (message.role) {
      case "developer":
        systemParts.push(textContent(message.content));
        break;
      case "user":
        messages.push({ role: "user", content: textContent(message.content) });
        break;
      case "assistant": {
        const text: string[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            text.push(part.text);
          } else if (part.type === "toolCall") {
            toolCalls.push(toToolCall(part));
          }
        }
        messages.push({
          role: "assistant",
          content: text.join(""),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        break;
      }
      case "toolResult":
        messages.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          name: message.toolName,
          content: textContent(message.content),
        });
        break;
    }
  }

  if (systemParts.length > 0) {
    messages.unshift({ role: "system", content: systemParts.join("\n\n") });
  }

  const tools: OpenAITool[] = (context.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: toolSchema(tool) ?? { type: "object", properties: {} },
    },
  }));

  return buildPrompt(messages, tools);
}
