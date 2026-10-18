import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { ParsedToolCall } from "../src/tools/parser";
import { StreamingCompletion } from "../omp-extension/events";

class FakeSink {
  readonly events: AssistantMessageEvent[] = [];
  ended: AssistantMessage | undefined;
  failure: unknown;

  push(event: AssistantMessageEvent): void {
    this.events.push(structuredClone(event));
  }

  end(message?: AssistantMessage): void {
    this.ended = message;
  }

  fail(error: unknown): void {
    this.failure = error;
  }
}

const MODEL = {
  api: "deepseek-web",
  provider: "deepseek-web",
  id: "deepseek-web",
};

const PIPE = String.fromCharCode(0xff5c);

describe("streaming completion", () => {
  test("streams thinking and safe text deltas before finishing", () => {
    const sink = new FakeSink();
    const emitter = new StreamingCompletion(sink, MODEL);
    const text = "x".repeat(80);

    emitter.start();
    emitter.thinkingDelta("plan");
    emitter.textDelta("x".repeat(40));
    emitter.textDelta("x".repeat(40));
    emitter.finish({ text, thinking: "plan", toolCalls: [] });

    const types = sink.events.map((event) => event.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("thinking_delta");
    expect(types).toContain("text_delta");
    expect(types.filter((type) => type === "text_delta").length).toBeGreaterThan(1);
    expect(types.at(-1)).toBe("done");
    expect(sink.ended?.content).toEqual([
      { type: "thinking", thinking: "plan" },
      { type: "text", text },
    ]);
    expect(sink.ended?.stopReason).toBe("stop");
  });

  test("does not stream DSML tool markup as text", () => {
    const sink = new FakeSink();
    const emitter = new StreamingCompletion(sink, MODEL);
    const markup = `<${PIPE}DSML${PIPE}tool_calls>\n<${PIPE}DSML${PIPE}invoke name="read">\n<${PIPE}DSML${PIPE}parameter name="path" string="true">README.md</${PIPE}DSML${PIPE}parameter>\n</invoke>\n</tool_calls>`;
    const toolCalls: ParsedToolCall[] = [
      { id: "call-1", name: "read", arguments: '{"path":"README.md"}' },
    ];

    emitter.start();
    emitter.textDelta("Reading the file.\n");
    emitter.textDelta(markup);
    emitter.finish({
      text: "Reading the file.\n",
      thinking: "",
      toolCalls,
    });

    const textDeltas = sink.events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event.type === "text_delta" ? event.delta : ""));
    expect(textDeltas.join("")).toBe("Reading the file.\n");
    expect(textDeltas.join("")).not.toContain("DSML");
    expect(sink.events.map((event) => event.type)).toContain("toolcall_end");
    expect(sink.ended?.content).toEqual([
      { type: "text", text: "Reading the file.\n" },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "README.md" },
      },
    ]);
    expect(sink.ended?.stopReason).toBe("toolUse");
  });

  test("emits blocks when no deltas were streamed", () => {
    const sink = new FakeSink();
    const emitter = new StreamingCompletion(sink, MODEL);

    emitter.start();
    emitter.finish({ text: "hello", thinking: "plan", toolCalls: [] });

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
    expect(sink.ended?.content).toEqual([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "hello" },
    ]);
  });

  test("handles an empty response", () => {
    const sink = new FakeSink();
    const emitter = new StreamingCompletion(sink, MODEL);

    emitter.start();
    emitter.finish({ text: "", thinking: "", toolCalls: [] });

    expect(sink.events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(sink.ended?.content).toEqual([]);
    expect(sink.ended?.stopReason).toBe("stop");
  });

  test("fails the sink on an upstream error", () => {
    const sink = new FakeSink();
    const emitter = new StreamingCompletion(sink, MODEL);
    const error = new Error("upstream down");

    emitter.start();
    emitter.fail(error);

    expect(sink.failure).toBe(error);
    expect(sink.events.map((event) => event.type)).toEqual(["start"]);
  });
});
