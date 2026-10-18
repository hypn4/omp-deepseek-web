import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WEB_CONTEXT_WINDOW,
  resolveContextWindow,
  resolveThinkingEnabled,
} from "../src/deepseek/options";

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

describe("web context window", () => {
  test("defaults to the verified native web API context limit", () => {
    expect(resolveContextWindow(undefined)).toBe(DEFAULT_WEB_CONTEXT_WINDOW);
    expect(DEFAULT_WEB_CONTEXT_WINDOW).toBe(1_000_000);
  });

  test("accepts a positive integer override and rejects invalid values", () => {
    expect(resolveContextWindow("1000000")).toBe(1_000_000);
    expect(resolveContextWindow("0")).toBe(DEFAULT_WEB_CONTEXT_WINDOW);
    expect(resolveContextWindow("nope")).toBe(DEFAULT_WEB_CONTEXT_WINDOW);
  });
});
