import type { OpenAIMessage, OpenAIToolCall } from "../openai/types";
import { TOOL_CALL_MARKER } from "./protocol";
import { stripMalformedDsmlTail } from "./parser";

const CONTINUE_PROMPT =
  "Continue the task using the tool results above. Do not repeat a tool call unless it is necessary.";

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return stripMalformedDsmlTail(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = sanitizeValue(entry);
    }
    return result;
  }
  return value;
}

function argumentsObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return sanitizeValue(parsed) as Record<string, unknown>;
    }
  } catch {
    // Historical calls may be malformed; retain an empty object rather than
    // injecting broken markup into the next prompt.
  }
  return {};
}

function renderToolCalls(calls: OpenAIToolCall[]): string {
  const payload = {
    calls: calls.map((call) => ({
      name: call.function.name,
      arguments: argumentsObject(call.function.arguments),
    })),
  };
  return `${TOOL_CALL_MARKER}\n${JSON.stringify(payload)}`;
}

/**
 * Renders the conversation transcript sent to DeepSeek. System messages are
 * handled by the caller (they precede the tool protocol block), so they are
 * skipped here. Prior assistant tool calls are replayed in the JSON marker
 * protocol so the model sees its own output format.
 */
export function renderToolResults(messages: OpenAIMessage[]): string {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.tool_calls ?? []) {
      toolNames.set(call.id, call.function.name);
    }
  }

  const blocks: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break;
      case "user":
        blocks.push(`User:\n${message.content ?? ""}`);
        break;
      case "assistant": {
        let block = `Assistant:\n${message.content ?? ""}`;
        if (message.tool_calls && message.tool_calls.length > 0) {
          block += `\n${renderToolCalls(message.tool_calls)}`;
        }
        blocks.push(block);
        break;
      }
      case "tool": {
        const callId = message.tool_call_id ?? "";
        const name = toolNames.get(callId) ?? message.name ?? "tool";
        blocks.push(`Tool result for ${name} (call ${callId}):\n${message.content ?? ""}`);
        break;
      }
    }
  }

  if (messages.at(-1)?.role === "tool") {
    blocks.push(CONTINUE_PROMPT);
  }

  return blocks.join("\n\n");
}
