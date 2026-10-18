import { describe, expect, test } from "bun:test";
import { resolveThinkingEnabled } from "../src/deepseek/options";

describe("thinking resolution", () => {
  test("disables thinking for native tool turns by default", () => {
    expect(resolveThinkingEnabled(undefined, true)).toBe(false);
    expect(resolveThinkingEnabled("auto", true)).toBe(false);
  });

  test("enables thinking for tool-free turns by default", () => {
    expect(resolveThinkingEnabled(undefined, false)).toBe(true);
  });

  test("honors explicit overrides", () => {
    expect(resolveThinkingEnabled("1", true)).toBe(true);
    expect(resolveThinkingEnabled("0", false)).toBe(false);
    expect(resolveThinkingEnabled("true", true)).toBe(true);
    expect(resolveThinkingEnabled("false", false)).toBe(false);
  });
});
