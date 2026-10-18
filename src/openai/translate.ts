import type {
  OpenAIAssistantMessage,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChunkDelta,
  OpenAIMessage,
  OpenAITool,
} from "./types";
import type { ParsedToolCall } from "../tools/parser";
import { renderToolPrompt } from "../tools/prompt";
import { renderToolResults } from "../tools/render";

const MODEL_ID = "deepseek-web";
const FULLWIDTH_BAR = String.fromCharCode(0xff5c);
const WORD_BOUNDARY = String.fromCharCode(0x2581);
const BAR = `(?:${FULLWIDTH_BAR}|\\|)`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A V3.1 marker such as `tool_calls_begin`, allowing underscores or U+2581. */
function markerPattern(words: string): string {
  const parts = words
    .split("_")
    .map((part) => escapeRegExp(part))
    .join(`(?:${WORD_BOUNDARY}|_)`);
  return `<\\s*${BAR}\\s*${parts}\\s*${BAR}\\s*>`;
}

const DSML_TOOL_CALLS_BLOCK = new RegExp(
  `<\\s*${BAR}\\s*DSML\\s*${BAR}\\s*tool_calls\\b[^>]*>[\\s\\S]*?(?:<\\/\\s*${BAR}\\s*DSML\\s*${BAR}\\s*tool_calls\\s*>|<\\/\\s*tool_calls\\s*>)`,
  "g",
);
const DSML_UNCLOSED_BLOCK = new RegExp(
  `<\\s*${BAR}\\s*DSML\\s*${BAR}\\s*tool_calls\\b[^>]*>[\\s\\S]*$`,
  "g",
);
const V31_TOOL_CALLS_BLOCK = new RegExp(
  `${markerPattern("tool_calls_begin")}[\\s\\S]*?${markerPattern("tool_calls_end")}`,
  "g",
);
const V31_UNCLOSED_BLOCK = new RegExp(
  `${markerPattern("tool_calls_begin")}[\\s\\S]*$`,
  "g",
);

/**
 * Builds the single DeepSeek `prompt` string for one OpenAI request.
 *
 * Order: system messages, the tool protocol block, then the transcript
 * (including rendered tool results and the synthetic continue turn appended by
 * `renderToolResults`). System messages are emitted once, ahead of the tool
 * block, because `renderToolResults` intentionally skips them.
 */
export function buildPrompt(messages: OpenAIMessage[], tools: OpenAITool[]): string {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "")
    .join("\n\n");
  const toolPrompt = tools.length > 0 ? renderToolPrompt(tools) : "";
  // Without tools there is no protocol block, so replaying history tool calls
  // as DSML would show the model a format it was not given.
  const transcriptMessages =
    tools.length > 0
      ? messages
      : messages.map((message) => {
          if (message.tool_calls === undefined) {
            return message;
          }
          const copy = { ...message };
          delete copy.tool_calls;
          return copy;
        });
  const transcript = renderToolResults(transcriptMessages);

  const blocks: string[] = [];
  if (system.length > 0) {
    blocks.push(system);
  }
  if (toolPrompt.length > 0) {
    blocks.push(toolPrompt);
  }
  if (transcript.length > 0) {
    blocks.push(transcript);
  }
  return blocks.join("\n\n");
}

/**
 * Removes recognized DSML and V3.1 tool-call wrappers from model text so the
 * markup is not duplicated into `delta.content`. Callers should only strip
 * when `parseToolCalls` produced at least one call; a block that failed to
 * parse is ordinary assistant text.
 */
export function stripToolMarkup(text: string): string {
  return text
    .replace(DSML_TOOL_CALLS_BLOCK, "")
    .replace(V31_TOOL_CALLS_BLOCK, "")
    .replace(DSML_UNCLOSED_BLOCK, "")
    .replace(V31_UNCLOSED_BLOCK, "")
    .trim();
}

/**
 * Renders a fully buffered DeepSeek answer as an OpenAI chat-completions SSE
 * body. One content/reasoning delta is emitted first, followed by one delta per
 * tool call, a finish chunk, and `[DONE]`.
 */
export function toOpenAIChunks(
  text: string,
  thinking: string,
  toolCalls: ParsedToolCall[],
): string {
  const id = `chatcmpl-${globalThis.crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunks: OpenAIChatCompletionChunk[] = [];

  const firstDelta: OpenAIChunkDelta = { role: "assistant" };
  if (thinking.length > 0) {
    firstDelta.reasoning_content = thinking;
  }
  if (text.length > 0) {
    firstDelta.content = text;
  }
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: MODEL_ID,
    choices: [{ index: 0, delta: firstDelta, finish_reason: null }],
  });

  for (const [index, call] of toolCalls.entries()) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }

  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
  });

  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** Renders a fully buffered DeepSeek answer as one non-streaming completion. */
export function toOpenAICompletion(
  text: string,
  thinking: string,
  toolCalls: ParsedToolCall[],
): OpenAIChatCompletion {
  const message: OpenAIAssistantMessage = {
    role: "assistant",
    content: text.length > 0 ? text : null,
  };
  if (thinking.length > 0) {
    message.reasoning_content = thinking;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }

  return {
    id: `chatcmpl-${globalThis.crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
  };
}
