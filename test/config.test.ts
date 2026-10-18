import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const temporaryDirectories: string[] = [];

function deviceIdPath(name = ".deepseek-web-device-id"): string {
  const directory = mkdtempSync(join(tmpdir(), "deepseek-web-config-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("device id configuration", () => {
  test("reads the trimmed device id saved by the browser extension", () => {
    const path = deviceIdPath();
    writeFileSync(path, "  4e9c1d2a-7f3b-4c8e-9a1d-2b3c4d5e6f70\n\n");

    expect(loadConfig({}, { deviceIdPath: path }).deviceId).toBe(
      "4e9c1d2a-7f3b-4c8e-9a1d-2b3c4d5e6f70",
    );
  });

  test("prefers DEEPSEEK_WEB_DEVICE_ID over the saved file", () => {
    const path = deviceIdPath();
    writeFileSync(path, "file-device-id\n");

    expect(
      loadConfig({ DEEPSEEK_WEB_DEVICE_ID: " env-device-id " }, { deviceIdPath: path })
        .deviceId,
    ).toBe("env-device-id");
  });

  test("falls back to a random UUID when the file is missing or empty", () => {
    const missing = deviceIdPath("missing-device-id");
    const first = loadConfig({}, { deviceIdPath: missing }).deviceId;
    expect(first).toMatch(UUID_PATTERN);

    const empty = deviceIdPath();
    writeFileSync(empty, "  \n");
    const second = loadConfig({}, { deviceIdPath: empty }).deviceId;
    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
  });
});
