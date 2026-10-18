import { describe, expect, test } from "bun:test";
import {
  parseRetryAfter,
  RequestGate,
  retryAfterFromHeaders,
} from "../src/deepseek/rate-limit";

describe("Retry-After parsing", () => {
  test("parses delta seconds and HTTP dates", () => {
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter(new Date(Date.now() + 3000).toUTCString())).toBeGreaterThanOrEqual(1500);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });

  test("prefers Retry-After headers over reset epochs", () => {
    const headers = new Headers({ "retry-after": "2", "x-ratelimit-reset": "9999999999999" });
    expect(retryAfterFromHeaders(headers)).toBe(2000);
  });

  test("parses epoch reset headers when Retry-After is absent", () => {
    const headers = new Headers({ "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 5) });
    expect(retryAfterFromHeaders(headers)).toBeGreaterThanOrEqual(4000);
  });
});

describe("RequestGate", () => {
  test("applies a shared cooldown", async () => {
    const gate = new RequestGate({ minIntervalMs: 0 });
    gate.cooldown(20);
    const started = Date.now();
    await gate.wait(new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
