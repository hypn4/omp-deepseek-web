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
