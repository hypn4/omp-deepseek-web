import type { OpenAITool } from "../openai/types";
import { TOOL_CALL_MARKER } from "./protocol";

const CALL_FORMAT = [
  TOOL_CALL_MARKER,
  '{"calls":[{"name":"read","arguments":{"path":"/abs/path"}}]}',
].join("\n");

/**
 * Renders the DeepSeek tool protocol prompt. The returned block is appended to
 * the system messages; callers omit it entirely when the request has no tools.
 */
export function renderToolPrompt(tools: OpenAITool[]): string {
  if (tools.length === 0) {
    return "";
  }

  const sections = tools.map((tool) => {
    const parameters = tool.function.parameters ?? {
      type: "object",
      properties: {},
    };
    const required = Array.isArray(parameters.required)
      ? parameters.required.filter(
          (name): name is string => typeof name === "string",
        )
      : [];
    return [
      `### ${tool.function.name}`,
      `Description: ${tool.function.description ?? ""}`,
      `Required: ${required.length > 0 ? required.join(", ") : "none"}`,
      `Parameters: ${JSON.stringify(parameters)}`,
    ].join("\n");
  });

  return [
    "You are the model backend for a coding agent.",
    "Use the JSON tool protocol only for the OMP tools listed below. Native DeepSeek web search may be used when the request enables it; do not use other built-in chat tools.",
    "",
    "## Tools",
    sections.join("\n\n"),
    "",
    "## Call format",
    CALL_FORMAT,
    "",
    "Rules:",
    `- Start the tool block with exactly one \`${TOOL_CALL_MARKER}\` marker.`,
    "- Immediately after the marker, emit one JSON object with a `calls` array.",
    "- `arguments` must be a JSON object, not a JSON-encoded string.",
    "- Emit one or more calls in the same block when needed.",
    "- Never use DSML, XML, `<parameter>`, or per-parameter tags.",
    "- Before emitting, check the `Required` line for the chosen tool and include every listed field.",
    "- `i` is optional intent metadata. It never replaces a required parameter such as a search `query` or a bash `command`.",
    "- When DeepThink is enabled, keep reasoning in the thinking block and emit the complete marker block in the final RESPONSE.",
    "- Do not wrap the call in prose.",
  ].join("\n");
}
