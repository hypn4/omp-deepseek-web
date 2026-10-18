export interface DeepSeekFragment {
  type: "THINK" | "RESPONSE";
  content: string;
}

export interface DeepSeekSseResult {
  text: string;
  thinking: string;
  finished: boolean;
  /** Upstream response message id, when the ready event supplied one. */
  messageId?: number;
  /** Native `incomplete_message` marker; presence means the answer was cut off. */
  incompleteMessage?: string;
  /** Native `has_pending_fragment` flag. */
  hasPendingFragment?: boolean;
  /** Native finish reason from a hint fragment or a top-level hint. */
  finishReason?: string;
  /** Error text from an `event: hint` payload. */
  errorMessage?: string;
  /** Hint type, normally `error`. */
  errorType?: string;
  /** Current web-search phase reported by the web API, when present. */
  searchStatus?: string;
}

type JsonRecord = Record<string, unknown>;

/**
 * Path segments that would traverse or mutate object prototypes. Patch paths
 * are untrusted stream input, so these are rejected wholesale.
 */
const UNSAFE_SEGMENTS: Record<string, true> = {
  ["__proto__"]: true,
  prototype: true,
  constructor: true,
};

function safeSegments(path: string): string[] | null {
  const segments = path.split("/");
  for (const segment of segments) {
    if (UNSAFE_SEGMENTS[segment] === true) {
      return null;
    }
  }
  return segments;
}

function readSegment(container: unknown, segment: string): unknown {
  if (Array.isArray(container)) {
    const index = segment === "-1" ? container.length - 1 : Number(segment);
    return Number.isInteger(index) ? container[index] : undefined;
  }
  if (typeof container === "object" && container !== null) {
    return (container as JsonRecord)[segment];
  }
  return undefined;
}

function writeSegment(container: unknown, segment: string, value: unknown): void {
  if (Array.isArray(container)) {
    if (segment === "-1") {
      if (container.length === 0) {
        container.push(value);
      } else {
        container[container.length - 1] = value;
      }
      return;
    }
    const index = Number(segment);
    if (Number.isInteger(index) && index >= 0) {
      container[index] = value;
    }
    return;
  }
  if (typeof container === "object" && container !== null) {
    (container as JsonRecord)[segment] = value;
  }
}

/**
 * Parses the DeepSeek web completion stream.
 *
 * The stream mixes named SSE events (`ready`, `title`, `close`) with patch
 * payloads that address a JSON tree rooted at `response`:
 *
 * - `{"v": {"response": {...}}}` seeds the response object.
 * - `{"p": "...", "o": "APPEND" | "SET", "v": ...}` mutates one path.
 * - `{"p": "response", "o": "BATCH", "v": [{...}]}` applies nested patches.
 * - `{"v": "..."}` appends to the last fragment's content.
 *
 * `feed` accepts arbitrarily chunked text; `result` returns the joined
 * RESPONSE and THINK text plus whether the stream signalled completion.
 */
export class DeepSeekSseParser {
  #buffer = "";
  #finished = false;
  #eventName = "";
  #hint: JsonRecord | null = null;
  #ready: JsonRecord | null = null;
  #state: JsonRecord = Object.create(null) as JsonRecord;

