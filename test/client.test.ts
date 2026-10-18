import { afterEach, describe, expect, test } from "bun:test";
import { DeepSeekApiError, DeepSeekClient, TokenError } from "../src/deepseek/client";
import { PowError } from "../src/deepseek/pow";

interface FetchCall {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(...responses: Response[]): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected fetch call: ${String(input)}`);
    }
    return response;
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envelope(bizData: unknown): unknown {
  return { code: 0, msg: "", data: { biz_code: 0, biz_msg: "", biz_data: bizData } };
}

function makeClient(): DeepSeekClient {
  return new DeepSeekClient({
    baseUrl: "https://chat.deepseek.com/",
    token: "test-token",
    deviceId: "device-1",
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

const POW_CHALLENGE = {
  algorithm: "DeepSeekHashV1",
  challenge: "39f83c0fc61fe0eff53fcd7a1f5276942fd18d146d92a0a45d9b6643419a29d6",
  salt: "f5ffa87745b8eb2b56d4",
  signature: "4d9f4f7f3d0f5f2e8a7c6b5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f",
  difficulty: 144000,
  expire_at: 1792251384408,
  target_path: "/api/v0/chat/completion",
};

describe("DeepSeekClient", () => {
  test("createSession posts an empty body and returns the session id", async () => {
    const calls = installFetch(
      jsonResponse(envelope({ chat_session: { id: "session-1" } })),
    );

    await expect(makeClient().createSession()).resolves.toBe("session-1");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://chat.deepseek.com/api/v0/chat_session/create");
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe("{}");

    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-client-platform")).toBe("web");
    expect(headers.get("x-client-version")).toBe("2.5.0");
    expect(headers.get("x-client-bundle-id")).toBe("com.deepseek.chat");
    expect(headers.get("x-client-locale")).toBe("en_US");
    expect(headers.get("x-client-timezone-offset")).toBe("32400");
    expect(headers.get("x-device-id")).toBe("device-1");
    expect(headers.get("x-device-model")).toBe("");
  });

  test("createChallenge posts the target path and returns the challenge", async () => {
    const calls = installFetch(jsonResponse(envelope({ challenge: POW_CHALLENGE })));

    await expect(makeClient().createChallenge("/api/v0/chat/completion")).resolves.toEqual(
      POW_CHALLENGE,
    );

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      target_path: "/api/v0/chat/completion",
    });
  });

  test("complete sends the solved PoW header and the exact body fields", async () => {
    const calls = installFetch(
      jsonResponse(envelope({ challenge: POW_CHALLENGE })),
      new Response('data: {"v":"hello"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const stream = await makeClient().complete({
      chatSessionId: "session-1",
      prompt: "hello",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      "https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
    );

    const completion = calls[1]!;
    expect(completion.url).toBe("https://chat.deepseek.com/api/v0/chat/completion");
    expect(completion.init.method).toBe("POST");
    expect(JSON.parse(String(completion.init.body))).toEqual({
      chat_session_id: "session-1",
      parent_message_id: null,
      model_type: "default",
      prompt: "hello",
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false,
    });

    const headers = new Headers(completion.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    const powHeader = headers.get("x-ds-pow-response");
    expect(powHeader).not.toBeNull();
    expect(JSON.parse(Buffer.from(powHeader!, "base64").toString("utf8"))).toEqual({
      algorithm: "DeepSeekHashV1",
      challenge: POW_CHALLENGE.challenge,
      salt: POW_CHALLENGE.salt,
      answer: 71319,
      signature: POW_CHALLENGE.signature,
      target_path: "/api/v0/chat/completion",
    });

    expect(await new Response(stream).text()).toBe('data: {"v":"hello"}\n\n');
  });

  test("checkDevice adopts the rotated token", async () => {
    const calls = installFetch(
      jsonResponse(envelope({ rotate: true, data: { token: "rotated-token" } })),
    );

    await expect(makeClient().checkDevice("old-token", "device-1")).resolves.toEqual({
      token: "rotated-token",
      rotated: true,
    });

    const call = calls[0]!;
    expect(call.url).toBe(
      "https://chat.deepseek.com/api/v0/users/auth_token/check_device",
    );
    expect(JSON.parse(String(call.init.body))).toEqual({
      device_id: "device-1",
      device_model: "",
    });
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer old-token");
  });

  test("checkDevice keeps the old token when rotate is null", async () => {
    installFetch(jsonResponse(envelope({ rotate: null, data: null })));

    await expect(makeClient().checkDevice("old-token", "device-1")).resolves.toEqual({
      token: "old-token",
      rotated: false,
    });
  });

  test("deleteSession posts the session id", async () => {
    const calls = installFetch(jsonResponse(envelope(null)));

    await expect(makeClient().deleteSession("session-1")).resolves.toBeUndefined();

    const call = calls[0]!;
    expect(call.url).toBe("https://chat.deepseek.com/api/v0/chat_session/delete");
    expect(JSON.parse(String(call.init.body))).toEqual({
      chat_session_ids: ["session-1"],
    });
  });

  test("complete maps 40003 to TokenError", async () => {
    installFetch(
      jsonResponse(envelope({ challenge: POW_CHALLENGE })),
      jsonResponse(
        { code: 0, msg: "", data: { biz_code: 40003, biz_msg: "INVALID_TOKEN" } },
        401,
      ),
      jsonResponse(envelope({ rotate: null, data: null })),
    );

    const error = await capture(
      makeClient().complete({ chatSessionId: "session-1", prompt: "hello" }),
    );
    expect(error).toBeInstanceOf(TokenError);
  });

  test("maps 40301 and 40300 to PowError", async () => {
    for (const code of [40301, 40300]) {
      const failure = () =>
        jsonResponse(
          { code: 0, msg: "", data: { biz_code: code, biz_msg: "POW" } },
          403,
        );
      installFetch(failure(), failure());
      const error = await capture(makeClient().createSession());
      expect(error).toBeInstanceOf(PowError);
    }
  });

  test("maps other non-zero biz codes to DeepSeekApiError", async () => {
    installFetch(
      jsonResponse({ code: 0, msg: "", data: { biz_code: 12345, biz_msg: "boom" } }),
    );

    const error = await capture(makeClient().createSession());
    expect(error).toBeInstanceOf(DeepSeekApiError);
    expect((error as DeepSeekApiError).code).toBe(12345);
  });
});
