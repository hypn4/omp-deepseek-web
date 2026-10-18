import type { OpenAIMessage, OpenAIToolCall } from "../openai/types";

const FULLWIDTH_BAR = String.fromCharCode(0xff5c);

const CONTINUE_PROMPT =
  "Continue the task using the tool results above. Do not repeat a tool call unless it is necessary.";

/** Keeps tool text from being mistaken for DSML markup when replayed. */
function escapeDsmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderToolCalls(calls: OpenAIToolCall[]): string {
  const lines = [`<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}tool_calls>`];

  for (const call of calls) {
    lines.push(
      `<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}invoke name="${call.function.name}">`,
    );

    const rawArguments = call.function.arguments.trim();
    let parameters: unknown;
    if (rawArguments.length > 0) {
      try {
        parameters = JSON.parse(rawArguments);
      } catch {
        parameters = undefined;
      }
    }

    if (
      typeof parameters === "object" &&
      parameters !== null &&
      !Array.isArray(parameters)
    ) {
      for (const [key, value] of Object.entries(parameters)) {
        if (typeof value === "string") {
          lines.push(
            `<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}parameter name="${key}" string="true">${escapeDsmlText(value)}</${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR} parameter>`,
          );
        } else {
          lines.push(
            `<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}parameter name="${key}" string="false">${escapeDsmlText(JSON.stringify(value))}</${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR} parameter>`,
          );
        }
      }
    } else if (rawArguments.length > 0) {
      // Keep unparseable arguments visible so the model can correct itself.
      lines.push(
        `<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}parameter name="arguments" string="true">${escapeDsmlText(rawArguments)}</${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR} parameter>`,
      );
    }

    lines.push(`</invoke>`);
  }

  lines.push(`</tool_calls>`);
  return lines.join("\n");
}

/**
 * Renders the conversation transcript sent to DeepSeek. System messages are
 * handled by the caller (they precede the tool protocol block), so they are
 * skipped here. Prior assistant tool calls are replayed as DSML so the model
 * sees its own output format.
 */
export function renderToolResults(messages: OpenAIMessage[]): string {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.tool_calls ?? []) {
      toolNames.set(call.id, call.function.name);
    }
  }

  const blocks: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break;
      case "user":
        blocks.push(`User:\n${message.content ?? ""}`);
        break;
      case "assistant": {
        let block = `Assistant:\n${message.content ?? ""}`;
        if (message.tool_calls && message.tool_calls.length > 0) {
          block += `\n${renderToolCalls(message.tool_calls)}`;
        }
        blocks.push(block);
        break;
      }
      case "tool": {
        const callId = message.tool_call_id ?? "";
        const name = toolNames.get(callId) ?? message.name ?? "tool";
        blocks.push(`Tool result for ${name} (call ${callId}):\n${message.content ?? ""}`);
        break;
      }
    }
  }

  if (messages.at(-1)?.role === "tool") {
    blocks.push(CONTINUE_PROMPT);
  }

  return blocks.join("\n\n");
}
