import { afterEach, describe, expect, test } from "bun:test";
import { DeepSeekClient, TokenError } from "../src/deepseek/client";
import { PowError } from "../src/deepseek/pow";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

const COMPLETION_URL = "https://chat.deepseek.com/api/v0/chat/completion";
const CHALLENGE_URL =
  "https://chat.deepseek.com/api/v0/chat/create_pow_challenge";
const CHECK_DEVICE_URL =
  "https://chat.deepseek.com/api/v0/users/auth_token/check_device";
const SESSION_CREATE_URL =
  "https://chat.deepseek.com/api/v0/chat_session/create";
const SESSION_DELETE_URL =
  "https://chat.deepseek.com/api/v0/chat_session/delete";

const POW_CHALLENGE = {
  algorithm: "DeepSeekHashV1",
  challenge: "39f83c0fc61fe0eff53fcd7a1f5276942fd18d146d92a0a45d9b6643419a29d6",
  salt: "f5ffa87745b8eb2b56d4",
  signature: "4d9f4f7f3d0f5f2e8a7c6b5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f",
  difficulty: 144000,
  expire_at: 1792251384408,
  target_path: "/api/v0/chat/completion",
};

const SSE_BODY = 'data: {"v":"hello"}\n\n';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envelope(bizData: unknown): unknown {
  return { code: 0, msg: "", data: { biz_code: 0, biz_msg: "", biz_data: bizData } };
}

function challengeResponse(): Response {
  return jsonResponse(envelope({ challenge: POW_CHALLENGE }));
}

function completionError(code: number, status = 401): Response {
  return jsonResponse(
    { code: 0, msg: "", data: { biz_code: code, biz_msg: "upstream failure" } },
    status,
  );
}

function sseResponse(): Response {
  return new Response(SSE_BODY, {
    headers: { "content-type": "text/event-stream" },
  });
}

function rotatedResponse(token: string): Response {
  return jsonResponse(envelope({ rotate: true, data: { token } }));
}

function notRotatedResponse(): Response {
  return jsonResponse(envelope({ rotate: null, data: null }));
}

