import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Token written by the Chrome extension's POST /login/token. */
export const DEFAULT_TOKEN_PATH = join(
  homedir(),
  ".omp",
  "agent",
  "deepseek-web-token",
);

/** Reads a trimmed auth value, or null when the file is absent or empty. */
export function readAuthValue(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Writes a token or device id with owner-only permissions. */
export function writeAuthValue(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value.trim() + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
