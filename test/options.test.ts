import { describe, expect, test } from "bun:test";
import { resolveThinkingEnabled } from "../src/deepseek/options";

describe("thinking resolution", () => {
  test("enables thinking by default", () => {
    expect(resolveThinkingEnabled(undefined)).toBe(true);
    expect(resolveThinkingEnabled("auto")).toBe(true);
  });

  test("honors explicit overrides", () => {
    expect(resolveThinkingEnabled("1")).toBe(true);
    expect(resolveThinkingEnabled("0")).toBe(false);
    expect(resolveThinkingEnabled("true")).toBe(true);
    expect(resolveThinkingEnabled("false")).toBe(false);
  });
});
