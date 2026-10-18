import {
  DEFAULT_DEVICE_ID_PATH,
  DEFAULT_TOKEN_PATH,
} from "../../src/auth/token-store";
import { encodeNativeMessage, handleNativeMessage } from "./protocol";

const MAX_MESSAGE_BYTES = 1024 * 1024;

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}

/** Reads one Chrome native-messaging frame from stdin. */
async function readFrame(): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of process.stdin) {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    chunks.push(bytes);
    total += bytes.byteLength;

    if (total < 4) {
      continue;
    }

    const combined = concat(chunks, total);
    const length = new DataView(combined.buffer).getUint32(0, true);
    if (length > MAX_MESSAGE_BYTES) {
      return combined;
    }
    if (total >= 4 + length) {
      return combined.subarray(0, 4 + length);
    }
  }

  return chunks.length > 0 ? concat(chunks, total) : null;
}

const raw = await readFrame();
const result =
  raw === null
    ? { ok: false, error: "No native message received." }
    : handleNativeMessage(raw, {
        tokenPath: DEFAULT_TOKEN_PATH,
        deviceIdPath: DEFAULT_DEVICE_ID_PATH,
      });

process.stdout.write(encodeNativeMessage(result));
