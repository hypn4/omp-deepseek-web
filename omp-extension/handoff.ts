import { execFileSync } from "node:child_process";
import type { PromptContext, PromptMessage } from "./prompt";
import { stripToolMarkup } from "../src/openai/translate";
import type { ResetReason } from "./conversation";

export interface HandoffInput {
  context: PromptContext;
  cwd: string;
  reason: ResetReason;
}

const MAX_FIELD_CHARS = 2_000;
const MAX_STATUS_FILES = 20;

function textOf(message: PromptMessage): string {
  if (message.role === "assistant") {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
  }
  if (message.role === "toolResult") {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
  }
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

function truncate(value: string, max = MAX_FIELD_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}\n[…truncated]`;
}

function gitState(cwd: string): { branch?: string; files: string[]; more: number } | null {
  try {
    const status = execFileSync(
      "git",
      ["-C", cwd, "status", "--porcelain=v1", "--branch"],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const lines = status === "" ? [] : status.split("\n");
    const branchLine = lines[0]?.startsWith("## ") ? lines.shift() : undefined;
    const branch = branchLine?.slice(3).split("...")[0]?.trim();
    const files = lines.filter((line) => line.trim() !== "");
    return {
      ...(branch ? { branch } : {}),
      files: files.slice(0, MAX_STATUS_FILES),
      more: Math.max(0, files.length - MAX_STATUS_FILES),
    };
  } catch {
    return null;
  }
}

function reasonText(reason: ResetReason): string {
  switch (reason) {
    case "new":
      return "This is the first persistent chat for this OMP session.";
    case "system":
      return "The system prompt changed, so the native chat was restarted.";
    case "tools":
      return "The tool schema changed, so the native chat was restarted.";
    case "prefix":
      return "The OMP transcript no longer matched the native parent chain, so the native chat was restarted.";
    case "no-delta":
      return "There was no incremental turn to append, so the native chat was restarted.";
  }
}

/**
 * Builds a bounded reset handoff from OMP context and the working directory.
 * It intentionally never reads project files or other session transcripts.
 */
export function buildResetHandoff(input: HandoffInput): string | null {
  const { context, cwd, reason } = input;
  const latestUser = [...context.messages]
    .reverse()
    .find((message) => message.role === "user");
  const latestAssistant = [...context.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  const current = latestUser ? truncate(textOf(latestUser)) : "";
  const previous = latestAssistant
    ? truncate(stripToolMarkup(textOf(latestAssistant)))
    : "";
  const git = cwd === "" ? null : gitState(cwd);

  const sections: string[] = [
    "## Session handoff",
    reasonText(reason),
    "Continue from the OMP context above; do not repeat completed work.",
  ];

  if (cwd !== "") {
    sections.push(`Working directory: ${cwd}`);
  }
  if (git !== null) {
    sections.push(`Git branch: ${git.branch ?? "(detached)"}`);
    if (git.files.length > 0) {
      const more = git.more > 0 ? `\n- …and ${git.more} more` : "";
      sections.push(`Changed files:\n${git.files.map((file) => `- ${file}`).join("\n")}${more}`);
    }
  }
  if (current !== "") {
    sections.push(`Current request:\n${current}`);
  }
  if (previous !== "") {
    sections.push(`Previous assistant result:\n${previous}`);
  }

  return sections.join("\n\n");
}
