import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { ParsedToolCall } from "../src/tools/parser";
import { emitBufferedCompletion } from "../omp-extension/events";

class FakeSink {
  readonly events: AssistantMessageEvent[] = [];
  ended: AssistantMessage | undefined;

  push(event: AssistantMessageEvent): void {
    this.events.push(structuredClone(event));
  }

  end(message?: AssistantMessage): void {
    this.ended = message;
  }

  fail(_error: unknown): void {
    throw new Error("buffered emitter must not fail a turn");
  }
}

const MODEL = {
  api: "deepseek-web",
  provider: "deepseek-web",
  id: "deepseek-web",
};

function completion(
  text: string,
  thinking = "",
  toolCalls: ParsedToolCall[] = [],
) {
  return { text, thinking, toolCalls };
}

describe("buffered completion emitter", () => {
  test("emits a text turn and ends with a stop reason", () => {
    const sink = new FakeSink();

    emitBufferedCompletion(sink, MODEL, completion("hello"));

    expect(sink.events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(sink.ended?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(sink.ended?.stopReason).toBe("stop");
    expect(sink.ended?.usage.totalTokens).toBe(0);
    expect(sink.ended?.provider).toBe("deepseek-web");
  });

  test("emits thinking before text", () => {
    const sink = new FakeSink();

    emitBufferedCompletion(sink, MODEL, completion("answer", "plan"));

    expect(sink.events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(sink.ended?.content[0]).toEqual({ type: "thinking", thinking: "plan" });
    expect(sink.ended?.content[1]).toEqual({ type: "text", text: "answer" });
  });

  test("emits tool calls with a toolUse stop reason", () => {
    const sink = new FakeSink();
    const toolCalls: ParsedToolCall[] = [
      { id: "call-1", name: "read", arguments: JSON.stringify({ path: "/tmp/file" }) },
    ];

    emitBufferedCompletion(sink, MODEL, completion("Reading.", "", toolCalls));

    expect(sink.events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(sink.ended?.stopReason).toBe("toolUse");
    expect(sink.ended?.content.at(-1)).toEqual({
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "/tmp/file" },
    });

    const toolCallEnd = sink.events.find((event) => event.type === "toolcall_end");
    expect(toolCallEnd?.type).toBe("toolcall_end");
    if (toolCallEnd?.type === "toolcall_end") {
      expect(toolCallEnd.toolCall.id).toBe("call-1");
      expect(toolCallEnd.toolCall.arguments).toEqual({ path: "/tmp/file" });
    }
  });

  test("handles an empty response", () => {
    const sink = new FakeSink();

    emitBufferedCompletion(sink, MODEL, completion(""));

    expect(sink.events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(sink.ended?.content).toEqual([]);
    expect(sink.ended?.stopReason).toBe("stop");
  });
});
