import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";
import type { CompletionClient, ServerConfig } from "../src/config";
import type { DeepSeekCompletionRequest } from "../src/deepseek/types";
import type { OpenAIChatCompletionChunk } from "../src/openai/types";

// DeepSeek markers use the fullwidth vertical line U+FF5C and markers may use
// the lower one eighth block U+2581. Build them programmatically so the
// literal tags never appear in test source.
const PIPE = String.fromCharCode(0xff5c);
const dsmlOpen = (body: string): string => `<${PIPE}DSML${PIPE}${body}>`;
const dsmlClose = (body: string): string => `</${PIPE}DSML${PIPE}${body}>`;

function dsmlReadCall(path: string): string {
  return [
    dsmlOpen("tool_calls"),
    dsmlOpen('invoke name="read"'),
    dsmlOpen('parameter name="path" string="true"') + path + dsmlClose(" parameter"),
    "</invoke>",
    "</tool_calls>",
  ].join("\n");
}

/** Wraps text in a DeepSeek completion SSE stream. */
function completionStream(text: string, thinking?: string): ReadableStream<Uint8Array> {
  const fragments: Array<{ type: "THINK" | "RESPONSE"; content: string }> = [];
  if (thinking !== undefined) {
    fragments.push({ type: "THINK", content: thinking });
  }
  fragments.push({ type: "RESPONSE", content: text });

  const payloads = [
    `data: ${JSON.stringify({ v: { response: { fragments } } })}\n\n`,
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
  ];
  return rawStream(payloads.join(""));
}

function rawStream(payload: string): ReadableStream<Uint8Array> {
  return new Response(payload, {
    headers: { "content-type": "text/event-stream" },
  }).body!;
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

interface FakeState {
  tokens: string[];
  requests: DeepSeekCompletionRequest[];
  created: number;
  deleted: string[];
}

interface Fake {
  client: CompletionClient;
  state: FakeState;
}

interface CompletionJson {
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null; tool_calls?: unknown[] };
    finish_reason: string;
  }>;
}

interface ErrorJson {
  error: { message: string; type: string; code: string };
}

interface ModelsJson {
  object: string;
  data: Array<{ id: string; object: string }>;
}

function createFake(options: {
  text?: string;
  thinking?: string;
  deleteError?: Error;
  stream?: ReadableStream<Uint8Array>;
}): Fake {
  const state: FakeState = {
    tokens: [],
    requests: [],
    created: 0,
    deleted: [],
  };

  const client: CompletionClient = {
    async createSession() {
      state.created += 1;
      return "session-1";
    },
    async deleteSession(id: string) {
      state.deleted.push(id);
      if (options.deleteError !== undefined) {
        throw options.deleteError;
      }
    },
    async complete(request: DeepSeekCompletionRequest) {
      state.requests.push(request);
      return options.stream ?? completionStream(options.text ?? "", options.thinking);
    },
  };

  return { client, state };
}

interface Running {
  port: number;
  stop(): void;
}

let servers: Running[] = [];

afterEach(() => {
  for (const server of servers) {
    server.stop();
  }
  servers = [];
});

function start(
  fake: Fake,
  config: Partial<ServerConfig> = {},
): { baseUrl: string; state: FakeState } {
  const server = startServer({
    port: 0,
    hostname: "127.0.0.1",
    deviceId: "device-test",
    maxPromptChars: 400000,
    createClient: (token) => {
      fake.state.tokens.push(token);
      return fake.client;
    },
    ...config,
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, state: fake.state };
}

function parseSse(body: string): OpenAIChatCompletionChunk[] {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => block.replace(/^data: /, ""))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as OpenAIChatCompletionChunk);
}

function postCompletion(
  baseUrl: string,
  body: unknown,
  token = "test-token",
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== "") {
    headers.authorization = `Bearer ${token}`;
  }
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("GET /v1/models", () => {
  test("lists the deepseek-web model", async () => {
    const fake = createFake({});
    const { baseUrl } = start(fake);

    const response = await fetch(`${baseUrl}/v1/models`);

    expect(response.status).toBe(200);
    const json: ModelsJson = await response.json();
    expect(json.object).toBe("list");
    expect(json.data.some((model) => model.id === "deepseek-web")).toBe(true);
  });
});

