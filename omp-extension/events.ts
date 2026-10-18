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

export interface CompletionResult {
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

const PIPE = String.fromCharCode(0xff5c);
const TOOL_MARKER = new RegExp(
  `<\\s*(?:${PIPE}|\\|)?\\s*DSML|tool_calls_begin|tool_calls_end|end_of_query|tool_sep`,
  "i",
);

/**
 * Holds back a small tail until text is final. This prevents a DSML/tool block
 * split across SSE chunks from being rendered as ordinary assistant text.
 */
class TextDeltaFilter {
  #buffer = "";
  #stopped = false;

  push(delta: string): string {
    if (this.#stopped) {
      return "";
    }
    this.#buffer += delta;
    const marker = this.#buffer.search(TOOL_MARKER);
    if (marker !== -1) {
      const safe = this.#buffer.slice(0, marker);
      this.#buffer = "";
      this.#stopped = true;
      return safe;
    }
    if (this.#buffer.length <= 64) {
      return "";
    }
    const safe = this.#buffer.slice(0, -64);
    this.#buffer = this.#buffer.slice(-64);
    return safe;
  }

  finish(hasToolCalls: boolean): string {
    if (this.#stopped || hasToolCalls) {
      this.#buffer = "";
      return "";
    }
    const safe = this.#buffer;
    this.#buffer = "";
    return safe;
  }
}

/**
 * Streams thinking and safe text deltas as they arrive. Tool calls require the
 * complete response, so they are appended when the turn finishes.
 */
export class StreamingCompletion {
  readonly #stream: EventSink;
  readonly #partial: AssistantMessage;
  readonly #blocks: AssistantMessage["content"];
  readonly #textFilter = new TextDeltaFilter();
  #started = false;
  #finished = false;
  #thinkingIndex: number | null = null;
  #thinkingClosed = false;
  #textIndex: number | null = null;

  constructor(stream: EventSink, model: ModelIdentity) {
    this.#stream = stream;
    this.#blocks = [];
    this.#partial = {
      role: "assistant",
      content: this.#blocks,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#stream.push({ type: "start", partial: this.#partial });
  }