  feed(text: string): void {
    this.#buffer += text;

    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  result(): DeepSeekSseResult {
    // A stream may end without a trailing newline; drain whatever is left.
    if (this.#buffer !== "") {
      const line = this.#buffer;
      this.#buffer = "";
      this.#handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }

    const text: string[] = [];
    const thinking: string[] = [];
    const fragments = this.#get("response/fragments");
    const response = this.#get("response");
    let searchStatus: string | undefined;
    let incompleteMessage: string | undefined;
    let hasPendingFragment: boolean | undefined;
    let finishReason: string | undefined;
    let hasSearchFragment = false;
    if (typeof response === "object" && response !== null) {
      const rawIncomplete = (response as JsonRecord).incomplete_message;
      if (typeof rawIncomplete === "string") {
        incompleteMessage = rawIncomplete;
      }
      const rawPending = (response as JsonRecord).has_pending_fragment;
      if (typeof rawPending === "boolean") {
        hasPendingFragment = rawPending;
      }
      const rawStatus = (response as JsonRecord).search_status;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        searchStatus = rawStatus;
      } else if (typeof rawStatus === "object" && rawStatus !== null) {
        const nested = (rawStatus as JsonRecord).status;
        if (typeof nested === "string" && nested !== "") {
          searchStatus = nested;
        }
      }
    }

    if (Array.isArray(fragments)) {
      for (const fragment of fragments) {
        if (typeof fragment !== "object" || fragment === null) {
          continue;
        }
        const entry = fragment as JsonRecord;
        if (typeof entry.finish_reason === "string" && entry.finish_reason !== "") {
          finishReason = entry.finish_reason;
        }
        if (
          typeof entry.content !== "string" &&
          (entry.type === "TOOL_SEARCH" || entry.type === "TOOL_OPEN")
        ) {
          hasSearchFragment = true;
        }
        if (typeof entry.content !== "string") {
          continue;
        }
        if (entry.type === "THINK") {
          thinking.push(entry.content);
        } else if (entry.type === "RESPONSE") {
          text.push(entry.content);
        }
      }
    }

    if (hasSearchFragment) {
      searchStatus = text.length > 0 ? "composing" : "searching";
    }

    const rawTopFinish = this.#get("finish_reason");
    if (
      finishReason === undefined &&
      typeof rawTopFinish === "string" &&
      rawTopFinish !== ""
    ) {
      finishReason = rawTopFinish;
    }
    const hint = this.#hint;
    const hintFinish = hint?.finish_reason;
    if (
      finishReason === undefined &&
      typeof hintFinish === "string" &&
      hintFinish !== ""
    ) {
      finishReason = hintFinish;
    }
    const errorType = hint?.type === "error" ? "error" : undefined;
    const rawHintContent = hint?.content;
    const errorMessage =
      errorType === "error" && typeof rawHintContent === "string"
        ? rawHintContent
        : undefined;

    const rawMessageId =
      this.#ready?.response_message_id ??
      this.#get("response/message_id") ??
      this.#get("response_message_id");
    const messageId =
      typeof rawMessageId === "number" && Number.isFinite(rawMessageId)
        ? rawMessageId
        : undefined;

    return {
      text: text.join(""),
      thinking: thinking.join(""),
      finished: this.#finished,
      ...(messageId === undefined ? {} : { messageId }),
      ...(incompleteMessage === undefined ? {} : { incompleteMessage }),
      ...(hasPendingFragment === undefined ? {} : { hasPendingFragment }),
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
      ...(errorType === undefined ? {} : { errorType }),
      ...(searchStatus === undefined ? {} : { searchStatus }),
    };
  }

  #handleLine(line: string): void {
    if (line === "") {
      // An SSE dispatch ends at a blank line; the next data line is global
      // again. Without this reset a `title` event could leak into a later
      // patch or inherit a previous event's named scope.
      this.#eventName = "";
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    if (line.startsWith("event:")) {
      this.#eventName = line.slice("event:".length).trim();
      if (this.#eventName === "close") {
        this.#finished = true;
      }
      return;
    }

    if (!line.startsWith("data:")) {
      return;
    }

    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") {
      return;
    }

    let patch: unknown;
    try {
      patch = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return;
    }

    if (this.#eventName !== "") {
      if (this.#eventName === "hint") {
        this.#hint = patch as JsonRecord;
      } else if (this.#eventName === "ready") {
        this.#ready = patch as JsonRecord;
        // Some captures seed the response in the ready event instead of a
        // standalone patch. Preserve that shape without treating metadata as
        // response state.
        if ("v" in patch || "p" in patch || "o" in patch) {
          this.#applyPatch(patch as JsonRecord, "");
        }
      }
      // `title`, `update_session`, `auto_tts_capability`, and unknown named
      // events are metadata, not response patches. Never merge their fields
      // into the response state. DeepSeek sends one data line per named event;
      // clearing the scope here also tolerates streams without blank lines.
      this.#eventName = "";
      return;
    }

    this.#applyPatch(patch as JsonRecord, "");

    const response = this.#state.response;
    if (
      typeof response === "object" &&
      response !== null &&
      (response as JsonRecord).status === "FINISHED"
    ) {
      this.#finished = true;
    }
  }

  #applyPatch(patch: JsonRecord, basePath: string): void {
    const rawPath = typeof patch.p === "string" ? patch.p : "";
    const op = typeof patch.o === "string" ? patch.o : "";
    const value = patch.v;

    if (rawPath === "" && op === "" && !("v" in patch)) {
      // Named events such as `ready` carry a plain object, not a patch.
      this.#applyUnpathed(patch);
      return;
    }

