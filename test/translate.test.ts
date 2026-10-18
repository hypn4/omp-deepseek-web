import { describe, expect, test } from "bun:test";
import {
  buildPrompt,
  stripToolMarkup,
  toOpenAIChunks,
  toOpenAICompletion,
} from "../src/openai/translate";
import type {
  OpenAIChatCompletionChunk,
  OpenAIMessage,
  OpenAITool,
} from "../src/openai/types";
import type { ParsedToolCall } from "../src/tools/parser";

// DeepSeek markers use the fullwidth vertical line U+FF5C. Build them
// programmatically so the literal tags never appear in test source.
const PIPE = String.fromCharCode(0xff5c);
const dsmlOpen = (body: string): string => `<${PIPE}DSML${PIPE}${body}>`;
const dsmlClose = (body: string): string => `</${PIPE}DSML${PIPE}${body}>`;

const READ_TOOL: OpenAITool = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

function parseChunks(body: string): OpenAIChatCompletionChunk[] {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => block.replace(/^data: /, ""))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as OpenAIChatCompletionChunk);
}

describe("buildPrompt", () => {
  test("orders system messages, the tool prompt, transcript, tool result, and continue turn", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Read /tmp/x" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: '{"path":"/tmp/x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", name: "read", content: "hello file" },
    ];

    const prompt = buildPrompt(messages, [READ_TOOL]);

    expect(prompt.startsWith("You are a coding agent.")).toBe(true);
    const systemIndex = prompt.indexOf("You are a coding agent.");
    const toolPromptIndex = prompt.indexOf("You are the model backend for a coding agent.");
    const toolSectionIndex = prompt.indexOf("### read");
    const userIndex = prompt.indexOf("User:\nRead /tmp/x");
    const assistantIndex = prompt.indexOf("Assistant:");
    const toolResultIndex = prompt.indexOf(
      "Tool result for read (call call-1):\nhello file",
    );
    const continueIndex = prompt.indexOf(
      "Continue the task using the tool results above.",
    );

    expect(systemIndex).toBeGreaterThan(-1);
    expect(toolPromptIndex).toBeGreaterThan(systemIndex);
    expect(toolSectionIndex).toBeGreaterThan(toolPromptIndex);
    expect(userIndex).toBeGreaterThan(toolSectionIndex);
    expect(assistantIndex).toBeGreaterThan(userIndex);
    expect(toolResultIndex).toBeGreaterThan(assistantIndex);
    expect(continueIndex).toBeGreaterThan(toolResultIndex);

    // System messages are rendered once, before the tool protocol block.
    expect(prompt.indexOf("You are a coding agent.", 1)).toBe(-1);
    // The assistant turn is replayed in DSML so the model sees its own format.
    expect(prompt).toContain(dsmlOpen('invoke name="read"'));
  });

  test("omits the tool prompt and DSML replay when the request has no tools", () => {
    const prompt = buildPrompt(
      [
        { role: "system", content: "Be concise." },
        { role: "user", content: "hi" },
      ],
      [],
    );

    expect(prompt).toBe("Be concise.\n\nUser:\nhi");
    expect(prompt).not.toContain("You are the model backend");
    expect(prompt).not.toContain(dsmlOpen("tool_calls"));
  });

  test("skips empty blocks and does not append a continue turn for a user turn", () => {
    const prompt = buildPrompt([{ role: "user", content: "hello" }], []);

    expect(prompt).toBe("User:\nhello");
    expect(prompt).not.toContain("Continue the task");
  });

  test("does not replay history tool calls as DSML when the request has no tools", () => {
    const prompt = buildPrompt(
      [
        {
          role: "assistant",
          content: "Reading.",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read", arguments: '{"path":"/tmp/x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", name: "read", content: "data" },
      ],
      [],
    );

    expect(prompt).toContain("Assistant:\nReading.");
    expect(prompt).toContain("Tool result for read (call call-1):\ndata");
    expect(prompt).not.toContain(dsmlOpen("tool_calls"));
  });
});