  thinkingDelta(delta: string): void {
    if (delta.length === 0) {
      return;
    }
    this.start();
    if (this.#thinkingIndex === null) {
      this.#blocks.push({ type: "thinking", thinking: "" });
      this.#thinkingIndex = this.#blocks.length - 1;
      this.#stream.push({
        type: "thinking_start",
        contentIndex: this.#thinkingIndex,
        partial: this.#partial,
      });
    }
    const block = this.#blocks[this.#thinkingIndex];
    if (block?.type === "thinking") {
      block.thinking += delta;
      this.#stream.push({
        type: "thinking_delta",
        contentIndex: this.#thinkingIndex,
        delta,
        partial: this.#partial,
      });
    }
  }

  textDelta(delta: string): void {
    if (delta.length === 0) {
      return;
    }
    this.start();
    const safe = this.#textFilter.push(delta);
    if (safe.length === 0) {
      return;
    }
    this.#closeThinking();
    this.#ensureTextBlock();
    if (this.#textIndex === null) {
      return;
    }
    const block = this.#blocks[this.#textIndex];
    if (block?.type === "text") {
      block.text += safe;
      this.#stream.push({
        type: "text_delta",
        contentIndex: this.#textIndex,
        delta: safe,
        partial: this.#partial,
      });
    }
  }

  finish(result: CompletionResult): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.start();

    if (result.thinking.length > 0) {
      if (this.#thinkingIndex === null) {
        this.#blocks.push({ type: "thinking", thinking: "" });
        this.#thinkingIndex = this.#blocks.length - 1;
        this.#stream.push({
          type: "thinking_start",
          contentIndex: this.#thinkingIndex,
          partial: this.#partial,
        });
        this.#stream.push({
          type: "thinking_delta",
          contentIndex: this.#thinkingIndex,
          delta: result.thinking,
          partial: this.#partial,
        });
        const block = this.#blocks[this.#thinkingIndex];
        if (block?.type === "thinking") {
          block.thinking = result.thinking;
        }
      } else {
        const block = this.#blocks[this.#thinkingIndex];
        if (block?.type === "thinking") {
          if (result.thinking.startsWith(block.thinking)) {
            const suffix = result.thinking.slice(block.thinking.length);
            if (suffix.length > 0) {
              block.thinking += suffix;
              this.#stream.push({
                type: "thinking_delta",
                contentIndex: this.#thinkingIndex,
                delta: suffix,
                partial: this.#partial,
              });
            }
          } else {
            block.thinking = result.thinking;
          }
        }
      }
      this.#stream.push({
        type: "thinking_end",
        contentIndex: this.#thinkingIndex,
        content: result.thinking,
        partial: this.#partial,
      });
      this.#thinkingClosed = true;
    } else if (this.#thinkingIndex !== null) {
      this.#closeThinking();
    }

    const safeTail = this.#textFilter.finish(result.toolCalls.length > 0);
    if (result.text.length > 0) {
      if (this.#textIndex === null) {
        this.#blocks.push({ type: "text", text: "" });
        this.#textIndex = this.#blocks.length - 1;
        this.#stream.push({
          type: "text_start",
          contentIndex: this.#textIndex,
          partial: this.#partial,
        });
        this.#stream.push({
          type: "text_delta",
          contentIndex: this.#textIndex,
          delta: result.text,
          partial: this.#partial,
        });
        const block = this.#blocks[this.#textIndex];
        if (block?.type === "text") {
          block.text = result.text;
        }
      } else {
        if (safeTail.length > 0) {
          const block = this.#blocks[this.#textIndex];
          if (block?.type === "text") {
            block.text += safeTail;
            this.#stream.push({
              type: "text_delta",
              contentIndex: this.#textIndex,
              delta: safeTail,
              partial: this.#partial,
            });
          }
        }
        const block = this.#blocks[this.#textIndex];
        if (block?.type === "text") {
          block.text = result.text;
        }
      }
      this.#stream.push({
        type: "text_end",
        contentIndex: this.#textIndex,
        content: result.text,
        partial: this.#partial,
      });
    } else if (this.#textIndex !== null) {
      const block = this.#blocks[this.#textIndex];
      if (block?.type === "text") {
        this.#stream.push({
          type: "text_end",
          contentIndex: this.#textIndex,
          content: block.text,
          partial: this.#partial,
        });
      }
    }

    for (const call of result.toolCalls) {
      const argumentsObject = parseArguments(call.arguments);
      this.#blocks.push({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: argumentsObject,
      });
      const contentIndex = this.#blocks.length - 1;
      this.#stream.push({
        type: "toolcall_start",
        contentIndex,
        partial: this.#partial,
      });
      this.#stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta: JSON.stringify(argumentsObject),
        partial: this.#partial,
      });
      this.#stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: {
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: argumentsObject,
        },
        partial: this.#partial,
      });
    }

    const reason = result.toolCalls.length > 0 ? "toolUse" : "stop";
    this.#partial.stopReason = reason;
    this.#stream.push({ type: "done", reason, message: this.#partial });
    this.#stream.end(this.#partial);
  }

  fail(error: unknown): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#stream.fail(error);
  }

  #ensureTextBlock(): void {
    if (this.#textIndex !== null) {
      return;
    }
    this.#blocks.push({ type: "text", text: "" });
    this.#textIndex = this.#blocks.length - 1;
    this.#stream.push({
      type: "text_start",
      contentIndex: this.#textIndex,
      partial: this.#partial,
    });
  }

  #closeThinking(): void {
    if (this.#thinkingIndex === null || this.#thinkingClosed) {
      return;
    }
    const block = this.#blocks[this.#thinkingIndex];
    if (block?.type === "thinking") {
      this.#stream.push({
        type: "thinking_end",
        contentIndex: this.#thinkingIndex,
        content: block.thinking,
        partial: this.#partial,
      });
    }
    this.#thinkingClosed = true;
  }
}
