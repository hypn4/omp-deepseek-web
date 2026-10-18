import type {
  AssistantMessage,
  AssistantMessageEvent,
  Usage,
} from "@oh-my-pi/pi-ai";
import type { ParsedToolCall } from "../src/tools/parser";

export interface ModelIdentity {
  api: AssistantMessage["api"];
  provider: string;
  id: string;
}

export interface BufferedCompletion {
  text: string;
  thinking: string;
  toolCalls: ParsedToolCall[];
}

export interface EventSink {
  push(event: AssistantMessageEvent): void;
  end(message?: AssistantMessage): void;
  fail(error: unknown): void;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // DeepSeek produced malformed JSON; expose an empty call rather than crash.
  }
  return {};
}

/**
 * Emits a fully buffered DeepSeek answer as canonical omp stream events.
 * Buffering keeps tool-call parsing deterministic; the final message is still
 * delivered through the normal start/text/toolcall/done sequence.
 */
export function emitBufferedCompletion(
  stream: EventSink,
  model: ModelIdentity,
  completion: BufferedCompletion,
): void {
  const blocks: AssistantMessage["content"] = [];
  const partial: AssistantMessage = {
    role: "assistant",
    content: blocks,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };

  stream.push({ type: "start", partial });

  if (completion.thinking.length > 0) {
    const thinking = { type: "thinking" as const, thinking: completion.thinking };
    blocks.push(thinking);
    const contentIndex = blocks.length - 1;
    stream.push({ type: "thinking_start", contentIndex, partial });
    stream.push({
      type: "thinking_delta",
      contentIndex,
      delta: thinking.thinking,
      partial,
    });
    stream.push({
      type: "thinking_end",
      contentIndex,
      content: thinking.thinking,
      partial,
    });
  }

  if (completion.text.length > 0) {
    const text = { type: "text" as const, text: completion.text };
    blocks.push(text);
    const contentIndex = blocks.length - 1;
    stream.push({ type: "text_start", contentIndex, partial });
    stream.push({ type: "text_delta", contentIndex, delta: text.text, partial });
    stream.push({ type: "text_end", contentIndex, content: text.text, partial });
  }

  for (const call of completion.toolCalls) {
    const argumentsObject = parseArguments(call.arguments);
    const toolCall = {
      type: "toolCall" as const,
      id: call.id,
      name: call.name,
      arguments: argumentsObject,
    };
    blocks.push(toolCall);
    const contentIndex = blocks.length - 1;
    const serialized = JSON.stringify(argumentsObject);
    stream.push({ type: "toolcall_start", contentIndex, partial });
    stream.push({
      type: "toolcall_delta",
      contentIndex,
      delta: serialized,
      partial,
    });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
  }

  const reason = completion.toolCalls.length > 0 ? "toolUse" : "stop";
  partial.stopReason = reason;
  stream.push({ type: "done", reason, message: partial });
  stream.end(partial);
}
