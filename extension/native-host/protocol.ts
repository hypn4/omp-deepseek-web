import { writeAuthValue } from "../../src/auth/token-store";

const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface NativeTokenMessage {
  token: string;
  deviceId: string | null;
}

export interface NativeHostResult {
  ok: boolean;
  error?: string;
}

export interface NativeWritePaths {
  tokenPath: string;
  deviceIdPath: string;
}

/** Encodes one Chrome native-messaging frame (little-endian length + JSON). */
export function encodeNativeMessage(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, true);
  frame.set(payload, 4);
  return frame;
}

/** Decodes one complete frame, or returns null for incomplete/invalid input. */
export function decodeNativeMessage(buffer: Uint8Array): NativeTokenMessage | null {
  if (buffer.byteLength < 4) {
    return null;
  }
  const length = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  ).getUint32(0, true);
  if (length === 0 || length > MAX_MESSAGE_BYTES || length > buffer.byteLength - 4) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + length)));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.token !== "string" || record.token.trim() === "") {
    return null;
  }
  if (record.deviceId !== undefined && typeof record.deviceId !== "string") {
    return null;
  }
  const deviceId =
    typeof record.deviceId === "string" && record.deviceId.trim() !== ""
      ? record.deviceId.trim()
      : null;

  return { token: record.token.trim(), deviceId };
}

/**
 * Persists a token message. Validation happens before any write, so a
 * malformed message cannot replace a valid token.
 */
export function handleNativeMessage(
  raw: Uint8Array,
  paths: NativeWritePaths,
): NativeHostResult {
  const message = decodeNativeMessage(raw);
  if (message === null) {
    return { ok: false, error: "Invalid native message." };
  }

  try {
    writeAuthValue(paths.tokenPath, message.token);
    if (message.deviceId !== null) {
      writeAuthValue(paths.deviceIdPath, message.deviceId);
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not store credentials." };
  }
}
