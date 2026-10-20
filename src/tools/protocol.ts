/**
 * Tool-call wire protocol.
 *
 * The model emits a familiar DSML `tool_calls` opening tag followed by one JSON
 * object. There is no closing tag and no invoke/parameter markup: the parser
 * reads a balanced JSON object, so argument boundaries cannot be corrupted by
 * malformed XML-like closers.
 */
const FULLWIDTH_BAR = String.fromCharCode(0xff5c);

export const TOOL_CALL_MARKER = `<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}tool_calls>`;
/** Marker used briefly by 0.10.0/0.10.1; still stripped from old history. */
export const LEGACY_JSON_MARKER = "@@OMP_TOOL_CALLS@@";

/** Bump when the wire protocol changes so native sessions are not mixed. */
export const TOOL_PROTOCOL_VERSION = 5;

const MARKER_PATTERN = new RegExp(
  `(?:${TOOL_CALL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${LEGACY_JSON_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
  "giu",
);

const LOOSE_COMPACT_MARKER = new RegExp(
  `(?:<)?(?:/)?(?:${FULLWIDTH_BAR}|\\|)?DS[MO]L(?:${FULLWIDTH_BAR}|\\|)\\s*tool_calls\\s*>`,
  "giu",
);

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
  const rawCalls = Array.isArray(calls) ? calls : [parsed];
  const result: ProtocolToolCall[] = [];
  for (const entry of rawCalls) {
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

interface FoundBlock {
  start: number;
  end: number;
  calls: ProtocolToolCall[];
}

function findBlocks(text: string): FoundBlock[] {
  const blocks: FoundBlock[] = [];
  const markers: Array<{ index: number; length: number }> = [];
  for (const match of text.matchAll(MARKER_PATTERN)) {
    if (match.index !== undefined) {
      markers.push({ index: match.index, length: match[0].length });
    }
  }
  for (const match of text.matchAll(LOOSE_COMPACT_MARKER)) {
    if (match.index !== undefined) {
      markers.push({ index: match.index, length: match[0].length });
    }
  }
  markers.sort((left, right) => left.index - right.index);

  for (const marker of markers) {
    if (blocks.some((block) => marker.index >= block.start && marker.index < block.end)) {
      continue;
    }
    const start = text.indexOf("{", marker.index + marker.length);
    if (start === -1) {
      continue;
    }
    const payload = extractBalancedObject(text, start);
    if (payload === null) {
      continue;
    }
    const calls = parsePayload(payload);
    if (calls.length === 0) {
      // An old nested DSML block also starts with a tool_calls tag; leave it
      // for the legacy parser instead of stripping a parameter-body object.
      continue;
    }
    blocks.push({ start: marker.index, end: start + payload.length, calls });
  }
  return blocks;
}

/** Parses every compact marker-delimited JSON call block in model text. */
export function parseProtocolCalls(text: string): ProtocolToolCall[] {
  return findBlocks(text).flatMap((block) => block.calls);
}

/** Removes compact JSON tool blocks from assistant text. */
export function stripProtocolBlocks(text: string): string {
  const blocks = findBlocks(text);
  if (blocks.length === 0) {
    return text.trim();
  }
  let output = "";
  let cursor = 0;
  for (const block of blocks) {
    output += text.slice(cursor, block.start);
    cursor = block.end;
  }
  return (output + text.slice(cursor)).trim();
}
