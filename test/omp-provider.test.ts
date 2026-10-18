import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { DeepSeekApiError } from "../src/deepseek/client";
import type { DeepSeekCompletionRequest } from "../src/deepseek/types";
import type { ParsedToolCall } from "../src/tools/parser";
import { collectCompletion } from "../omp-extension/collect";
import { emitBufferedCompletion } from "../omp-extension/events";
import type { EventSink, ModelIdentity } from "../omp-extension/events";
import { runDeepSeekTurn } from "../omp-extension/provider";
import type { ProviderDeps } from "../omp-extension/provider";
import type { PromptContext } from "../omp-extension/prompt";

const PIPE = String.fromCharCode(0xff5c);
const MODEL: ModelIdentity = {
  api: "deepseek-web",
  provider: "deepseek-web",
  id: "deepseek-web",
};

class FakeSink implements EventSink {
  readonly events: AssistantMessageEvent[] = [];
  ended: AssistantMessage | undefined;
  failure: unknown;

  push(event: AssistantMessageEvent): void {
    this.events.push(structuredClone(event));
  }

  end(message?: AssistantMessage): void {
    this.ended = message;
  }

  fail(error: unknown): void {
    this.failure = error;
  }
}

function sseBody(text: string, thinking = ""): ReadableStream<Uint8Array> {
  const fragments: Array<{ type: "THINK" | "RESPONSE"; content: string }> = [];
  if (thinking.length > 0) {
    fragments.push({ type: "THINK", content: thinking });
  }
  if (text.length > 0) {
    fragments.push({ type: "RESPONSE", content: text });
  }
  const body = `data: ${JSON.stringify({ v: { response: { fragments } } })}\n\ndata: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n`;
  return new Response(body).body!;
}

interface FakeClient {
  createSession(): Promise<string>;
  complete(
    request: DeepSeekCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
  deleteSession(sessionId: string): Promise<void>;
  uploadFile?(file: {
    data: Uint8Array;
    name: string;
    mimeType: string;
  }): Promise<string>;
  waitForFileReady?(id: string, signal?: AbortSignal): Promise<void>;
}

function providerDeps(options: {
  text?: string;
  thinking?: string;
  token?: string | null;
  completeError?: Error;
  onDelete?: (sessionId: string) => void;
  onComplete?: (request: DeepSeekCompletionRequest) => void;
  onUpload?: (file: { data: Uint8Array; name: string; mimeType: string }) => void;
  onWait?: (id: string) => void;
}): ProviderDeps {
  let uploadCount = 0;
  const client: FakeClient = {
    async createSession() {
      return "session-1";
    },
    async complete(request) {
      options.onComplete?.(request);
      if (options.completeError) {
        throw options.completeError;
      }
      return sseBody(options.text ?? "", options.thinking ?? "");
    },
    async deleteSession(sessionId) {
      options.onDelete?.(sessionId);
    },
    async uploadFile(file) {
      uploadCount += 1;
      options.onUpload?.(file);
      return `file-${uploadCount}`;
    },
    async waitForFileReady(id) {
      options.onWait?.(id);
    },
  };
  return {
    readToken: () => options.token === undefined ? "stored-token" : options.token,
    readDeviceId: () => "device-1",
    createClient: () => client,
    buildPrompt: () => "rendered prompt",
    emit: emitBufferedCompletion,
  };
}

async function run(
  deps: ProviderDeps,
  context: PromptContext = {
    messages: [{ role: "user", content: "hello" }],
  },
  signal?: AbortSignal,
): Promise<FakeSink> {
  const sink = new FakeSink();
  await runDeepSeekTurn(deps, MODEL, context, { signal }, sink);
  return sink;
}

describe("DeepSeek omp provider", () => {
  test("returns text and deletes the session", async () => {
    const deleted: string[] = [];
    const sink = await run(
      providerDeps({ text: "hello", onDelete: (id) => deleted.push(id) }),
    );

    expect(sink.failure).toBeUndefined();
    expect(sink.ended?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(sink.ended?.stopReason).toBe("stop");
    expect(deleted).toEqual(["session-1"]);
  });

  test("defaults thinking and search on", async () => {
    let request: DeepSeekCompletionRequest | undefined;
    await run(
      providerDeps({
        text: "hello",
        onComplete: (value) => {
          request = value;
        },
      }),
    );

    expect(request?.thinkingEnabled).toBe(true);
    expect(request?.searchEnabled).toBe(true);
  });

  test("uploads turn images and passes their ids to completion", async () => {
    let request: DeepSeekCompletionRequest | undefined;
    const uploads: Array<{
      data: Uint8Array;
      name: string;
      mimeType: string;
    }> = [];
    const waits: string[] = [];

    const sink = await run(
      providerDeps({
        text: "I can see it.",
        onComplete: (value) => {
          request = value;
        },
        onUpload: (file) => uploads.push(file),
        onWait: (id) => waits.push(id),
      }),
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", data: "AQID", mimeType: "image/png" },
            ],
          },
        ],
      },
    );

    expect(sink.failure).toBeUndefined();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.name).toBe("image-1.png");
    expect(uploads[0]?.mimeType).toBe("image/png");
    expect(Array.from(uploads[0]?.data ?? [])).toEqual([1, 2, 3]);
    expect(waits).toEqual(["file-1"]);
    expect(request?.refFileIds).toEqual(["file-1"]);
  });

  test("parses a tool call and strips its markup", async () => {
    const toolMarkup = `<${PIPE}DSML${PIPE}tool_calls>\n<${PIPE}DSML${PIPE}invoke name="read">\n<${PIPE}DSML${PIPE}parameter name="path" string="true">/tmp/file</${PIPE}DSML${PIPE}parameter>\n</invoke>\n</tool_calls>`;
    let request: DeepSeekCompletionRequest | undefined;
    const sink = await run(
      providerDeps({
        text: `Reading.\n${toolMarkup}`,
        onComplete: (value) => {
          request = value;
        },
      }),
      {
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "read", description: "Read", parameters: {} }],
      },
    );

    expect(sink.failure).toBeUndefined();
    expect(request?.thinkingEnabled).toBe(true);
    expect(request?.searchEnabled).toBe(true);
    expect(sink.ended?.stopReason).toBe("toolUse");
    expect(sink.ended?.content).toEqual([
      { type: "text", text: "Reading." },
      {
        type: "toolCall",
        id: expect.any(String),
        name: "read",
        arguments: { path: "/tmp/file" },
      },
    ] satisfies Array<{ type: string }>);
  });

  test("fails when no token is stored", async () => {
    const sink = await run(providerDeps({ token: null }));

    expect(sink.failure).toBeInstanceOf(Error);
    expect(String(sink.failure)).toContain("No DeepSeek token");
    expect(sink.ended).toBeUndefined();
  });

  test("deletes the session when the upstream fails", async () => {
    const deleted: string[] = [];
    const sink = await run(
      providerDeps({
        completeError: new Error("upstream down"),
        onDelete: (id) => deleted.push(id),
      }),
    );

    expect(sink.failure).toBeInstanceOf(Error);
    expect(deleted).toEqual(["session-1"]);
  });

  test("returns an error for an empty stream", async () => {
    const error = await collectCompletion(new Response("").body!, new AbortController().signal)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(DeepSeekApiError);
  });

  test("returns partial text when the stream breaks", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"partial"}]}}}\n\n`,
          ),
        );
        controller.close();
      },
    });

    const result = await collectCompletion(
      broken,
      new AbortController().signal,
    );

    expect(result.text).toBe("partial");
  });
});
