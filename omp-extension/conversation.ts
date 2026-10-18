import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PromptContext, PromptMessage } from "./prompt";

/** Persistent session metadata is kept in one owner-only file. */
export const DEFAULT_SESSION_STORE_PATH = join(
  homedir(),
  ".omp",
  "agent",
  "deepseek-web-sessions.json",
);

/** Default age after which an unused mapping is forgotten. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredSession {
  chatSessionId: string;
  parentMessageId: number;
  messageCount: number;
  prefixHash: string;
  systemHash: string;
  toolsHash: string;
  updatedAt: number;
}

export interface ConversationPlan {
  /** Prompt sent for this turn. */
  prompt: string;
  /** Existing session to continue, when the plan is a reuse. */
  chatSessionId?: string;
  /** Native parent message for an existing session. */
  parentMessageId?: number;
  /** Whether a successful turn should keep the session and commit metadata. */
  persistent: boolean;
  /** A replaced session that should be deleted. */
  replacedChatSessionId?: string;
  /** True only when the prompt is an incremental continuation. */
  reused: boolean;
}

export interface ConversationPlanner {
  plan(
    scopeKey: string,
    context: PromptContext,
    fullPrompt: string,
    incrementalPrompt: (startIndex: number) => string | null,
  ): ConversationPlan;
  commit(
    scopeKey: string,
    context: PromptContext,
    chatSessionId: string,
    parentMessageId: number,
  ): void;
  invalidate(scopeKey: string): void;
  remove(scopeKey: string): StoredSession | undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function toolFingerprint(context: PromptContext): unknown {
  // Descriptions can contain volatile host status text. The callable schema
  // (name + parameters) is what the native session must stay compatible with.
  return [...(context.tools ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => ({ name: tool.name, parameters: tool.parameters ?? null }));
}

export function hashPromptValue(value: unknown): string {
  return hashJson(value);
}

export function hashMessages(
  messages: readonly PromptMessage[],
  count: number,
): string {
  return hashJson(messages.slice(0, Math.max(0, count)));
}

/** The current no-state strategy: every turn is a fresh DeepSeek chat. */
export class EphemeralPlanner implements ConversationPlanner {
  plan(
    _scopeKey: string,
    _context: PromptContext,
    fullPrompt: string,
    _incrementalPrompt: (startIndex: number) => string | null,
  ): ConversationPlan {
    return { prompt: fullPrompt, persistent: false, reused: false };
  }

  commit(): void {}

  invalidate(): void {}

  remove(): undefined {
    return undefined;
  }
}

interface SessionFile {
  version: 1;
  sessions: Record<string, StoredSession>;
}

function validRecord(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<StoredSession>;
  return (
    typeof record.chatSessionId === "string" &&
    record.chatSessionId.length > 0 &&
    typeof record.parentMessageId === "number" &&
    Number.isFinite(record.parentMessageId) &&
    typeof record.messageCount === "number" &&
    Number.isInteger(record.messageCount) &&
    record.messageCount >= 0 &&
    typeof record.prefixHash === "string" &&
    typeof record.systemHash === "string" &&
    typeof record.toolsHash === "string" &&
    typeof record.updatedAt === "number"
  );
}

/**
 * Reuses one native DeepSeek chat session for consecutive turns when the OMP
 * context is an exact prefix extension. Any mutation (compaction, edit, tool
 * schema change) resets to a fresh session with a full prompt.
 */
export class PersistentPlanner implements ConversationPlanner {
  readonly #path: string | null;
  readonly #ttlMs: number;
  #sessions = new Map<string, StoredSession>();
  #expired: StoredSession[] = [];

  constructor(options: { path?: string | null; ttlMs?: number } = {}) {
    this.#path = options.path === undefined ? DEFAULT_SESSION_STORE_PATH : options.path;
    this.#ttlMs = Math.max(0, Math.trunc(options.ttlMs ?? DEFAULT_SESSION_TTL_MS));
    this.#load();
    this.#expire();
  }

  plan(
    scopeKey: string,
    context: PromptContext,
    fullPrompt: string,
    incrementalPrompt: (startIndex: number) => string | null,
  ): ConversationPlan {
    if (scopeKey === "") {
      return { prompt: fullPrompt, persistent: false, reused: false };
    }

    const record = this.#sessions.get(scopeKey);
    if (record === undefined) {
      return { prompt: fullPrompt, persistent: true, reused: false };
    }

    const systemHash = hashJson(context.systemPrompt ?? []);
    const toolsHash = hashJson(toolFingerprint(context));
    if (record.systemHash !== systemHash || record.toolsHash !== toolsHash) {
      return {
        prompt: fullPrompt,
        persistent: true,
        reused: false,
        replacedChatSessionId: record.chatSessionId,
      };
    }

    if (
      context.messages.length < record.messageCount ||
      hashMessages(context.messages, record.messageCount) !== record.prefixHash
    ) {
      return {
        prompt: fullPrompt,
        persistent: true,
        reused: false,
        replacedChatSessionId: record.chatSessionId,
      };
    }

    // The host appends our previous assistant response before the next turn.
    // Its server-side copy is already in the session, so skip it.
    const assistant = context.messages[record.messageCount];
    const startIndex =
      assistant?.role === "assistant" ? record.messageCount + 1 : record.messageCount;
    if (startIndex >= context.messages.length) {
      return {
        prompt: fullPrompt,
        persistent: true,
        reused: false,
        replacedChatSessionId: record.chatSessionId,
      };
    }

    const newMessages = context.messages.slice(startIndex);
    if (newMessages.some((message) => message.role === "developer")) {
      return {
        prompt: fullPrompt,
        persistent: true,
        reused: false,
        replacedChatSessionId: record.chatSessionId,
      };
    }

    const prompt = incrementalPrompt(startIndex);
    if (prompt === null || prompt.trim() === "") {
      return {
        prompt: fullPrompt,
        persistent: true,
        reused: false,
        replacedChatSessionId: record.chatSessionId,
      };
    }

    return {
      prompt,
      chatSessionId: record.chatSessionId,
      parentMessageId: record.parentMessageId,
      persistent: true,
      reused: true,
    };
  }

  commit(
    scopeKey: string,
    context: PromptContext,
    chatSessionId: string,
    parentMessageId: number,
  ): void {
    if (scopeKey === "") {
      return;
    }
    this.#sessions.set(scopeKey, {
      chatSessionId,
      parentMessageId,
      messageCount: context.messages.length,
      prefixHash: hashMessages(context.messages, context.messages.length),
      systemHash: hashJson(context.systemPrompt ?? []),
      toolsHash: hashJson(toolFingerprint(context)),
      updatedAt: Date.now(),
    });
    this.#save();
  }

