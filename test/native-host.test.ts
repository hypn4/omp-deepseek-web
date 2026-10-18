import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeNativeMessage,
  encodeNativeMessage,
  handleNativeMessage,
} from "../extension/native-host/protocol";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function paths() {
  const directory = mkdtempSync(join(tmpdir(), "deepseek-web-native-"));
  directories.push(directory);
  return {
    tokenPath: join(directory, "token"),
    deviceIdPath: join(directory, "device"),
  };
}

describe("native messaging protocol", () => {
  test("round-trips a framed token message", () => {
    const encoded = encodeNativeMessage({
      token: "stored-token",
      deviceId: "device-1",
    });

    expect(decodeNativeMessage(encoded)).toEqual({
      token: "stored-token",
      deviceId: "device-1",
    });
  });

  test("rejects incomplete and malformed frames", () => {
    const encoded = encodeNativeMessage({ token: "stored-token" });

    expect(decodeNativeMessage(encoded.subarray(0, encoded.length - 1))).toBeNull();
    expect(decodeNativeMessage(new TextEncoder().encode("nope"))).toBeNull();
    expect(
      decodeNativeMessage(encodeNativeMessage({ token: "   " })),
    ).toBeNull();
  });

  test("writes the token and device id with owner-only permissions", () => {
    const target = paths();
    const result = handleNativeMessage(
      encodeNativeMessage({ token: "  stored-token ", deviceId: " device-1 " }),
      target,
    );

    expect(result).toEqual({ ok: true });
    expect(readFileSync(target.tokenPath, "utf8")).toBe("stored-token\n");
    expect(readFileSync(target.deviceIdPath, "utf8")).toBe("device-1\n");
    expect(statSync(target.tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(target.deviceIdPath).mode & 0o777).toBe(0o600);
  });

  test("does not overwrite the token on a malformed message", () => {
    const target = paths();
    handleNativeMessage(
      encodeNativeMessage({ token: "original-token", deviceId: "device-1" }),
      target,
    );

    const result = handleNativeMessage(new TextEncoder().encode("not-json"), target);

    expect(result.ok).toBe(false);
    expect(readFileSync(target.tokenPath, "utf8")).toBe("original-token\n");
  });

  test("accepts a token without a device id", () => {
    const target = paths();
    const result = handleNativeMessage(
      encodeNativeMessage({ token: "stored-token" }),
      target,
    );

    expect(result).toEqual({ ok: true });
    expect(readFileSync(target.tokenPath, "utf8")).toBe("stored-token\n");
  });
});
