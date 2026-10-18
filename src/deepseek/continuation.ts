import type { DeepSeekSseResult } from "./sse";

/** Marker the continuation prompt asks for when the previous answer was already complete. */
export const CONTINUATION_COMPLETE_MARKER = "[COMPLETE]";

/** True when the model answered with the completion marker (with or without extra prose). */
export function isContinuationComplete(addition: string): boolean {
  return /^\s*\[COMPLETE\][.!。！？]?(?=\s|$)/iu.test(addition);
}

const TERMINAL_PUNCTUATION = /[.!?。！？…)\]}”’"'`]\s*$/u;
const DANGLING_ENGLISH = new RegExp(
  "\\b(?:and|but|or|because|so|while|if|when|that|which|who|whom|whose|" +
    "than|with|without|for|to|of|in|on|at|by|from|as|although|though|" +
    "since|unless|until|whether|where)\\s*$",
  "iu",
);
const DANGLING_KOREAN =
  /(?:지만|는데|면서|니까|려고|도록|라고|다고|거나|든지|므로|반면|따라서|그러나|그런데|또한|및)\s*$/u;
const OPEN_DELIMITER = /[([{“‘"']\s*$/u;
const WORD_CHAR = /[\p{L}\p{N}]$/u;

function withoutCitations(text: string): string {
  return text.replace(/\[\s*reference:\d+\s*\]/giu, "").trimEnd();
}

function lastContentLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? "";
}

function trimMarkdownMarkers(line: string): string {
  return line.replace(/(?:\*\*|__|\*|_|`)+$/u, "").trimEnd();
}

/**
 * Detects an answer that was cut off before the model finished a thought.
 *
 * A stream that never reached FINISHED is always incomplete. A finished stream
 * is judged by its final visible line: terminal punctuation and Markdown table
 * rows are accepted, while dangling conjunctions, open delimiters, and long
 * unpunctuated lines are treated as truncation.
 */
export function isLikelyIncomplete(
  result: Pick<DeepSeekSseResult, "text" | "finished">,
): boolean {
  if (!result.finished) {
    return result.text.trim().length > 0;
  }

  const text = withoutCitations(result.text);
  if (text.trim() === "") {
    return false;
  }

  const line = trimMarkdownMarkers(lastContentLine(text));
  if (line === "") {
    return false;
  }

  if (TERMINAL_PUNCTUATION.test(line) || line.endsWith("|")) {
    return false;
  }
  if (DANGLING_KOREAN.test(line) || DANGLING_ENGLISH.test(line)) {
    return true;
  }
  if (OPEN_DELIMITER.test(line)) {
    return true;
  }
  if (line.length >= 60 && WORD_CHAR.test(line)) {
    return true;
  }
  return false;
}

/**
 * Appends a continuation to an existing answer. DeepSeek usually returns only
 * the newly generated suffix, but a model may repeat part or all of the prior
 * answer; remove the longest overlap before appending.
 */
export function mergeContinuation(existing: string, addition: string): string {
  const trimmed = addition.trim();
  if (trimmed === "" || isContinuationComplete(addition)) {
    return existing;
  }
  if (addition.startsWith(existing)) {
    return addition;
  }

  const index = addition.indexOf(existing);
  if (index !== -1) {
    const suffix = addition.slice(index + existing.length);
    return suffix.length > 0 ? existing + suffix : existing;
  }

  const maxOverlap = Math.min(existing.length, addition.length, 4000);
  for (let length = maxOverlap; length >= 3; length -= 1) {
    if (existing.endsWith(addition.slice(0, length))) {
      return existing + addition.slice(length);
    }
  }

  return existing + addition;
}

/**
 * Builds the follow-up prompt used to resume a truncated answer. When the
 * upstream response message id is available, the same chat session provides
 * the prior answer and no excerpt is needed. Otherwise include the tail so a
 * parent-less continuation has enough context.
 */
export function buildContinuationPrompt(previousText?: string): string {
  const prompt =
    "Continue the previous answer from the exact cutoff. Output only the continuation; " +
    "do not repeat any earlier text. If the previous answer is already complete, " +
    `output exactly ${CONTINUATION_COMPLETE_MARKER}.`;
  if (previousText === undefined || previousText.trim() === "") {
    return prompt;
  }
  const tail = previousText.slice(-2000);
  return `${prompt}\n\nThe answer so far:\n---\n${tail}\n---`;
}
