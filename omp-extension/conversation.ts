import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PromptContext, PromptMessage } from "./prompt";

/** SQLite mapping store for persistent native chat sessions. */
export const DEFAULT_SESSION_STORE_PATH = join(
  homedir(),
  ".omp",
  "agent",
  "deepseek-web-sessions.sqlite",
);

/** Default age after which an unused mapping is forgotten. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap keeps the store bounded even if TTL records are still fresh. */
export const DEFAULT_SESSION_MAX_ENTRIES = 1_024;

export interface StoredSession {
  chatSessionId: string;
  parentMessageId: number;
  messageCount: number;
  prefixHash: string;
  systemHash: string;
  toolsHash: string;
  updatedAt: number;
}

export type ResetReason =
  | "new"
  | "system"
  | "tools"
  | "prefix"
  | "no-delta"
  | "developer";

export interface ConversationPlan {
  /** Prompt sent for this turn. */
  prompt: string;
  /** Existing session to continue, when the plan is a reuse. */
  chatSessionId?: string;
  /** Native parent message for an existing session. */
  parentMessageId?: number;
  /** Whether a successful turn should keep the session and commit metadata. */
  persistent: boolean;
  /** True only when the prompt is an incremental continuation. */
  reused: boolean;
  /** Why a fresh full-prompt chat was chosen. */
  resetReason?: ResetReason;
}

export interface ConversationPlanner {
  plan(
    scopeKey: string,
    context: PromptContext,
    fullPrompt: string,
    incrementalPrompt: (startIndex: number) => string | null,
  ): ConversationPlan;
  /** Returns mappings evicted by TTL or the entry cap. */
  commit(
    scopeKey: string,
    context: PromptContext,
    chatSessionId: string,
    parentMessageId: number,
  ): StoredSession[];
  invalidate(scopeKey: string): void;
  remove(scopeKey: string): StoredSession | undefined;
}

function hashJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(canonicalize);
    }
    if (typeof input === "object" && input !== null) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        result[key] = canonicalize((input as Record<string, unknown>)[key]);
      }
      return result;
    }
    return input;
  };
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

  commit(): StoredSession[] {
    return [];
  }

  invalidate(): void {}

  remove(): undefined {
    return undefined;
  }
}

interface SessionRow {
  scope_key: string;
  chat_session_id: string;
  parent_message_id: number;
  message_count: number;
  prefix_hash: string;
  system_hash: string;
  tools_hash: string;
  updated_at: number;
}

function toStoredSession(row: SessionRow): StoredSession {
  return {
    chatSessionId: row.chat_session_id,
    parentMessageId: row.parent_message_id,
    messageCount: row.message_count,
    prefixHash: row.prefix_hash,
    systemHash: row.system_hash,
    toolsHash: row.tools_hash,
    updatedAt: row.updated_at,
  };
}

export interface PersistentPlannerOptions {
  /** SQLite path; null/undefined uses the default path, ":memory:" is allowed. */
  path?: string | null;
  ttlMs?: number;
  maxEntries?: number;
}

/**
 * Reuses one native DeepSeek chat session for consecutive turns when the OMP
 * context is an exact prefix extension. Any mutation (compaction, edit, tool
 * schema change) resets to a fresh session with a full prompt.
 *
 * State lives in SQLite so commits are row-sized, TTL pruning is incremental,
 * and multiple omp processes do not rewrite a shared JSON blob.
 */
export class PersistentPlanner implements ConversationPlanner {
  readonly #db: Database;
  readonly #isFile: boolean;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  #pendingEvictions: StoredSession[] = [];
  readonly #select: ReturnType<Database["query"]>;
  readonly #upsert: ReturnType<Database["query"]>;
  readonly #remove: ReturnType<Database["query"]>;
  readonly #deleteExpired: ReturnType<Database["query"]>;
  readonly #deleteScope: ReturnType<Database["query"]>;
  readonly #oldest: ReturnType<Database["query"]>;
  readonly #count: ReturnType<Database["query"]>;

