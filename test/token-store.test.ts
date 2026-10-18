import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DEVICE_ID_PATH,
  DEFAULT_TOKEN_PATH,
  readAuthValue,
  writeAuthValue,
} from "../src/auth/token-store";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "deepseek-web-auth-"));
  directories.push(directory);
  return directory;
}

describe("auth values", () => {
  test("reads a missing file as null", () => {
    const directory = temporaryDirectory();
    expect(readAuthValue(join(directory, "missing"))).toBeNull();
  });

  test("writes a trimmed value with owner-only permissions", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "token");

    writeAuthValue(path, "  stored-token \n");

    expect(readAuthValue(path)).toBe("stored-token");
    expect(readFileSync(path, "utf8")).toBe("stored-token\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory)).toEqual(["token"]);
  });

  test("treats an empty value as null", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "token");

    writeAuthValue(path, "   \n");

    expect(readAuthValue(path)).toBeNull();
  });

  test("uses the documented default paths", () => {
    expect(DEFAULT_TOKEN_PATH.endsWith(".omp/agent/deepseek-web-token")).toBe(true);
    expect(DEFAULT_DEVICE_ID_PATH.endsWith(".omp/agent/.deepseek-web-device-id")).toBe(
      true,
    );
  });
});
