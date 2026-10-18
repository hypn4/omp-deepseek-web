import { describe, expect, test } from "bun:test";
import { mergeContinuation } from "../src/deepseek/stream-merge";

describe("native stream merging", () => {
  test("removes an overlap between existing text and a continuation", () => {
    expect(mergeContinuation("Hello wor", "world")).toBe("Hello world");
  });

  test("uses the continuation when it repeats the full answer", () => {
    expect(mergeContinuation("Hello", "Hello world")).toBe("Hello world");
  });

  test("keeps the longer existing text while a full response is still streaming", () => {
    expect(mergeContinuation("Hello world", "Hello")).toBe("Hello world");
  });

  test("appends a continuation with no overlap", () => {
    expect(mergeContinuation("Hello.", " Next sentence.")).toBe(
      "Hello. Next sentence.",
    );
  });

  test("keeps the existing text for an empty continuation", () => {
    expect(mergeContinuation("Hello", "")).toBe("Hello");
  });
});
