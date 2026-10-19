import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersistentPlanner,
  hashMessages,
} from "../omp-extension/conversation";
import type { PromptContext, PromptMessage } from "../omp-extension/prompt";

function user(text: string): PromptMessage {
  return { role: "user", content: text };
}

function assistant(text: string): PromptMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function context(messages: PromptMessage[], overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    systemPrompt: ["system"],
    messages,
    tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
    ...overrides,
  };
}

const FULL = "FULL PROMPT";
const incremental = (start: number): string => `DELTA ${start}`;

describe("persistent conversation planner", () => {
  test("reuses a session for an appended user turn", () => {
    const planner = new PersistentPlanner({ path: null });
    const first = context([user("one")]);
    expect(planner.plan("s", first, FULL, incremental)).toMatchObject({
      prompt: FULL,
      persistent: true,
      reused: false,
    });
    planner.commit("s", first, "chat-1", 2);

    const second = context([user("one"), assistant("answer"), user("two")]);
    expect(planner.plan("s", second, FULL, incremental)).toEqual({
      prompt: "DELTA 2",
      chatSessionId: "chat-1",
      parentMessageId: 2,
      persistent: true,
      reused: true,
    });
  });

  test("skips the previous assistant message and sends tool results only", () => {
    const planner = new PersistentPlanner({ path: null });
    const first = context([user("read it")]);
    planner.commit("s", first, "chat-1", 2);

    const second = context([
      user("read it"),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/x" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
      },
    ]);
    const plan = planner.plan("s", second, FULL, incremental);
    expect(plan.prompt).toBe("DELTA 2");
    expect(plan.reused).toBe(true);
  });

  test("resets when an earlier message changes", () => {
    const planner = new PersistentPlanner({ path: null });
    planner.commit("s", context([user("one")]), "chat-1", 2);

    const changed = context([user("edited"), assistant("answer"), user("two")]);
    expect(planner.plan("s", changed, FULL, incremental)).toMatchObject({
      prompt: FULL,
      persistent: true,
      reused: false,
    });
  });

  test("resets when system prompt or tools change", () => {
    const planner = new PersistentPlanner({ path: null });
    planner.commit("s", context([user("one")]), "chat-1", 2);

    expect(
      planner.plan(
        "s",
        context([user("one"), assistant("a"), user("two")], { systemPrompt: ["changed"] }),
        FULL,
        incremental,
      ),
    ).toMatchObject({ prompt: FULL, reused: false });
    expect(
      planner.plan(
        "s",
        context([user("one"), assistant("a"), user("two")], {
          tools: [{ name: "other", description: "x", parameters: {} }],
        }),
        FULL,
        incremental,
      ),
    ).toMatchObject({ prompt: FULL, reused: false });
  });

  test("ignores volatile tool descriptions and tool order", () => {
    const planner = new PersistentPlanner({ path: null });
    const first = context([user("one")], {
      tools: [
        { name: "read", description: "old description", parameters: { type: "object" } },
        { name: "bash", description: "bash", parameters: { type: "object" } },
      ],
    });
    planner.commit("s", first, "chat-1", 2);

    const second = context([user("one"), assistant("answer"), user("two")], {
      tools: [
        { name: "bash", description: "new bash description", parameters: { type: "object" } },
        { name: "read", description: "new description", parameters: { type: "object" } },
      ],
    });
    expect(planner.plan("s", second, FULL, incremental)).toMatchObject({
      chatSessionId: "chat-1",
      reused: true,
    });
  });

  test("resets when a tool parameter schema changes", () => {
    const planner = new PersistentPlanner({ path: null });
    planner.commit("s", context([user("one")]), "chat-1", 2);
    const changed = context([user("one"), assistant("a"), user("two")], {
      tools: [
        {
          name: "read",
          description: "read",
          parameters: { type: "object", required: ["path"] },
        },
      ],
    });
    expect(planner.plan("s", changed, FULL, incremental)).toMatchObject({
      prompt: FULL,
      reused: false,
    });
  });

  test("resets when there is no new message", () => {
    const planner = new PersistentPlanner({ path: null });
    const first = context([user("one")]);
    planner.commit("s", first, "chat-1", 2);

    const same = context([user("one"), assistant("answer")]);
    expect(planner.plan("s", same, FULL, incremental)).toMatchObject({
      prompt: FULL,
      reused: false,
    });
  });

  test("persists mappings across planner instances", () => {
    const directory = mkdtempSync(join(tmpdir(), "deepseek-sessions-"));
    const path = join(directory, "sessions.sqlite");
    const first = new PersistentPlanner({ path, ttlMs: 60_000 });
    try {
      first.commit("s", context([user("one")]), "chat-1", 2);
      first.close();

      const second = new PersistentPlanner({ path, ttlMs: 60_000 });
      try {
        const plan = second.plan(
          "s",
          context([user("one"), assistant("answer"), user("two")]),
          FULL,
          incremental,
        );
        expect(plan).toMatchObject({
          chatSessionId: "chat-1",
          parentMessageId: 2,
          reused: true,
        });
      } finally {
        second.close();
      }

      const db = new Database(path);
      try {
        expect(
          (db.query("SELECT chat_session_id FROM sessions WHERE scope_key = 's'").get() as {
            chat_session_id: string;
          }).chat_session_id,
        ).toBe("chat-1");
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("drops stale mappings and reports their chats for cleanup", () => {
    const directory = mkdtempSync(join(tmpdir(), "deepseek-sessions-"));
    const path = join(directory, "sessions.sqlite");
    const planner = new PersistentPlanner({ path, ttlMs: 60_000 });
    try {
      planner.commit("stale", context([user("one")]), "old-chat", 2);
      planner.close();

      const db = new Database(path);
      try {
        db.query("UPDATE sessions SET updated_at = 1").run();
      } finally {
        db.close();
      }

      const expired = new PersistentPlanner({ path, ttlMs: 10 });
      try {
        expect(expired.drainExpired().map((record) => record.chatSessionId)).toEqual([
          "old-chat",
        ]);
        expect(expired.plan("stale", context([user("one")]), FULL, incremental)).toMatchObject({
          prompt: FULL,
          reused: false,
        });
      } finally {
        expired.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("evicts the oldest mapping when the entry cap is exceeded", () => {
    const planner = new PersistentPlanner({ path: null, ttlMs: 0, maxEntries: 2 });
    try {
      planner.commit("one", context([user("one")]), "chat-1", 2);
      planner.commit("two", context([user("two")]), "chat-2", 2);
      const evicted = planner.commit("three", context([user("three")]), "chat-3", 2);
      expect(evicted.map((record) => record.chatSessionId)).toEqual(["chat-1"]);
      expect(planner.plan("one", context([user("one")]), FULL, incremental)).toMatchObject({
        prompt: FULL,
        reused: false,
      });
    } finally {
      planner.close();
    }
  });

  test("remove deletes the mapping and hash handles empty prefixes", () => {
    const planner = new PersistentPlanner({ path: null });
    planner.commit("s", context([user("one")]), "chat-1", 2);
    expect(planner.remove("s")?.chatSessionId).toBe("chat-1");
    expect(planner.remove("s")).toBeUndefined();
    expect(hashMessages([], 0)).toBe(hashMessages([], 0));
    planner.close();
  });
});
