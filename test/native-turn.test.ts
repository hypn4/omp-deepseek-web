import { describe, expect, test } from "bun:test";
import { needsNativeContinuation } from "../src/deepseek/native-turn";

describe("native completion triggers", () => {
  test("continues when incomplete_message is present, including an empty value", () => {
    expect(
      needsNativeContinuation({
        text: "partial",
        thinking: "",
        finished: true,
        incompleteMessage: "",
      }),
    ).toBe(true);
  });

  test("continues for a length finish reason", () => {
    expect(
      needsNativeContinuation({
        text: "partial",
        thinking: "",
        finished: true,
        finishReason: "length",
      }),
    ).toBe(true);
    expect(
      needsNativeContinuation({
        text: "partial",
        thinking: "",
        finished: true,
        finishReason: "max_tokens",
      }),
    ).toBe(true);
  });

  test("does not infer continuation from text shape", () => {
    expect(
      needsNativeContinuation({
        text: "The answer is incomplete…",
        thinking: "",
        finished: true,
      }),
    ).toBe(false);
  });

  test("does not continue a normal stop reason", () => {
    expect(
      needsNativeContinuation({
        text: "complete",
        thinking: "",
        finished: true,
        finishReason: "stop",
      }),
    ).toBe(false);
  });
});
