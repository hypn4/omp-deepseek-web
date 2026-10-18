import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

interface SentMessage {
  message: { type: string; token: string; deviceId?: string };
  callback: (response: unknown) => void;
}

interface ContentMock {
  storage: Record<string, string>;
  sent: SentMessage[];
  tick(): void;
  getMessageListener(): (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean | undefined;
}

function loadContent(): ContentMock {
  const storage: Record<string, string> = {};
  const sent: SentMessage[] = [];
  let interval: (() => void) | undefined;
  let messageListener:
    | ((
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void,
      ) => boolean | undefined)
    | undefined;

  const localStorage = {
    getItem(key: string) {
      return storage[key] ?? null;
    },
  };

  const chrome = {
    runtime: {
      lastError: undefined as { message?: string } | undefined,
      onMessage: {
        addListener(
          listener: (
            message: unknown,
            sender: unknown,
            sendResponse: (response: unknown) => void,
          ) => boolean | undefined,
        ) {
          messageListener = listener;
        },
      },
      sendMessage(message: SentMessage["message"], callback: (response: unknown) => void) {
        sent.push({ message, callback });
      },
    },
  };

  const source = readFileSync(join(import.meta.dir, "../extension/content.js"), "utf8");
  runInNewContext(source, {
    chrome,
    localStorage,
    setInterval(callback: () => void) {
      interval = callback;
      return 1;
    },
  });

  return {
    storage,
    sent,
    tick() {
      if (interval === undefined) {
        throw new Error("content script did not install an interval");
      }
      interval();
    },
    getMessageListener() {
      if (messageListener === undefined) {
        throw new Error("content script did not register a message listener");
      }
      return messageListener;
    },
  };
}

describe("extension content script", () => {
  test("sends a raw token with the device id", () => {
    const mock = loadContent();
    mock.storage.userToken = "stored-token";
    mock.storage["deepseek-device-id:chat"] = "device-1";

    // The initial sync ran before the storage was populated.
    mock.tick();

    expect(mock.sent.at(-1)?.message).toEqual({
      type: "deepseek-token",
      token: "stored-token",
      deviceId: "device-1",
    });
  });

  test("accepts the { value } token shape and does not resend unchanged values", () => {
    const mock = loadContent();
    mock.storage.userToken = JSON.stringify({ value: "stored-token" });

    mock.tick();
    mock.sent.at(-1)?.callback({ ok: true });
    const count = mock.sent.length;

    mock.tick();

    expect(mock.sent.length).toBe(count);
    expect(mock.sent.at(-1)?.message.token).toBe("stored-token");
  });

  test("resends when the device id changes", () => {
    const mock = loadContent();
    mock.storage.userToken = "stored-token";
    mock.storage["deepseek-device-id:chat"] = "device-1";

    mock.tick();
    mock.sent.at(-1)?.callback({ ok: true });
    const count = mock.sent.length;
    mock.storage["deepseek-device-id:chat"] = "device-2";

    mock.tick();

    expect(mock.sent.length).toBe(count + 1);
    expect(mock.sent.at(-1)?.message.deviceId).toBe("device-2");
  });

  test("retries after a failed send", () => {
    const mock = loadContent();
    mock.storage.userToken = "stored-token";

    mock.tick();
    mock.sent.at(-1)?.callback({ ok: false });
    const count = mock.sent.length;

    mock.tick();

    expect(mock.sent.length).toBe(count + 1);
  });

  test("responds to a sync-now request", () => {
    const mock = loadContent();
    mock.storage.userToken = "stored-token";
    const before = mock.sent.length;
    let response: unknown;

    mock.getMessageListener()(
      { type: "deepseek-sync-now" },
      {},
      (value) => {
        response = value;
      },
    );

    expect(mock.sent.length).toBe(before + 1);
    expect(response).toEqual({ ok: true });
  });
});