function installFetch(...responses: Array<Response | Error>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init });
    const next = responses[calls.length - 1];
    if (next === undefined) {
      throw new Error(`unexpected fetch call ${calls.length}: ${url}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as typeof fetch;
  return calls;
}

function makeClient(tokenCommand?: string): DeepSeekClient {
  return new DeepSeekClient({
    baseUrl: "https://chat.deepseek.com",
    token: "old-token",
    deviceId: "device-1",
    tokenCommand,
  });
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function authorizationOf(call: FetchCall): string | null {
  return new Headers(call.init.headers).get("authorization");
}

function completionCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.url === COMPLETION_URL);
}

describe("DeepSeekClient retry", () => {
  test("retries once with the token rotated by check_device", async () => {
    const calls = installFetch(
      challengeResponse(),
      completionError(40003),
      rotatedResponse("new-token"),
      challengeResponse(),
      sseResponse(),
    );

    const stream = await makeClient().complete({
      chatSessionId: "session-1",
      prompt: "hello",
    });

    expect(await new Response(stream).text()).toBe(SSE_BODY);
    expect(calls.map((call) => call.url)).toEqual([
      CHALLENGE_URL,
      COMPLETION_URL,
      CHECK_DEVICE_URL,
      CHALLENGE_URL,
      COMPLETION_URL,
    ]);

    const completions = completionCalls(calls);
    expect(completions).toHaveLength(2);
    expect(authorizationOf(completions[0]!)).toBe("Bearer old-token");
    expect(authorizationOf(completions[1]!)).toBe("Bearer new-token");

    const check = calls[2]!;
    expect(JSON.parse(String(check.init.body))).toEqual({
      device_id: "device-1",
      device_model: "",
    });
    expect(authorizationOf(check)).toBe("Bearer old-token");
  });

  test("runs DEEPSEEK_WEB_TOKEN_CMD when check_device does not rotate", async () => {
    const calls = installFetch(
      challengeResponse(),
      completionError(40003),
      notRotatedResponse(),
      challengeResponse(),
      sseResponse(),
    );

    const stream = await makeClient("printf 'cmd-token\\n'").complete({
      chatSessionId: "session-1",
      prompt: "hello",
    });

    expect(await new Response(stream).text()).toBe(SSE_BODY);
    const completions = completionCalls(calls);
    expect(completions).toHaveLength(2);
    expect(authorizationOf(completions[1]!)).toBe("Bearer cmd-token");
  });

  test("returns TokenError when neither rotation nor a token command exists", async () => {
    const calls = installFetch(
      challengeResponse(),
      completionError(40003),
      notRotatedResponse(),
    );

    const error = await capture(
      makeClient().complete({ chatSessionId: "session-1", prompt: "hello" }),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(calls).toHaveLength(3);
  });

  test("does not retry a second auth failure", async () => {
    const calls = installFetch(
      challengeResponse(),
      completionError(40003),
      rotatedResponse("new-token"),
      challengeResponse(),
      completionError(40003),
    );

    const error = await capture(
      makeClient().complete({ chatSessionId: "session-1", prompt: "hello" }),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(completionCalls(calls)).toHaveLength(2);
  });

  test("retries once with a fresh challenge on a PoW error", async () => {
    const calls = installFetch(
      challengeResponse(),
      completionError(40301, 403),
      challengeResponse(),
      sseResponse(),
    );

    const stream = await makeClient().complete({
      chatSessionId: "session-1",
      prompt: "hello",
    });

    expect(await new Response(stream).text()).toBe(SSE_BODY);
    expect(
      calls.filter((call) => call.url === CHALLENGE_URL),
    ).toHaveLength(2);
    expect(completionCalls(calls)).toHaveLength(2);
    expect(calls.some((call) => call.url === CHECK_DEVICE_URL)).toBe(false);
  });

  test("does not retry a second PoW failure", async () => {
    const calls = installFetch(
      challengeResponse(),
      completionError(40300, 403),
      challengeResponse(),
      completionError(40300, 403),
    );

    const error = await capture(
      makeClient().complete({ chatSessionId: "session-1", prompt: "hello" }),
    );

    expect(error).toBeInstanceOf(PowError);
    expect(calls).toHaveLength(4);
  });

  test("retries once on a network error", async () => {
    const calls = installFetch(
      new TypeError("fetch failed"),
      challengeResponse(),
      sseResponse(),
    );

    const stream = await makeClient().complete({
      chatSessionId: "session-1",
      prompt: "hello",
    });

    expect(await new Response(stream).text()).toBe(SSE_BODY);
    expect(calls).toHaveLength(3);
  });

  test("does not retry a second network failure", async () => {
    const calls = installFetch(
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    );

    const error = await capture(
      makeClient().complete({ chatSessionId: "session-1", prompt: "hello" }),
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(2);
  });

  test("does not retry an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = installFetch(
      new DOMException("The operation was aborted.", "AbortError"),
    );

    const error = await capture(
      makeClient().complete(
        { chatSessionId: "session-1", prompt: "hello" },
        controller.signal,
      ),
    );

    expect(error).toBeInstanceOf(DOMException);
    expect(calls).toHaveLength(1);
  });

  test("maps a non-JSON 401 response to TokenError", async () => {
    installFetch(new Response("<html>unauthorized</html>", { status: 401 }));

    const error = await capture(makeClient().checkDevice("old-token", "device-1"));

    expect(error).toBeInstanceOf(TokenError);
  });

  test("falls back to the token command after a non-JSON check_device 401", async () => {
    const calls = installFetch(
      challengeResponse(),
      completionError(40003),
      new Response("<html>unauthorized</html>", { status: 401 }),
      challengeResponse(),
      sseResponse(),
    );

    const stream = await makeClient("printf 'cmd-token\\n'").complete({
      chatSessionId: "session-1",
      prompt: "hello",
    });

    expect(await new Response(stream).text()).toBe(SSE_BODY);
    const completions = completionCalls(calls);
    expect(completions).toHaveLength(2);
    expect(authorizationOf(completions[1]!)).toBe("Bearer cmd-token");
  });
});


