import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { DeepSeekApiError } from "../src/deepseek/client";
import { collectCompletion } from "../src/deepseek/collect";
import type {
  DeepSeekCompletionRequest,
  DeepSeekContinueRequest,
  DeepSeekResumeRequest,
} from "../src/deepseek/types";
import { runDeepSeekTurn } from "../omp-extension/provider";
import type { ProviderDeps } from "../omp-extension/provider";
import type { PromptContext } from "../omp-extension/prompt";
import { PersistentPlanner } from "../omp-extension/conversation";
import { RequestGate } from "../src/deepseek/rate-limit";
import type { ConversationPlanner } from "../omp-extension/conversation";
import type { EventSink, ModelIdentity } from "../omp-extension/events";

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

interface ScriptedResponse {
  text: string;
  thinking?: string;
  messageId?: number;
  finished?: boolean;
  incompleteMessage?: string;
  finishReason?: string;
  hasPendingFragment?: boolean;
  errorMessage?: string;
  errorType?: string;
}

function sseBody(
  text: string,
  thinking = "",
  options: ScriptedResponse = { text },
): ReadableStream<Uint8Array> {
  const fragments: Array<Record<string, unknown>> = [];
  if (thinking.length > 0) {
    fragments.push({ type: "THINK", content: thinking });
  }
  if (text.length > 0) {
    fragments.push({ type: "RESPONSE", content: text });
  }
  if (options.finishReason !== undefined) {
    fragments.push({ type: "HINT", finish_reason: options.finishReason });
  }
  const hint =
    options.errorMessage === undefined
      ? ""
      : `event: hint\ndata: ${JSON.stringify({
          type: options.errorType ?? "error",
          content: options.errorMessage,
          finish_reason: options.finishReason,
        })}\n\n`;
  const response = {
    fragments,
    ...(options.incompleteMessage === undefined
      ? {}
      : { incomplete_message: options.incompleteMessage }),
    ...(options.hasPendingFragment === undefined
      ? {}
      : { has_pending_fragment: options.hasPendingFragment }),
  };
  const ready =
    options.messageId === undefined
      ? ""
      : `event: ready\ndata: ${JSON.stringify({ response_message_id: options.messageId })}\n\n`;
  const body =
    ready +
    `data: ${JSON.stringify({ v: { response } })}\n\n` +
    hint +
    (options.finished === false
      ? ""
      : 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n');
  return new Response(body).body!;
}

interface FakeClient {
  createSession(): Promise<string>;
  complete(
    request: DeepSeekCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
  continueCompletion(
    request: DeepSeekContinueRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
  resumeStream(
    request: DeepSeekResumeRequest,
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

function nextStream(
  queue: ScriptedResponse[] | undefined,
  fallback: ScriptedResponse,
  kind: string,
): ReadableStream<Uint8Array> {
  if (queue === undefined) {
    return sseBody(fallback.text, fallback.thinking ?? "", fallback);
  }
  const scripted = queue.shift();
  if (scripted === undefined) {
    throw new Error(`unexpected extra ${kind} request`);
  }
  return sseBody(scripted.text, scripted.thinking ?? "", scripted);
}

function providerDeps(options: {
  text?: string;
  thinking?: string;
  responses?: ScriptedResponse[];
  continueResponses?: ScriptedResponse[];
  resumeResponses?: ScriptedResponse[];
  token?: string | null;
  completeError?: Error;
  onDelete?: (sessionId: string) => void;
  onComplete?: (request: DeepSeekCompletionRequest) => void;
  onContinue?: (request: DeepSeekContinueRequest) => void;
  onResume?: (request: DeepSeekResumeRequest) => void;
  onUpload?: (file: { data: Uint8Array; name: string; mimeType: string }) => void;
  onWait?: (id: string) => void;
  onStatus?: (status: string | null) => void;
  planner?: ConversationPlanner;
  scopeKey?: string;
  requestGate?: RequestGate;
  taskDelayMs?: number;
  cwd?: string;
  buildHandoff?: (
    context: PromptContext,
    reason: string,
    cwd: string,
  ) => string | null;
  buildPrompt?: (context: PromptContext, handoff?: string) => string;
  buildIncrementalPrompt?: (context: PromptContext, startIndex: number) => string | null;
  sessionIds?: string[];
}): ProviderDeps {
  let uploadCount = 0;
  let sessionCount = 0;
  const responses = options.responses === undefined ? undefined : [...options.responses];
  const continueResponses =
    options.continueResponses === undefined ? undefined : [...options.continueResponses];
  const resumeResponses =
    options.resumeResponses === undefined ? undefined : [...options.resumeResponses];
  const client: FakeClient = {
    async createSession() {
      const id = options.sessionIds?.[sessionCount] ?? "session-1";
      sessionCount += 1;
      return id;
    },
    async complete(request) {
      options.onComplete?.(request);
      if (options.completeError) {
        throw options.completeError;
      }
      return nextStream(
        responses,
        { text: options.text ?? "", thinking: options.thinking ?? "" },
        "completion",
      );
    },
    async continueCompletion(request) {
      options.onContinue?.(request);
      return nextStream(continueResponses, { text: "" }, "continue");
    },
    async resumeStream(request) {
      options.onResume?.(request);
      return nextStream(resumeResponses, { text: "" }, "resume");
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
    readToken: () => (options.token === undefined ? "stored-token" : options.token),
    readDeviceId: () => "device-1",
    createClient: () => client,
    buildPrompt:
      options.buildPrompt ??
      (() => "rendered prompt"),
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
    ...(options.planner === undefined ? {} : { planner: options.planner }),
    ...(options.scopeKey === undefined ? {} : { scopeKey: options.scopeKey }),
    ...(options.requestGate === undefined ? {} : { requestGate: options.requestGate }),
    ...(options.taskDelayMs === undefined ? {} : { taskDelayMs: options.taskDelayMs }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.buildHandoff === undefined
      ? {}
      : { buildHandoff: options.buildHandoff }),
    ...(options.buildIncrementalPrompt === undefined
      ? {}
      : { buildIncrementalPrompt: options.buildIncrementalPrompt }),
  };
}

async function run(
  deps: ProviderDeps,
  context: PromptContext = {
    messages: [{ role: "user", content: "hello" }],
  },
  signal?: AbortSignal,
  turnOptions: { rateLimitRetries?: number; rateLimitDelayMs?: number } = {},
): Promise<FakeSink> {
  const sink = new FakeSink();
  await runDeepSeekTurn(
    deps,
    MODEL,
    context,
    { signal, ...turnOptions },
    sink,
  );
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

  test("keeps the same native chat across a tool result", async () => {
    const requests: DeepSeekCompletionRequest[] = [];
    const deleted: string[] = [];
    const planner = new PersistentPlanner({ path: null });
    const deps = providerDeps({
      responses: [
        { text: "calling read", messageId: 2 },
        { text: "done", messageId: 4 },
      ],
      planner,
      scopeKey: "scope-1",
      buildIncrementalPrompt: (_context, startIndex) => `DELTA:${startIndex}`,
      onComplete: (request) => requests.push(request),
      onDelete: (id) => deleted.push(id),
    });

    await run(deps, { messages: [{ role: "user", content: "read the file" }] });
    await run(deps, {
      messages: [
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "/tmp/file" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "contents" }],
          isError: false,
        },
      ],
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      chatSessionId: "session-1",
      parentMessageId: 2,
      prompt: "DELTA:2",
    });
    expect(deleted).toEqual([]);
    planner.close();
  });

  test("adds a handoff only when a fresh native chat is created", async () => {
    const prompts: string[] = [];
    const planner = new PersistentPlanner({ path: null });
    const deps = providerDeps({
      responses: [
        { text: "one", messageId: 2 },
        { text: "two", messageId: 4 },
      ],
      planner,
      scopeKey: "scope-1",
      buildIncrementalPrompt: (_context, startIndex) => `DELTA:${startIndex}`,
      buildHandoff: (_context, reason, cwd) => `HANDOFF:${reason}:${cwd}`,
      buildPrompt: (_context, handoff) =>
        handoff === undefined
          ? "rendered prompt"
          : `rendered prompt\n\n${handoff}`,
      cwd: "/tmp/project",
      onComplete: (request) => prompts.push(request.prompt),
    });

    await run(deps, { messages: [{ role: "user", content: "hello" }] });
    await run(deps, {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "one" }] },
        { role: "user", content: "again" },
      ],
    });

    expect(prompts[0]).toContain("HANDOFF:new:/tmp/project");
    expect(prompts[1]).toBe("DELTA:2");
  });

  test("reuses a persistent session and sends an incremental prompt", async () => {
    const completes: DeepSeekCompletionRequest[] = [];
    const deleted: string[] = [];
    const planner = new PersistentPlanner({ path: null });
    const deps = providerDeps({
      responses: [
        { text: "one", messageId: 2 },
        { text: "two", messageId: 4 },
      ],
      planner,
      scopeKey: "scope-1",
      buildIncrementalPrompt: (_context, startIndex) => `DELTA:${startIndex}`,
      onComplete: (request) => completes.push(request),
      onDelete: (id) => deleted.push(id),
    });

    await run(deps, { messages: [{ role: "user", content: "hello" }] });
    await run(deps, {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "one" }] },
        { role: "user", content: "again" },
      ],
    });

    expect(completes).toHaveLength(2);
    expect(completes[0]).toMatchObject({
      chatSessionId: "session-1",
      prompt: "rendered prompt",
    });
    expect(completes[0]?.parentMessageId).toBeUndefined();
    expect(completes[1]).toMatchObject({
      chatSessionId: "session-1",
      parentMessageId: 2,
      prompt: "DELTA:2",
    });
    expect(deleted).toEqual([]);
  });

  test("resets and deletes the old session when the context changed", async () => {
    const deleted: string[] = [];
    const completes: DeepSeekCompletionRequest[] = [];
    const planner = new PersistentPlanner({ path: null });
    const deps = providerDeps({
      responses: [
        { text: "one", messageId: 2 },
        { text: "two", messageId: 4 },
      ],
      sessionIds: ["session-1", "session-2"],
      planner,
      scopeKey: "scope-1",
      onComplete: (request) => completes.push(request),
      onDelete: (id) => deleted.push(id),
    });

    await run(deps, { messages: [{ role: "user", content: "hello" }] });
    await run(deps, {
      messages: [
        { role: "user", content: "edited" },
        { role: "assistant", content: [{ type: "text", text: "one" }] },
        { role: "user", content: "again" },
      ],
    });

    expect(completes[1]).toMatchObject({
      chatSessionId: "session-2",
      prompt: "rendered prompt",
    });
    expect(deleted).toEqual([]);
  });

  test("keeps a new persistent session only after a successful turn", async () => {
    const deleted: string[] = [];
    const planner = new PersistentPlanner({ path: null });
    const deps = providerDeps({
      responses: [{ text: "one", messageId: 2 }],
      planner,
      scopeKey: "scope-1",
      onDelete: (id) => deleted.push(id),
    });

    await run(deps, { messages: [{ role: "user", content: "hello" }] });
    expect(deleted).toEqual([]);
  });

  test("deletes the native chat evicted by the persistent entry cap", async () => {
    const deleted: string[] = [];
    const planner = new PersistentPlanner({ path: null, ttlMs: 0, maxEntries: 1 });
    const firstDeps = providerDeps({
      responses: [{ text: "one", messageId: 2 }],
      sessionIds: ["session-1", "session-2"],
      planner,
      scopeKey: "scope-1",
      onDelete: (id) => deleted.push(id),
    });
    const secondDeps = providerDeps({
      responses: [{ text: "two", messageId: 2 }],
      sessionIds: ["session-2"],
      planner,
      scopeKey: "scope-2",
      onDelete: (id) => deleted.push(id),
    });

    await run(firstDeps, { messages: [{ role: "user", content: "hello" }] });
    await run(secondDeps, { messages: [{ role: "user", content: "hello" }] });

    expect(deleted).toEqual(["session-1"]);
    planner.close();
  });

  test("preserves a reused chat when a later turn fails", async () => {
    const deleted: string[] = [];
    const planner = new PersistentPlanner({ path: null });
    const firstDeps = providerDeps({
      responses: [{ text: "one", messageId: 2 }],
      planner,
      scopeKey: "scope-1",
      buildIncrementalPrompt: (_context, startIndex) => `DELTA:${startIndex}`,
      onDelete: (id) => deleted.push(id),
    });
    const failingDeps = providerDeps({
      responses: [],
      planner,
      scopeKey: "scope-1",
      buildIncrementalPrompt: (_context, startIndex) => `DELTA:${startIndex}`,
      completeError: new Error("rate limited"),
      onDelete: (id) => deleted.push(id),
    });

    await run(firstDeps, { messages: [{ role: "user", content: "hello" }] });
    const sink = await run(failingDeps, {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "one" }] },
        { role: "user", content: "again" },
      ],
    });

    expect(sink.failure).toBeDefined();
    expect(deleted).toEqual([]);
    expect(
      planner.plan(
        "scope-1",
        { messages: [{ role: "user", content: "hello" }] },
        "full",
        () => null,
      ),
    ).toMatchObject({ prompt: "full", reused: false });
    planner.close();
  });

  test("preserves a completed chat when the response has no message id", async () => {
    const deleted: string[] = [];
    const planner = new PersistentPlanner({ path: null });
    const deps = providerDeps({
      responses: [{ text: "one" }],
      planner,
      scopeKey: "scope-1",
      onDelete: (id) => deleted.push(id),
    });

    const sink = await run(deps, { messages: [{ role: "user", content: "hello" }] });
    expect(sink.failure).toBeUndefined();
    expect(deleted).toEqual([]);
    planner.close();
  });

  test("deletes and invalidates a persistent session on failure", async () => {
    const deleted: string[] = [];
    const planner = new PersistentPlanner({ path: null });
    const deps = providerDeps({
      responses: [{ text: "one", messageId: 2 }],
      planner,
      scopeKey: "scope-1",
      completeError: new Error("upstream failed"),
      onDelete: (id) => deleted.push(id),
    });

    const sink = await run(deps, { messages: [{ role: "user", content: "hello" }] });
    expect(sink.failure).toBeDefined();
    expect(deleted).toEqual(["session-1"]);
  });

  test("uses native continue when incomplete_message is present", async () => {
    const continues: DeepSeekContinueRequest[] = [];
    const sink = await run(
      providerDeps({
        responses: [
          { text: "The answer is incomplete", messageId: 2, incompleteMessage: "cut" },
        ],
        continueResponses: [{ text: " and finishes.", messageId: 4 }],
        onContinue: (request) => continues.push(request),
      }),
    );

    expect(continues).toEqual([
      { chatSessionId: "session-1", messageId: 2, fallbackToResume: true },
    ]);
    expect(sink.failure).toBeUndefined();
    expect(sink.ended?.content).toEqual([
      { type: "text", text: "The answer is incomplete and finishes." },
    ]);
    expect(sink.ended?.stopReason).toBe("stop");
  });

  test("uses native continue for a length finish reason", async () => {
    const continues: DeepSeekContinueRequest[] = [];
    const sink = await run(
      providerDeps({
        responses: [{ text: "partial", messageId: 2, finishReason: "length" }],
        continueResponses: [{ text: " complete", messageId: 4 }],
        onContinue: (request) => continues.push(request),
      }),
    );

    expect(continues).toHaveLength(1);
    expect(sink.ended?.content).toEqual([{ type: "text", text: "partial complete" }]);
  });

  test("uses native resume when the stream did not finish", async () => {
    const resumes: DeepSeekResumeRequest[] = [];
    const sink = await run(
      providerDeps({
        responses: [{ text: "partial", messageId: 2, finished: false }],
        resumeResponses: [{ text: " rest", messageId: 2 }],
        onResume: (request) => resumes.push(request),
      }),
    );

    expect(resumes).toEqual([{ chatSessionId: "session-1", messageId: 2 }]);
    expect(sink.ended?.content).toEqual([{ type: "text", text: "partial rest" }]);
  });

  test("replaces partial text when native resume returns the full message", async () => {
    const sink = await run(
      providerDeps({
        responses: [{ text: "Hello", messageId: 2, finished: false }],
        resumeResponses: [{ text: "Hello world", messageId: 2 }],
      }),
    );

    const streamed = sink.events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event.type === "text_delta" ? event.delta : ""))
      .join("");
    expect(streamed).toBe("Hello world");
    expect(sink.ended?.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("does not infer truncation from text shape", async () => {
    const continues: DeepSeekContinueRequest[] = [];
    const sink = await run(
      providerDeps({
        responses: [{ text: "The answer is incomplete…", messageId: 2 }],
        onContinue: (request) => continues.push(request),
      }),
    );

    expect(continues).toHaveLength(0);
    expect(sink.ended?.content).toEqual([
      { type: "text", text: "The answer is incomplete…" },
    ]);
    expect(sink.ended?.stopReason).toBe("stop");
  });

  test("streams a long native continuation exactly once", async () => {
    const first = "x".repeat(120);
    const second = " finished.";
    const sink = await run(
      providerDeps({
        responses: [{ text: first, messageId: 2, incompleteMessage: "cut" }],
        continueResponses: [{ text: second, messageId: 4 }],
      }),
    );

    const streamed = sink.events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event.type === "text_delta" ? event.delta : ""))
      .join("");
    expect(streamed).toBe(first + second);
  });

  test("caps native recoveries and marks the answer as length-limited", async () => {
    const continues: DeepSeekContinueRequest[] = [];
    const sink = await run(
      providerDeps({
        responses: [{ text: "part one", messageId: 2, incompleteMessage: "cut" }],
        continueResponses: [
          { text: " part two", messageId: 4, incompleteMessage: "cut" },
          { text: " part three", messageId: 6, incompleteMessage: "cut" },
        ],
        onContinue: (request) => continues.push(request),
      }),
    );

    expect(continues).toHaveLength(2);
    expect(sink.ended?.content).toEqual([
      { type: "text", text: "part one part two part three" },
    ]);
    expect(sink.ended?.stopReason).toBe("length");
  });

  test("retries a rate-limit hint before succeeding", async () => {
    const requests: DeepSeekCompletionRequest[] = [];
    const sink = await run(
      providerDeps({
        responses: [
          {
            text: "",
            messageId: 2,
            finishReason: "rate_limit_reached",
            errorMessage: "Messages too frequent. Try again later.",
          },
          { text: "OK", messageId: 4 },
        ],
        onComplete: (request) => requests.push(request),
      }),
      undefined,
      undefined,
      { rateLimitDelayMs: 0, rateLimitRetries: 1 },
    );

    expect(requests).toHaveLength(2);
    expect(sink.failure).toBeUndefined();
    expect(sink.ended?.content).toEqual([{ type: "text", text: "OK" }]);
  });

  test("applies the task delay after a completed turn", async () => {
    const gate = new RequestGate({ minIntervalMs: 0 });
    const deps = providerDeps({
      text: "OK",
      requestGate: gate,
      taskDelayMs: 30,
    });
    await run(deps, { messages: [{ role: "user", content: "one" }] });
    const started = Date.now();
    await run(deps, { messages: [{ role: "user", content: "two" }] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  test("reports retry count and delay in the status line", async () => {
    const statuses: Array<string | null> = [];
    const sink = await run(
      providerDeps({
        responses: [
          {
            text: "",
            messageId: 2,
            finishReason: "rate_limit_reached",
            errorMessage: "Messages too frequent. Try again later.",
          },
          { text: "OK", messageId: 4 },
        ],
        onStatus: (status) => statuses.push(status),
      }),
      undefined,
      undefined,
      { rateLimitDelayMs: 0, rateLimitRetries: 1 },
    );

    expect(sink.failure).toBeUndefined();
    expect(statuses).toContain(
      "DeepSeek Web: rate limited, retry 1/1 in 0s…",
    );
  });

  test("includes the attempt count in the final rate-limit error", async () => {
    const sink = await run(
      providerDeps({
        responses: [
          {
            text: "",
            messageId: 2,
            finishReason: "rate_limit_reached",
            errorMessage: "Messages too frequent. Try again later.",
          },
          {
            text: "",
            messageId: 2,
            finishReason: "rate_limit_reached",
            errorMessage: "Messages too frequent. Try again later.",
          },
        ],
      }),
      undefined,
      undefined,
      { rateLimitDelayMs: 0, rateLimitRetries: 1 },
    );

    expect(String(sink.failure)).toContain("(after 2 attempts)");
  });

  test("aborts a rate-limit wait without sending another request", async () => {
    const requests: DeepSeekCompletionRequest[] = [];
    const controller = new AbortController();
    const deps = providerDeps({
      responses: [
        {
          text: "",
          messageId: 2,
          finishReason: "rate_limit_reached",
          errorMessage: "Messages too frequent. Try again later.",
        },
      ],
      onComplete: (request) => requests.push(request),
    });
    setTimeout(() => controller.abort(), 20);

    const sink = await run(deps, undefined, controller.signal, {
      rateLimitDelayMs: 1_000,
      rateLimitRetries: 5,
    });

    expect(requests).toHaveLength(1);
    expect(sink.failure).toBeInstanceOf(Error);
    expect((sink.failure as Error).name).toBe("AbortError");
  });

  test("does not retry a rate-limit hint after visible content", async () => {
    const requests: DeepSeekCompletionRequest[] = [];
    const sink = await run(
      providerDeps({
        responses: [
          {
            text: "partial",
            messageId: 2,
            finishReason: "rate_limit_reached",
            errorMessage: "Messages too frequent. Try again later.",
          },
        ],
        onComplete: (request) => requests.push(request),
      }),
      undefined,
      undefined,
      { rateLimitDelayMs: 0, rateLimitRetries: 2 },
    );

    expect(requests).toHaveLength(1);
    expect(sink.failure).toBeInstanceOf(DeepSeekApiError);
    expect(String(sink.failure)).toContain("Messages too frequent");
  });

  test("surfaces a native context-length hint as an error", async () => {
    const sink = await run(
      providerDeps({
        responses: [
          {
            text: "",
            messageId: 2,
            finishReason: "context_length_exceeded",
            errorMessage: "Length limit reached. Please start a new chat.",
          },
        ],
      }),
    );

    expect(sink.failure).toBeInstanceOf(DeepSeekApiError);
    expect(String(sink.failure)).toContain("Length limit reached");
  });

  test("fails when an incomplete answer has no message id", async () => {
    const sink = await run(
      providerDeps({
        responses: [{ text: "partial", incompleteMessage: "cut" }],
      }),
    );

    expect(sink.failure).toBeInstanceOf(DeepSeekApiError);
    expect(String(sink.failure)).toContain("message id");
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
    const error = await collectCompletion(
      new Response("").body!,
      new AbortController().signal,
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(DeepSeekApiError);
  });

  test("returns partial text when the stream breaks", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"partial"}]}}}\n\n',
          ),
        );
        controller.close();
      },
    });

    const result = await collectCompletion(broken, new AbortController().signal);

    expect(result.text).toBe("partial");
    expect(result.finished).toBe(false);
  });

  test("reports incremental progress before the stream finishes", async () => {
    const chunks = [
      'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"hel"}]}}}\n\n',
      'data: {"v":"lo"}\n\ndata: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ];
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    const progress: string[] = [];

    const result = await collectCompletion(
      stream,
      new AbortController().signal,
      (snapshot) => progress.push(snapshot.text),
    );

    expect(result.text).toBe("hello");
    expect(progress).toContain("hel");
    expect(progress.at(-1)).toBe("hello");
  });
});
