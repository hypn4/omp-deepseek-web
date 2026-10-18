import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns the device id stored at `path`, creating a UUID (mode 0600) when the
 * file is missing, empty, or does not contain a valid UUID.
 */
export function loadOrCreateDeviceId(path: string): string {
  try {
    const stored = readFileSync(path, "utf8").trim();
    if (UUID_PATTERN.test(stored)) {
      return stored;
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const deviceId = globalThis.crypto.randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${deviceId}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return deviceId;
}
