import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResetHandoff } from "../omp-extension/handoff";

function context() {
  return {
    systemPrompt: ["system"],
    messages: [
      { role: "user" as const, content: "implement the session lifecycle" },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "SQLite store is complete." }],
      },
      { role: "user" as const, content: "continue with retired chats" },
    ],
  };
}

describe("reset handoff", () => {
  test("includes cwd, current request, and prior assistant result", () => {
    const cwd = mkdtempSync(join(tmpdir(), "deepseek-handoff-"));
    try {
      const handoff = buildResetHandoff({ context: context(), cwd, reason: "new" });
      expect(handoff).toContain("## Session handoff");
      expect(handoff).toContain(`Working directory: ${cwd}`);
      expect(handoff).toContain("Current request:\ncontinue with retired chats");
      expect(handoff).toContain("Previous assistant result:\nSQLite store is complete.");
      expect(handoff).toContain("first persistent chat");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("adds bounded git branch and changed-file names", () => {
    const cwd = mkdtempSync(join(tmpdir(), "deepseek-handoff-git-"));
    try {
      execFileSync("git", ["init", "-q", cwd]);
      execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
      writeFileSync(join(cwd, "tracked.ts"), "export const value = 1;\n");
      execFileSync("git", ["-C", cwd, "add", "tracked.ts"]);
      execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
      writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
      writeFileSync(join(cwd, "new.ts"), "secret file content\n");

      const handoff = buildResetHandoff({ context: context(), cwd, reason: "prefix" });
      expect(handoff).toContain("Git branch:");
      expect(handoff).toContain("tracked.ts");
      expect(handoff).toContain("new.ts");
      expect(handoff).toContain("native parent chain");
      expect(handoff).not.toContain("secret file content");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("works without a git repository", () => {
    const cwd = mkdtempSync(join(tmpdir(), "deepseek-handoff-nogit-"));
    try {
      const handoff = buildResetHandoff({ context: context(), cwd, reason: "tools" });
      expect(handoff).toContain("tool schema changed");
      expect(handoff).not.toContain("Git branch:");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