  constructor(options: PersistentPlannerOptions = {}) {
    const path =
      options.path === undefined
        ? DEFAULT_SESSION_STORE_PATH
        : (options.path ?? ":memory:");
    this.#ttlMs = Math.max(0, Math.trunc(options.ttlMs ?? DEFAULT_SESSION_TTL_MS));
    this.#maxEntries = Math.max(
      0,
      Math.trunc(options.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES),
    );

    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.#isFile = path !== ":memory:";
    this.#db = new Database(path, { create: true });
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    if (this.#isFile) {
      this.#db.exec("PRAGMA journal_mode = WAL");
      this.#db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      chmodSync(path, 0o600);
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        scope_key TEXT PRIMARY KEY,
        chat_session_id TEXT NOT NULL,
        parent_message_id INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        prefix_hash TEXT NOT NULL,
        system_hash TEXT NOT NULL,
        tools_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_updated_at
        ON sessions(updated_at);
      PRAGMA user_version = 1;
    `);
    this.#select = this.#db.query(
      "SELECT * FROM sessions WHERE scope_key = ?",
    );
    this.#upsert = this.#db.query(`
      INSERT INTO sessions (
        scope_key, chat_session_id, parent_message_id, message_count,
        prefix_hash, system_hash, tools_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        chat_session_id = excluded.chat_session_id,
        parent_message_id = excluded.parent_message_id,
        message_count = excluded.message_count,
        prefix_hash = excluded.prefix_hash,
        system_hash = excluded.system_hash,
        tools_hash = excluded.tools_hash,
        updated_at = excluded.updated_at
    `);
    this.#remove = this.#db.query(
      "DELETE FROM sessions WHERE scope_key = ?",
    );
    this.#deleteExpired = this.#db.query(
      "DELETE FROM sessions WHERE updated_at < ?",
    );
    this.#deleteScope = this.#db.query(
      "DELETE FROM sessions WHERE scope_key = ?",
    );
    this.#oldest = this.#db.query(
      `SELECT * FROM sessions
       WHERE scope_key != ?
       ORDER BY updated_at ASC, rowid ASC
       LIMIT ?`,
    );
    this.#count = this.#db.query("SELECT COUNT(*) AS count FROM sessions");

    // Startup cleanup returns records so the caller can delete native chats.
    this.#pendingEvictions.push(...this.#prune());
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

    const row = this.#select.get(scopeKey) as SessionRow | null;
    if (row === null) {
      return {
        prompt: fullPrompt,
        persistent: true,
        reused: false,
        resetReason: "new",
      };
    }
    const record = toStoredSession(row);

    const systemHash = hashJson(context.systemPrompt ?? []);
    const toolsHash = hashJson(toolFingerprint(context));
    if (record.systemHash !== systemHash || record.toolsHash !== toolsHash) {
      return {
        prompt: fullPrompt,
        persistent: true,
        reused: false,
        resetReason: record.systemHash !== systemHash ? "system" : "tools",
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
        resetReason: "prefix",
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
        resetReason: "no-delta",
      };
    }

    const newMessages = context.messages.slice(startIndex);
    if (newMessages.some((message) => message.role === "developer")) {
      return {
        prompt: fullPrompt,
        persistent: true,
        reused: false,
        resetReason: "developer",
      };
    }

    const prompt = incrementalPrompt(startIndex);
    if (prompt === null || prompt.trim() === "") {
      return {
        prompt: fullPrompt,
        persistent: true,
        reused: false,
        resetReason: "no-delta",
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
  ): StoredSession[] {
    if (scopeKey === "") {
      return [];
    }
    this.#upsert.run(
      scopeKey,
      chatSessionId,
      parentMessageId,
      context.messages.length,
      hashMessages(context.messages, context.messages.length),
      hashJson(context.systemPrompt ?? []),
      hashJson(toolFingerprint(context)),
      Date.now(),
    );
    return this.#prune(scopeKey);
  }

  invalidate(scopeKey: string): void {
    if (scopeKey !== "") {
      this.#deleteScope.run(scopeKey);
    }
  }

  remove(scopeKey: string): StoredSession | undefined {
    if (scopeKey === "") {
      return undefined;
    }
    const row = this.#select.get(scopeKey) as SessionRow | null;
    if (row === null) {
      return undefined;
    }
    this.#remove.run(scopeKey);
    return toStoredSession(row);
  }

  /** Records dropped by startup TTL/cap cleanup; the caller deletes their chats. */
  drainExpired(): StoredSession[] {
    const evicted = this.#pendingEvictions;
    this.#pendingEvictions = [];
    return evicted;
  }

  close(): void {
    this.#db.close();
  }

  #prune(protectScope = ""): StoredSession[] {
    const removed: StoredSession[] = [];
    if (this.#ttlMs > 0) {
      const cutoff = Date.now() - this.#ttlMs;
      const expired = this.#db
        .query("SELECT * FROM sessions WHERE updated_at < ?")
        .all(cutoff) as SessionRow[];
      if (expired.length > 0) {
        this.#deleteExpired.run(cutoff);
        removed.push(...expired.map(toStoredSession));
      }
    }

    if (this.#maxEntries > 0) {
      const countRow = this.#count.get() as { count: number };
      const excess = countRow.count - this.#maxEntries;
      if (excess > 0) {
        const oldest = this.#oldest.all(protectScope, excess) as SessionRow[];
        if (oldest.length > 0) {
          const deleteOne = this.#db.query(
            "DELETE FROM sessions WHERE scope_key = ?",
          );
          for (const row of oldest) {
            deleteOne.run(row.scope_key);
            removed.push(toStoredSession(row));
          }
        }
      }
    }

    if (removed.length > 0 && this.#isFile) {
      this.#db.exec("PRAGMA incremental_vacuum");
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    return removed;
  }
}