  invalidate(scopeKey: string): void {
    if (this.#sessions.delete(scopeKey)) {
      this.#save();
    }
  }

  remove(scopeKey: string): StoredSession | undefined {
    const record = this.#sessions.get(scopeKey);
    if (record === undefined) {
      return undefined;
    }
    this.#sessions.delete(scopeKey);
    this.#save();
    return record;
  }

  #load(): void {
    if (this.#path === null) {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SessionFile>;
      if (parsed.version !== 1 || typeof parsed.sessions !== "object" || parsed.sessions === null) {
        return;
      }
      for (const [key, value] of Object.entries(parsed.sessions)) {
        if (validRecord(value)) {
          this.#sessions.set(key, value);
        }
      }
    } catch {
      // A corrupt store must not prevent the provider from starting.
    }
  }

  /** Records dropped by TTL loading; the caller can delete their chats. */
  drainExpired(): StoredSession[] {
    const expired = this.#expired;
    this.#expired = [];
    return expired;
  }

  #expire(): void {
    if (this.#ttlMs <= 0) {
      return;
    }
    const cutoff = Date.now() - this.#ttlMs;
    let changed = false;
    for (const [key, record] of this.#sessions) {
      if (record.updatedAt < cutoff) {
        this.#sessions.delete(key);
        this.#expired.push(record);
        changed = true;
      }
    }
    if (changed) {
      this.#save();
    }
  }

  #save(): void {
    if (this.#path === null) {
      return;
    }
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const sessions: Record<string, StoredSession> = {};
    for (const [key, record] of this.#sessions) {
      sessions[key] = record;
    }
    const payload: SessionFile = { version: 1, sessions };
    const temporary = `${this.#path}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Best-effort cleanup; the store remains usable in memory.
      }
      throw error;
    }
  }
}
