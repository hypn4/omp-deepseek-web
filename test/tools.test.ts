import { describe, expect, test } from "bun:test";
import { parseToolCalls } from "../src/tools/parser";
import { renderToolPrompt } from "../src/tools/prompt";
import { renderToolResults } from "../src/tools/render";
import type { OpenAIMessage, OpenAITool } from "../src/openai/types";

// DeepSeek markers use fullwidth vertical line U+FF5C and lower one eighth
// block U+2581 (SentencePiece word boundary). Build them programmatically so
// the literal tags never appear in source/tool arguments.
const PIPE = String.fromCharCode(0xff5c);
const BLOCK = String.fromCharCode(0x2581);

const dsmlOpen = (body: string): string => `<${PIPE}DSML${PIPE}${body}>`;
const dsmlClose = (body: string): string => `</${PIPE}DSML${PIPE}${body}>`;

const v31 = (words: string): string =>
  `<${PIPE}${words.split("_").join(BLOCK)}${PIPE}>`;

function dsmlCall(name: string, parameters: string[]): string[] {
  return [
    dsmlOpen("tool_calls"),
    dsmlOpen(`invoke name="${name}"`),
    ...parameters,
    `</invoke>`,
    `</tool_calls>`,
  ];
}

describe("parseToolCalls", () => {
  test("parses a DSML tool_calls/invoke/parameter block into one call", () => {
    const text = dsmlCall("read", [
      dsmlOpen('parameter name="path" string="true"') +
        "/tmp/x" +
        dsmlClose(" parameter"),
    ]).join("\n");

    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("read");
    expect(calls[0]?.arguments).toBe('{"path":"/tmp/x"}');
    expect(typeof calls[0]?.id).toBe("string");
    expect(calls[0]?.id.length).toBeGreaterThan(0);
  });

  test("parses a V3.1 block that uses end_of_query as the separator", () => {
    const text = [
      v31("tool_calls_begin"),
      v31("tool_call_begin"),
      "read",
      v31("end_of_query"),
      '{"path":"/tmp/x"}',
      v31("tool_call_end"),
      v31("tool_calls_end"),
    ].join("");

    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: expect.any(String),
      name: "read",
      arguments: '{"path":"/tmp/x"}',
    });
  });

  test("parses a V3.1 block that uses the canonical tool_sep marker", () => {
    const text = [
      v31("tool_calls_begin"),
      v31("tool_call_begin"),
      v31("tool_sep"),
      "bash",
      v31("tool_sep"),
      '{"command":"ls"}',
      v31("tool_sep"),
      v31("tool_call_end"),
      v31("tool_calls_end"),
    ].join("");

    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("bash");
    expect(calls[0]?.arguments).toBe('{"command":"ls"}');
  });

  test("parses multiple invokes in one DSML wrapper with distinct ids", () => {
    const text = [
      dsmlOpen("tool_calls"),
      dsmlOpen('invoke name="read"'),
      dsmlOpen('parameter name="path" string="true"') +
        "/tmp/a" +
        dsmlClose(" parameter"),
      `</invoke>`,
      dsmlOpen('invoke name="bash"'),
      dsmlOpen('parameter name="command" string="true"') +
        "ls -la" +
        dsmlClose(" parameter"),
      `</invoke>`,
      `</tool_calls>`,
    ].join("");

    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.name)).toEqual(["read", "bash"]);
    expect(calls[0]?.arguments).toBe('{"path":"/tmp/a"}');
    expect(calls[1]?.arguments).toBe('{"command":"ls -la"}');
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
  });

  test("parses string=false parameters as JSON and string=true as raw text", () => {
    const text = [
      dsmlOpen("tool_calls"),
      dsmlOpen('invoke name="write"'),
      dsmlOpen('parameter name="path" string="true"') +
        "/tmp/x" +
        dsmlClose(" parameter"),
      dsmlOpen('parameter name="options" string="false"') +
        '{"mode":"append","count":2}' +
        dsmlClose(" parameter"),
      `</invoke>`,
      `</tool_calls>`,
    ].join("");

    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.arguments)).toEqual({
      path: "/tmp/x",
      options: { mode: "append", count: 2 },
    });
  });

  test("returns no calls for plain assistant text", () => {
    expect(parseToolCalls("Just a normal answer.")).toEqual([]);
  });
});

describe("renderToolPrompt", () => {
  const tools: OpenAITool[] = [
    {
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
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run a command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
  ];

  test("includes every tool name and the exact DSML format instruction", () => {
    const prompt = renderToolPrompt(tools);

    expect(prompt).toContain("### read");
    expect(prompt).toContain("### bash");
    expect(prompt).toContain("Description: Read a file");
    expect(prompt).toContain(
      'Parameters: {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}',
    );
    expect(prompt).toContain(
      "Use ONLY the DSML tool protocol below. Do not use any built-in search or chat tools.",
    );
    expect(prompt).toContain("## Call format");
    expect(prompt).toContain(dsmlOpen("tool_calls"));
    expect(prompt).toContain(`<${PIPE}DSML${PIPE}invoke name="read">`);
    expect(prompt).toContain(
      `<${PIPE}DSML${PIPE}parameter name="path" string="true">/abs/path` +
        dsmlClose(" parameter"),
    );
    expect(prompt).toContain("Rules:");
    expect(prompt).toContain(
      '`string="true"` keeps the value as a raw string; `string="false"` parses JSON.',
    );
    expect(prompt).toContain("Do not wrap the call in prose.");
  });
});

describe("renderToolResults", () => {
  const toolCallMessage: OpenAIMessage = {
    role: "assistant",
    content: "I will read the file.",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: '{"path":"/tmp/x"}' },
      },
    ],
  };

  test("renders tool results with the originating tool name and id", () => {
    const text = renderToolResults([
      { role: "user", content: "Read /tmp/x" },
      toolCallMessage,
      { role: "tool", tool_call_id: "call_1", content: "hello" },
    ]);

    expect(text).toContain("User:\nRead /tmp/x");
    expect(text).toContain("Assistant:\nI will read the file.");
    expect(text).toContain(dsmlOpen('invoke name="read"'));
    expect(text).toContain("Tool result for read (call call_1):\nhello");
    expect(text).toContain(
      "Continue the task using the tool results above. Do not repeat a tool call unless it is necessary.",
    );
  });

  test("does not append the continuation prompt when the last message is not a tool result", () => {
    const text = renderToolResults([{ role: "user", content: "hi" }]);

    expect(text).not.toContain("Continue the task");
  });

  test("renders multiple tool results after one assistant tool-call message", () => {
    const text = renderToolResults([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"path":"/tmp/a"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "A" },
      { role: "tool", tool_call_id: "call_2", content: "B" },
    ]);

    expect(text).toContain("Tool result for read (call call_1):\nA");
    expect(text).toContain("Tool result for bash (call call_2):\nB");
  });
});
