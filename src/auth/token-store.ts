import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Token written by the Chrome native messaging host. */
export const DEFAULT_TOKEN_PATH = join(
  homedir(),
  ".omp",
  "agent",
  "deepseek-web-token",
);

/** Device id written by the Chrome native messaging host. */
export const DEFAULT_DEVICE_ID_PATH = join(
  homedir(),
  ".omp",
  "agent",
  ".deepseek-web-device-id",
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

/** Writes a token or device id atomically with owner-only permissions. */
export function writeAuthValue(path: string, value: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value.trim() + "\n", { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup; the original error is more useful.
    }
    throw error;
  }
}
