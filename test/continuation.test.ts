import { describe, expect, test } from "bun:test";
import {
  buildContinuationPrompt,
  isContinuationComplete,
  isLikelyIncomplete,
  mergeContinuation,
} from "../src/deepseek/continuation";

describe("truncation detection", () => {
  test("treats an unfinished stream as incomplete", () => {
    expect(
      isLikelyIncomplete({ text: "The answer is complete.", finished: false }),
    ).toBe(true);
  });

  test("accepts a finished answer ending in terminal punctuation", () => {
    expect(
      isLikelyIncomplete({
        text: "The answer is complete. [reference:1]",
        finished: true,
      }),
    ).toBe(false);
  });

  test("detects a Korean connective cut off mid-sentence", () => {
    expect(
      isLikelyIncomplete({
        text: "요약하면 실질 혜택은 분명 있지만",
        finished: true,
      }),
    ).toBe(true);
  });

  test("detects an English conjunction cut off mid-sentence", () => {
    expect(
      isLikelyIncomplete({ text: "The result is useful but", finished: true }),
    ).toBe(true);
  });

  test("accepts a short list item without punctuation", () => {
    expect(isLikelyIncomplete({ text: "1\n2\n1000", finished: true })).toBe(
      false,
    );
  });

  test("accepts a table row without punctuation", () => {
    expect(
      isLikelyIncomplete({ text: "| Day | Result |\n| --- | --- |", finished: true }),
    ).toBe(false);
  });

  test("detects a long line cut off without punctuation", () => {
    expect(
      isLikelyIncomplete({
        text: "This is a long sentence that was cut off before the model could finish",
        finished: true,
      }),
    ).toBe(true);
  });
});

describe("continuation merging", () => {
  test("removes an overlap between the existing text and the continuation", () => {
    expect(mergeContinuation("Hello wor", "world")).toBe("Hello world");
  });

  test("uses the continuation when it repeats the full answer", () => {
    expect(mergeContinuation("Hello", "Hello world")).toBe("Hello world");
  });

  test("appends a continuation with no overlap", () => {
    expect(mergeContinuation("Hello.", " Next sentence.")).toBe(
      "Hello. Next sentence.",
    );
  });

  test("ignores the completion marker", () => {
    expect(mergeContinuation("Hello", "[COMPLETE]")).toBe("Hello");
  });

  test("recognizes a completion marker followed by an explanation", () => {
    expect(isContinuationComplete("[COMPLETE]\nThe answer is complete.")).toBe(
      true,
    );
    expect(mergeContinuation("Hello", "[COMPLETE]\nThe answer is complete.")).toBe(
      "Hello",
    );
    expect(isContinuationComplete("[COMPLETE].")).toBe(true);
  });

  test("builds a tail-aware prompt when no parent message exists", () => {
    const prompt = buildContinuationPrompt("previous answer");
    expect(prompt).toContain("previous answer");
    expect(prompt).toContain("Continue");
  });
});