describe("POST /v1/chat/completions", () => {
  test("returns one JSON object for stream:false", async () => {
    const fake = createFake({ text: "Hello from DeepSeek" });
    const { baseUrl, state } = start(fake);

    const response = await postCompletion(baseUrl, {
      model: "deepseek-web",
      messages: [{ role: "user", content: "Say hello" }],
      stream: false,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const json: CompletionJson = await response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.model).toBe("deepseek-web");
    expect(json.choices).toHaveLength(1);
    expect(json.choices[0]?.index).toBe(0);
    expect(json.choices[0]?.message).toEqual({
      role: "assistant",
      content: "Hello from DeepSeek",
    });
    expect(json.choices[0]?.finish_reason).toBe("stop");

    expect(state.tokens).toEqual(["test-token"]);
    expect(state.created).toBe(1);
    expect(state.deleted).toEqual(["session-1"]);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.chatSessionId).toBe("session-1");
    expect(state.requests[0]?.prompt).toContain("User:\nSay hello");
    expect(state.requests[0]?.thinkingEnabled).toBe(false);
    expect(state.requests[0]?.searchEnabled).toBe(false);
  });

  test("accepts text content parts and replays them as one prompt block", async () => {
    const fake = createFake({ text: "OK" });
    const { baseUrl, state } = start(fake);

    const response = await postCompletion(baseUrl, {
      model: "deepseek-web",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "First block." },
            { type: "text", text: "Second block." },
          ],
        },
      ],
      stream: false,
    });

    expect(response.status).toBe(200);
    expect(state.requests[0]?.prompt).toContain(
      "User:\nFirst block.\nSecond block.",
    );
  });

  test("rejects content parts that are not text", async () => {
    const fake = createFake({ text: "never used" });
    const { baseUrl, state } = start(fake);

    const response = await postCompletion(baseUrl, {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://x" } }],
        },
      ],
      stream: false,
    });

    expect(response.status).toBe(400);
    const json: ErrorJson = await response.json();
    expect(json.error.code).toBe("invalid_request");
    expect(state.created).toBe(0);
  });

  test("forces thinking off when tools are present but honors search", async () => {
    const fake = createFake({ text: "OK" });
    const { baseUrl, state } = start(fake);

    const response = await postCompletion(baseUrl, {
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      thinking_enabled: true,
      search_enabled: true,
      tools: [{ type: "function", function: { name: "read" } }],
    });

    expect(response.status).toBe(200);
    expect(state.requests[0]?.thinkingEnabled).toBe(false);
    expect(state.requests[0]?.searchEnabled).toBe(true);
  });

  test("streams tool calls and keeps DSML out of content", async () => {
    const markup = `I will read it.\n${dsmlReadCall("/tmp/x")}`;
    const fake = createFake({ text: markup, thinking: "Need the file." });
    const { baseUrl, state } = start(fake);

    const response = await postCompletion(baseUrl, {
      model: "deepseek-web",
      messages: [{ role: "user", content: "Read /tmp/x" }],
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    const chunks = parseSse(body);
    const deltas = chunks.map((chunk) => chunk.choices[0]!.delta);

    const content = deltas
      .map((delta) => delta.content ?? "")
      .filter((value) => value.length > 0)
      .join("");
    expect(content).toBe("I will read it.");
    expect(content).not.toContain(PIPE);
    expect(
      deltas
        .map((delta) => delta.reasoning_content ?? "")
        .filter((value) => value.length > 0)
        .join(""),
    ).toBe("Need the file.");

    const toolDeltas = deltas.flatMap((delta) => delta.tool_calls ?? []);
    expect(toolDeltas).toHaveLength(1);
    expect(toolDeltas[0]?.type).toBe("function");
    expect(toolDeltas[0]?.function?.name).toBe("read");
    expect(JSON.parse(toolDeltas[0]?.function?.arguments ?? "{}")).toEqual({
      path: "/tmp/x",
    });

    const finishes = chunks
      .map((chunk) => chunk.choices[0]!.finish_reason)
      .filter((reason) => reason !== null);
    expect(finishes).toEqual(["tool_calls"]);
    expect(state.deleted).toEqual(["session-1"]);
  });

  test("returns DSML text as plain content and stop when tools is empty", async () => {
    const markup = `I will read it.\n${dsmlReadCall("/tmp/x")}`;
    const fake = createFake({ text: markup });
    const { baseUrl } = start(fake);

    const response = await postCompletion(baseUrl, {
      messages: [{ role: "user", content: "read /tmp/x" }],
      stream: false,
      tools: [],
    });

    expect(response.status).toBe(200);
    const json: CompletionJson = await response.json();
    expect(json.choices[0]?.finish_reason).toBe("stop");
    expect(json.choices[0]?.message.content).toBe(markup);
    expect(json.choices[0]?.message.tool_calls).toBeUndefined();
  });

  test("returns 502 when the upstream stream is empty", async () => {
    const fake = createFake({ stream: emptyStream() });
    const { baseUrl, state } = start(fake);

    const response = await postCompletion(baseUrl, {
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(response.status).toBe(502);
    const json: ErrorJson = await response.json();
    expect(json.error.code).toBe("deepseek_error");
    expect(state.deleted).toEqual(["session-1"]);
  });

  test("returns 502 when the upstream stream contains only malformed JSON", async () => {
    const fake = createFake({ stream: rawStream("data: {not-json}\n\n") });
    const { baseUrl, state } = start(fake);

    const response = await postCompletion(baseUrl, {
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(response.status).toBe(502);
    const json: ErrorJson = await response.json();
    expect(json.error.code).toBe("deepseek_error");
    expect(state.deleted).toEqual(["session-1"]);
  });

  test("returns partial text when the stream ends before FINISHED", async () => {
    const fake = createFake({ stream: rawStream('data: {"v":"partial"}\n\n') });
    const { baseUrl } = start(fake);

    const response = await postCompletion(baseUrl, {
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(response.status).toBe(200);
    const json: CompletionJson = await response.json();
    expect(json.choices[0]?.message.content).toBe("partial");
    expect(json.choices[0]?.finish_reason).toBe("stop");
  });

  test("returns 413 when the prompt exceeds DEEPSEEK_WEB_MAX_PROMPT_CHARS", async () => {
    const fake = createFake({ text: "never used" });
    const config = loadConfig({
      DEEPSEEK_WEB_MAX_PROMPT_CHARS: "20",
      DEEPSEEK_WEB_PORT: "0",
      DEEPSEEK_WEB_DEVICE_ID: "device-test",
    });
    const { baseUrl, state } = start(fake, config);

    const response = await postCompletion(baseUrl, {
      model: "deepseek-web",
      messages: [{ role: "user", content: "This prompt is definitely too long." }],
      stream: false,
    });

    expect(response.status).toBe(413);
    const json: ErrorJson = await response.json();
    expect(json.error.message.length).toBeGreaterThan(0);
    expect(state.created).toBe(0);
    expect(state.deleted).toEqual([]);
  });

  test("returns 401 without a bearer token", async () => {
    const fake = createFake({ text: "never used" });
    const { baseUrl, state } = start(fake);

    const response = await postCompletion(
      baseUrl,
      { messages: [{ role: "user", content: "hello" }] },
      "",
    );

    expect(response.status).toBe(401);
    const json: ErrorJson = await response.json();
    expect(json.error.message).toContain("bun run login");
    expect(state.created).toBe(0);
  });

  test("logs and ignores a failed session delete", async () => {
    const fake = createFake({
      text: "OK",
      deleteError: new Error("delete failed"),
    });
    const { baseUrl } = start(fake);

    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const response = await postCompletion(baseUrl, {
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      expect(response.status).toBe(200);
      const json: CompletionJson = await response.json();
      expect(json.choices).toHaveLength(1);
    } finally {
      console.error = originalError;
    }

    expect(logged).toHaveLength(1);
  });
});
