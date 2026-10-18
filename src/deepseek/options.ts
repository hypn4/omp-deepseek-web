/**
 * DeepSeek native tool turns do not use DeepThink. An unset/`auto` setting
 * follows that rule; `1`/`0` are explicit user overrides.
 */
export function resolveThinkingEnabled(
  setting: string | undefined,
  hasTools: boolean,
): boolean {
  const normalized = setting?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return !hasTools;
}