    if (rawPath === "") {
      this.#applyUnpathed(value);
      return;
    }

    // Nested BATCH patches may be relative to the batch path or absolute.
    const path =
      basePath !== "" && rawPath !== basePath && !rawPath.startsWith(`${basePath}/`)
        ? `${basePath}/${rawPath}`
        : rawPath;

    if (op === "BATCH") {
      if (!Array.isArray(value)) {
        return;
      }
      for (const nested of value) {
        if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
          this.#applyPatch(nested as JsonRecord, path);
        }
      }
      return;
    }

    if (op === "") {
      if (typeof value === "string" || Array.isArray(value)) {
        this.#append(path, value);
      } else {
        this.#setAtPath(path, value);
      }
      return;
    }

    if (op === "APPEND") {
      this.#append(path, value);
      return;
    }

    if (op === "SET") {
      this.#setAtPath(path, value);
    }
  }

  #applyUnpathed(value: unknown): void {
    if (typeof value === "string") {
      this.#appendToLastFragment(value);
      return;
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }

    for (const [key, entry] of Object.entries(value as JsonRecord)) {
      if (UNSAFE_SEGMENTS[key] === true) {
        continue;
      }
      this.#state[key] = entry;
    }
  }

  #append(path: string, value: unknown): void {
    const current = this.#get(path);

    if (typeof current === "string") {
      this.#setAtPath(path, current + (typeof value === "string" ? value : String(value)));
      return;
    }

    if (Array.isArray(current)) {
      if (Array.isArray(value)) {
        current.push(...value);
      } else {
        current.push(value);
      }
      return;
    }

    if (typeof current === "object" && current !== null) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        Object.assign(current, value);
      }
      return;
    }

    if (current === undefined) {
      if (path.endsWith("/-1/content") && this.#appendToNewFragment(path, value)) {
        return;
      }
      this.#setAtPath(path, value);
    }
  }

  /** Appends a bare `{"v": "..."}` payload to the last fragment's content. */
  #appendToLastFragment(text: string): void {
    const fragments = this.#ensureArray("response/fragments");
    const last = fragments[fragments.length - 1];

    if (typeof last === "object" && last !== null && !Array.isArray(last)) {
      const fragment = last as JsonRecord;
      fragment.content = typeof fragment.content === "string" ? fragment.content + text : text;
      return;
    }

    fragments.push({ type: "RESPONSE", content: text });
  }

  /**
   * Handles an APPEND to `response/fragments/-1/content` before any fragment
   * exists: target the last fragment if present, otherwise create one.
   */
  #appendToNewFragment(path: string, value: unknown): boolean {
    const fragmentPath = path.slice(0, -"/content".length);
    const last = this.#get(fragmentPath);

    if (typeof last === "object" && last !== null && !Array.isArray(last)) {
      (last as JsonRecord).content = typeof value === "string" ? value : String(value);
      return true;
    }

    const fragmentsPath = fragmentPath.slice(0, -"/-1".length);
    if (!fragmentsPath.endsWith("/fragments")) {
      return false;
    }

    this.#ensureArray(fragmentsPath).push({
      type: "RESPONSE",
      content: typeof value === "string" ? value : String(value),
    });
    return true;
  }

  #get(path: string): unknown {
    const segments = safeSegments(path);
    if (segments === null) {
      return undefined;
    }

    let current: unknown = this.#state;

    for (const segment of segments) {
      current = readSegment(current, segment);
      if (current === undefined) {
        return undefined;
      }
    }

    return current;
  }

  #setAtPath(path: string, value: unknown): void {
    const segments = safeSegments(path);
    if (segments === null) {
      return;
    }

    const last = segments.pop();
    if (last === undefined) {
      return;
    }

    let parent: unknown = this.#state;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      let next = readSegment(parent, segment);

      if (next === undefined || next === null) {
        const following = segments[index + 1];
        const child: unknown =
          following === "-1" || (following !== undefined && /^\d+$/.test(following))
            ? []
            : Object.create(null);
        writeSegment(parent, segment, child);
        next = child;
      }

      parent = next;
    }

    writeSegment(parent, last, value);
  }

  #ensureArray(path: string): unknown[] {
    const current = this.#get(path);
    if (Array.isArray(current)) {
      return current;
    }

    const created: unknown[] = [];
    this.#setAtPath(path, created);
    return created;
  }
}
