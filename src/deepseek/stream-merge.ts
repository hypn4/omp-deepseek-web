/**
 * Appends a native `/chat/continue` result to the text already streamed.
 *
 * DeepSeek normally returns only the new suffix, but a continuation may repeat
 * part or all of the prior answer. Remove the longest overlap before appending.
 */
export function mergeContinuation(existing: string, addition: string): string {
  if (addition.trim() === "") {
    return existing;
  }
  if (existing.startsWith(addition)) {
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
