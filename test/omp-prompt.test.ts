import { describe, expect, test } from "bun:test";
import {
  buildOmpIncrementalPrompt,
  buildOmpPrompt,
  collectTurnImages,
} from "../omp-extension/prompt";

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image"; data: string; mimeType: string };
type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type PromptMessage =
  | { role: "user"; content: string | Array<TextPart | ImagePart> }
  | { role: "developer"; content: string | Array<TextPart | ImagePart> }
  | {
      role: "assistant";
      content: Array<TextPart | { type: "thinking"; thinking: string } | ToolCall>;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: Array<TextPart | ImagePart>;
      isError: boolean;
    };

interface PromptTool {
  name: string;
  description: string;
  parameters: unknown;
}

const READ_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};

const READ_TOOL: PromptTool = {
  name: "read",
  description: "Read a file",
  parameters: { ark: "schema" },
};

function prompt(
  messages: PromptMessage[],
  tools: PromptTool[] = [],
  systemPrompt?: string[],
): string {
  return buildOmpPrompt(
    { systemPrompt, messages, tools },
    (tool) => (tool.name === "read" ? READ_SCHEMA : { type: "object" }),
  );
}

describe("omp prompt adapter", () => {
  test("places the system prompt before the transcript", () => {
    const result = prompt(
      [{ role: "user", content: "hello" }],
      [],
      ["You are a coding agent.", "Be concise."],
    );

    expect(result).toContain("You are a coding agent.");
    expect(result).toContain("Be concise.");
    expect(result).toContain("User:\nhello");
    expect(result.indexOf("You are a coding agent.")).toBeLessThan(
      result.indexOf("User:\nhello"),
    );
  });

  test("maps developer messages to the system block", () => {
    const result = prompt([
      { role: "developer", content: "developer instruction" },
      { role: "user", content: "hello" },
    ]);

    expect(result).toContain("developer instruction");
    expect(result.indexOf("developer instruction")).toBeLessThan(
      result.indexOf("User:\nhello"),
    );
  });

  test("renders tool definitions and a prior tool call", () => {
    const result = prompt(
      [
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading." },
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
          content: [{ type: "text", text: "file contents" }],
          isError: false,
        },
      ],
      [READ_TOOL],
    );

    expect(result).toContain("### read");
    expect(result).toContain('"path"');
    expect(result).toContain("Assistant:\nReading.");
    expect(result).toContain("Tool result for read (call call-1):\nfile contents");
    expect(result).toContain("Continue the task using the tool results above.");
  });

  test("joins text parts and renders image placeholders", () => {
    expect(
      prompt([
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toContain("User:\nfirst\nsecond");

    expect(
      prompt([
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        },
      ]),
    ).toContain("User:\ndescribe\n[image attached: image/png]");
  });

  test("renders arbitrary host tools without a hardcoded allowlist", () => {
    const result = prompt(
      [{ role: "user", content: "use the custom tool" }],
      [
        {
          name: "custom_tool_7",
          description: "A dynamically supplied tool",
          parameters: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
    );

    expect(result).toContain("### custom_tool_7");
    expect(result).toContain("A dynamically supplied tool");
    expect(result).not.toContain("web_search");
  });

  test("builds a delta prompt without repeating the system/tool block", () => {
    const result = buildOmpIncrementalPrompt(
      {
        systemPrompt: ["system"],
        tools: [READ_TOOL],
        messages: [
          { role: "user", content: "old" },
          { role: "assistant", content: [{ type: "text", text: "old answer" }] },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "contents" }],
            isError: false,
          },
        ],
      },
      2,
    );
    expect(result).toContain("Tool result for read (call call-1):\ncontents");
    expect(result).toContain("Continue the task using the tool results above.");
    expect(result).not.toContain("system");
    expect(result).not.toContain("old answer");
    expect(result).not.toContain("### read");
  });

  test("refuses a delta containing a developer message", () => {
    expect(
      buildOmpIncrementalPrompt(
        {
          messages: [
            { role: "user", content: "old" },
            { role: "developer", content: "new instruction" },
          ],
        },
        1,
      ),
    ).toBeNull();
  });

  test("collects images from the latest turn only", () => {
    const images = collectTurnImages({
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "OLD", mimeType: "image/png" }],
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "new" },
            { type: "image", data: "NEW", mimeType: "image/jpeg" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "image", data: "TOOL", mimeType: "image/webp" }],
          isError: false,
        },
      ],
    });

    expect(images).toEqual([
      { data: "NEW", mimeType: "image/jpeg" },
      { data: "TOOL", mimeType: "image/webp" },
    ]);
  });
});
