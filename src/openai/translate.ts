import type { OpenAIMessage, OpenAITool } from "./types";
import { renderToolPrompt } from "../tools/prompt";
import { renderToolResults } from "../tools/render";

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
  `<\\s*(?:${BAR}\\s*)?DSML\\s*${BAR}\\s*tool_calls\\b[^>]*>[\\s\\S]*?(?:<\\/\\s*(?:${BAR}\\s*)?DSML\\s*${BAR}\\s*tool_calls\\s*>|<\\/\\s*tool_calls\\s*>)`,
  "g",
);
const DSML_UNCLOSED_BLOCK = new RegExp(
  `<\\s*(?:${BAR}\\s*)?DSML\\s*${BAR}\\s*tool_calls\\b[^>]*>[\\s\\S]*$`,
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
 * The web model otherwise tends to mirror the language of search results or
 * tool output. Keep the user's language authoritative without hardcoding a
 * locale; this also survives prompts that contain multiple languages.
 */
const RESPONSE_LANGUAGE_RULE = [
  "## Response language",
  "Write the final answer in the same natural language as the latest user message.",
  "Search results, web pages, tool output, and source quotations may be in another language; summarize or translate them into the user's language.",
  "Do not switch to Chinese, English, or another language merely because the retrieved sources are in that language.",
  "Keep code, commands, file paths, and identifiers unchanged.",
].join("\n");

/**
 * Builds the single DeepSeek `prompt` string for one OpenAI request.
 *
 * Order: system messages, the tool protocol block, then the transcript
 * (including rendered tool results and the synthetic continue turn appended by
 * `renderToolResults`). System messages are emitted once, ahead of the tool
 * block, because `renderToolResults` intentionally skips them.
 */
export interface BuildPromptOptions {
  /** Optional bounded handoff inserted before the transcript. */
  handoff?: string;
}

export function buildPrompt(
  messages: OpenAIMessage[],
  tools: OpenAITool[],
  options: BuildPromptOptions = {},
): string {
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
  if (options.handoff !== undefined && options.handoff.trim() !== "") {
    blocks.push(options.handoff);
  }
  if (transcript.length > 0) {
    blocks.push(RESPONSE_LANGUAGE_RULE);
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