describe("toOpenAIChunks", () => {
  test("emits content, reasoning_content, and tool_calls with finish_reason tool_calls", () => {
    const calls: ParsedToolCall[] = [
      { id: "call-1", name: "read", arguments: '{"path":"/tmp/x"}' },
    ];

    const body = toOpenAIChunks("Done.", "Thinking...", calls);
    const chunks = parseChunks(body);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.model).toBe("deepseek-web");
      expect(chunk.choices).toHaveLength(1);
      expect(chunk.choices[0]?.index).toBe(0);
    }

    const deltas = chunks.map((chunk) => chunk.choices[0]!.delta);
    expect(
      deltas
        .map((delta) => delta.content ?? "")
        .filter((content) => content.length > 0)
        .join(""),
    ).toBe("Done.");
    expect(
      deltas
        .map((delta) => delta.reasoning_content ?? "")
        .filter((thinking) => thinking.length > 0)
        .join(""),
    ).toBe("Thinking...");

    const toolDeltas = deltas.flatMap((delta) => delta.tool_calls ?? []);
    expect(toolDeltas).toHaveLength(1);
    expect(toolDeltas[0]).toEqual({
      index: 0,
      id: "call-1",
      type: "function",
      function: { name: "read", arguments: '{"path":"/tmp/x"}' },
    });

    const finishes = chunks
      .map((chunk) => chunk.choices[0]!.finish_reason)
      .filter((reason) => reason !== null);
    expect(finishes).toEqual(["tool_calls"]);
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("finishes with stop when there are no tool calls", () => {
    const chunks = parseChunks(toOpenAIChunks("Hello", "", []));

    const finishes = chunks
      .map((chunk) => chunk.choices[0]!.finish_reason)
      .filter((reason) => reason !== null);
    expect(finishes).toEqual(["stop"]);
    expect(chunks.some((chunk) => (chunk.choices[0]!.delta.tool_calls ?? []).length > 0)).toBe(
      false,
    );
  });
});

describe("toOpenAICompletion", () => {
  test("builds a non-streaming completion with tool calls", () => {
    const completion = toOpenAICompletion("", "planning", [
      { id: "call-1", name: "read", arguments: '{"path":"/tmp/x"}' },
    ]);

    expect(completion.object).toBe("chat.completion");
    expect(completion.model).toBe("deepseek-web");
    expect(completion.choices[0]?.finish_reason).toBe("tool_calls");
    expect(completion.choices[0]?.message).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "planning",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: '{"path":"/tmp/x"}' },
        },
      ],
    });
  });

  test("builds a plain text completion", () => {
    const completion = toOpenAICompletion("Hi there", "", []);

    expect(completion.choices[0]?.message).toEqual({
      role: "assistant",
      content: "Hi there",
    });
    expect(completion.choices[0]?.finish_reason).toBe("stop");
  });
});

describe("stripToolMarkup", () => {
  test("removes a DSML tool_calls block and keeps the surrounding prose", () => {
    const markup = [
      dsmlOpen("tool_calls"),
      dsmlOpen('invoke name="read"'),
      dsmlOpen('parameter name="path" string="true"') +
        "/tmp/x" +
        dsmlClose(" parameter"),
      "</invoke>",
      "</tool_calls>",
    ].join("\n");

    expect(stripToolMarkup(`I will read it.\n${markup}\nDone.`)).toBe(
      "I will read it.\n\nDone.",
    );
    expect(stripToolMarkup(markup)).toBe("");
  });

  test("removes a V3.1 tool_calls block and an unclosed DSML block", () => {
    const WORD_BOUNDARY = String.fromCharCode(0x2581);
    const v31 = (words: string): string =>
      `<${PIPE}${words.split("_").join(WORD_BOUNDARY)}${PIPE}>`;
    const v31Markup = [
      v31("tool_calls_begin"),
      v31("tool_call_begin"),
      "read",
      v31("tool_sep"),
      '{"path":"/tmp/x"}',
      v31("tool_call_end"),
      v31("tool_calls_end"),
    ].join("");

    expect(stripToolMarkup(`Ok.${v31Markup}`)).toBe("Ok.");
    expect(
      stripToolMarkup(
        `Before\n${dsmlOpen("tool_calls")}\n${dsmlOpen('invoke name="read"')}`,
      ),
    ).toBe("Before");
  });
});
