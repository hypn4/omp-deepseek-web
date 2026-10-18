/**
 * Parses DeepSeek tool-call markup into OpenAI-style tool calls.
 *
 * Two wire formats are supported:
 *
 * 1. DSML (`tool_calls` / `invoke` / `parameter` wrappers using the fullwidth
 *    vertical line U+FF5C around `DSML`).
 * 2. V3.1 markers (`tool_calls_begin` ... `tool_calls_end`), whose words are
 *    separated by U+2581 (the SentencePiece word boundary). The observed web
 *    model sometimes uses `end_of_query` where the canonical format uses
 *    `tool_sep`, so both separators are accepted.
 *
 * If a block cannot be parsed it is ignored: a normal assistant answer may
 * simply contain no tool call.
 */

export interface ParsedToolCall {
  id: string;
  name: string;
  /** JSON encoded arguments, ready for the OpenAI wire format. */
  arguments: string;
}

const FULLWIDTH_BAR = String.fromCharCode(0xff5c);
const WORD_BOUNDARY = String.fromCharCode(0x2581);

/** Either the canonical fullwidth bar or an ASCII pipe (degraded output). */
const BAR = `(?:${FULLWIDTH_BAR}|\\|)`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A V3.1 marker such as `<｜tool▁calls▁begin｜>`. */
function markerPattern(words: string): string {
  const parts = words
    .split("_")
    .map((part) => escapeRegExp(part))
    .join(`(?:${WORD_BOUNDARY}|_)`);
  return `<\\s*${BAR}\\s*${parts}\\s*${BAR}\\s*>`;
}

/** Opening DSML tag, capturing the attribute text (group 1). */
function dsmlOpenPattern(name: string): string {
  return `<\\s*${BAR}\\s*DSML\\s*${BAR}\\s*${name}\\b([^>]*)>`;
}

/** Closing DSML tag, with or without the `DSML` marker. */
function anyClosePattern(name: string): string {
  return `(?:</\\s*${BAR}\\s*DSML\\s*${BAR}\\s*${name}\\s*>|</\\s*${name}\\s*>)`;
}

interface TaggedBlock {
  /** Attribute text captured by `dsmlOpenPattern`. */
  attributes: string;
  bodyStart: number;
  bodyEnd: number;
}

/** Finds each open/close pair and returns the text between them. */
function findTaggedBlocks(
  text: string,
  openPattern: string,
  closePattern: string,
): TaggedBlock[] {
  const open = new RegExp(openPattern, "g");
  const close = new RegExp(closePattern, "g");
  const blocks: TaggedBlock[] = [];
  let cursor = 0;

  while (cursor <= text.length) {
    open.lastIndex = cursor;
    const openMatch = open.exec(text);
    if (!openMatch) {
      break;
    }
    const bodyStart = openMatch.index + openMatch[0].length;
    close.lastIndex = bodyStart;
    const closeMatch = close.exec(text);
    if (!closeMatch) {
      // Unterminated block: consume through the end of the buffered text.
      blocks.push({
        attributes: openMatch[1] ?? "",
        bodyStart,
        bodyEnd: text.length,
      });
      break;
    }
    blocks.push({
      attributes: openMatch[1] ?? "",
      bodyStart,
      bodyEnd: closeMatch.index,
    });
    cursor = closeMatch.index + closeMatch[0].length;
  }

  return blocks;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    attributes[match[1]!] = match[2] ?? match[3] ?? "";
  }
  return attributes;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseDsmlParameters(body: string): Record<string, unknown> | null {
  // Null prototype keeps a parameter literally named `__proto__` as data.
  const args = Object.create(null) as Record<string, unknown>;
  const parameters = findTaggedBlocks(
    body,
    dsmlOpenPattern("parameter"),
    anyClosePattern("parameter"),
  );

  for (const parameter of parameters) {
    const attributes = parseAttributes(parameter.attributes);
    const name = attributes.name;
    if (!name) {
      continue;
    }
    const raw = decodeEntities(body.slice(parameter.bodyStart, parameter.bodyEnd));
    if (attributes.string === "false") {
      try {
        args[name] = JSON.parse(raw.trim());
      } catch {
        // An unparseable block must not become a tool call (spec 8.3).
        return null;
      }
    } else {
      args[name] = raw;
    }
  }

  return args;
}

function parseDsmlCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const wrappers = findTaggedBlocks(
    text,
    dsmlOpenPattern("tool_calls"),
    anyClosePattern("tool_calls"),
  );

  for (const wrapper of wrappers) {
    const body = text.slice(wrapper.bodyStart, wrapper.bodyEnd);
    const invokes = findTaggedBlocks(
      body,
      dsmlOpenPattern("invoke"),
      anyClosePattern("invoke"),
    );

    for (const invoke of invokes) {
      const attributes = parseAttributes(invoke.attributes);
      const name = attributes.name;
      if (!name) {
        continue;
      }
      const invokeBody = body.slice(invoke.bodyStart, invoke.bodyEnd);
      const args = parseDsmlParameters(invokeBody);
      if (args === null) {
        continue;
      }
      calls.push({
        id: globalThis.crypto.randomUUID(),
        name,
        arguments: JSON.stringify(args),
      });
    }
  }

  return calls;
}

function parseArgumentsObject(raw: string): unknown | undefined {
  let value = raw.trim();
  if (!value) {
    return {};
  }
  if (value.startsWith("```")) {
    value = value
      .replace(/^```[A-Za-z]*\s*/, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseV31Call(body: string): ParsedToolCall | null {
  const separator = new RegExp(
    `(?:${markerPattern("tool_sep")}|${markerPattern("end_of_query")})`,
  );
  const parts = body
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  // Canonical V3.1 emits a literal `function` type segment before the first
  // separator. It carries no data, so drop it before locating the tool name;
  // a truncated block that contains only that segment is not a call.
  if (
    parts.length > 0 &&
    new RegExp(`^function(?:${WORD_BOUNDARY}|_|\\s)*$`).test(parts[0]!)
  ) {
    parts.shift();
  }
  if (parts.length === 0) {
    return null;
  }

  // The name segment is `<tool name>\n` followed by the (usually fenced)
  // JSON body; anything after the first separator is additional argument text.
  const nameSegment = parts[0]!;
  const newlineIndex = nameSegment.indexOf("\n");
  const name = (
    newlineIndex === -1 ? nameSegment : nameSegment.slice(0, newlineIndex)
  ).trim();
  if (!/^[A-Za-z_][\w.-]*$/.test(name)) {
    return null;
  }

  const argumentParts =
    newlineIndex === -1
      ? parts.slice(1)
      : [nameSegment.slice(newlineIndex + 1), ...parts.slice(1)];
  const args = parseArgumentsObject(argumentParts.join("\n"));
  if (args === undefined) {
    return null;
  }

  return {
    id: globalThis.crypto.randomUUID(),
    name,
    arguments: JSON.stringify(args),
  };
}

function parseV31Calls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const wrappers = findTaggedBlocks(
    text,
    markerPattern("tool_calls_begin"),
    markerPattern("tool_calls_end"),
  );

  for (const wrapper of wrappers) {
    const body = text.slice(wrapper.bodyStart, wrapper.bodyEnd);
    const blocks = findTaggedBlocks(
      body,
      markerPattern("tool_call_begin"),
      markerPattern("tool_call_end"),
    );

    for (const block of blocks) {
      const call = parseV31Call(body.slice(block.bodyStart, block.bodyEnd));
      if (call) {
        calls.push(call);
      }
    }
  }

  return calls;
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  return [...parseDsmlCalls(text), ...parseV31Calls(text)];
}
