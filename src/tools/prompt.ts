import type { OpenAITool } from "../openai/types";

const FULLWIDTH_BAR = String.fromCharCode(0xff5c);

const CALL_FORMAT = [
  `<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}tool_calls>`,
  `<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}invoke name="read">`,
  `<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}parameter name="path" string="true">/abs/path</${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR} parameter>`,
  `</invoke>`,
  `</tool_calls>`,
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
    return [
      `### ${tool.function.name}`,
      `Description: ${tool.function.description ?? ""}`,
      `Parameters: ${JSON.stringify(parameters)}`,
    ].join("\n");
  });

  return [
    "You are the model backend for a coding agent.",
    "Use ONLY the DSML tool protocol below. Do not use any built-in search or chat tools.",
    "",
    "## Tools",
    sections.join("\n\n"),
    "",
    "## Call format",
    CALL_FORMAT,
    "",
    "Rules:",
    "- Emit one or more invoke blocks.",
    "- When DeepThink is enabled, keep reasoning in the thinking block and emit the complete tool_calls block in the final RESPONSE.",
    "- Use the exact opening tags shown above; do not omit the leading bar before DSML.",
    "- Every invoke must include all required parameters; never send an invoke with an empty body.",
    '- `string="true"` keeps the value as a raw string; `string="false"` parses JSON.',
    "- Do not wrap the call in prose.",
  ].join("\n");
}
