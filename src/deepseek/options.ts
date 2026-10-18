/**
 * DeepThink is enabled by default. Only an explicit off value disables it.
 */
export function resolveThinkingEnabled(setting: string | undefined): boolean {
  const normalized = setting?.trim().toLowerCase();
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return true;
}

/** Android/web client default for `normal_history_and_file_token_limit`. */
export const DEFAULT_WEB_CONTEXT_WINDOW = 61_440;

/** Uses a conservative web-client limit unless explicitly overridden. */
export function resolveContextWindow(setting: string | undefined): number {
  const parsed = Number(setting);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WEB_CONTEXT_WINDOW;
}
