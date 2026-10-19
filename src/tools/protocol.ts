/**
 * Tool-call wire protocol.
 *
 * The model emits one marker followed by one JSON object. There is deliberately
 * no closing tag: the parser reads a balanced JSON object, so malformed XML-like
 * closers cannot become part of paths or other string arguments.
 */
export const TOOL_CALL_MARKER = "@@OMP_TOOL_CALLS@@";

/** Bump when the wire protocol changes so native sessions are not mixed. */
export const TOOL_PROTOCOL_VERSION = 4;

export interface ProtocolToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function extractBalancedObject(text: string, start: number): string | null {
  if (text[start] !== "{") {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function parsePayload(payload: string): ProtocolToolCall[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const calls = (parsed as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) {
    return [];
  }
  const result: ProtocolToolCall[] = [];
  for (const entry of calls) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const name = (entry as { name?: unknown }).name;
    const args = (entry as { arguments?: unknown }).arguments;
    if (typeof name !== "string" || !/^[A-Za-z_][\w.-]*$/.test(name)) {
      continue;
    }
    const argumentsObject =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    result.push({ name, arguments: argumentsObject });
  }
  return result;
}

/** Parses every marker-delimited JSON call block in model text. */
export function parseProtocolCalls(text: string): ProtocolToolCall[] {
  const calls: ProtocolToolCall[] = [];
  let cursor = 0;
  while (true) {
    const marker = text.indexOf(TOOL_CALL_MARKER, cursor);
    if (marker === -1) {
      break;
    }
    const start = text.indexOf("{", marker + TOOL_CALL_MARKER.length);
    if (start === -1) {
      break;
    }
    const payload = extractBalancedObject(text, start);
    if (payload === null) {
      break;
    }
    calls.push(...parsePayload(payload));
    cursor = start + payload.length;
  }
  return calls;
}

/** Removes marker-delimited JSON blocks from assistant text. */
export function stripProtocolBlocks(text: string): string {
  let output = "";
  let cursor = 0;
  while (true) {
    const marker = text.indexOf(TOOL_CALL_MARKER, cursor);
    if (marker === -1) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, marker);
    const start = text.indexOf("{", marker + TOOL_CALL_MARKER.length);
    if (start === -1) {
      break;
    }
    const payload = extractBalancedObject(text, start);
    if (payload === null) {
      break;
    }
    cursor = start + payload.length;
  }
  return output.trim();
}
