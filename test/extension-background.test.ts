import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

interface PortMock {
  onMessage: { addListener(listener: (value: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(value: unknown): void;
  disconnect(): void;
  notifyMessage(value: unknown): void;
  notifyDisconnect(): void;
}

interface ChromeMock {
  runtime: {
    onMessage: { addListener(listener: MessageListener): void };
    connectNative(name: string): PortMock;
    lastError?: { message?: string };
  };
  storage: {
    local: {
      set(value: Record<string, unknown>): void;
    };
  };
  action: {
    setBadgeText(value: { text: string }): void;
    setBadgeBackgroundColor(value: { color: string }): void;
    setTitle(value: { title: string }): void;
  };
}

interface BackgroundMock {
  chrome: ChromeMock;
  getListener(): MessageListener;
  getHostName(): string | undefined;
  getSent(): unknown[];
  port: PortMock;
  statusWrites: Array<Record<string, unknown>>;
  badgeTexts: string[];
  badgeColors: string[];
}

function loadBackground(): BackgroundMock {
  let listener: MessageListener | undefined;
  let hostName: string | undefined;
  const sent: unknown[] = [];
  const statusWrites: Array<Record<string, unknown>> = [];
  const badgeTexts: string[] = [];
  const badgeColors: string[] = [];
  let messageListener: ((value: unknown) => void) | undefined;
  let disconnectListener: (() => void) | undefined;

  const port: PortMock = {
    onMessage: {
      addListener(value) {
        messageListener = value;
      },
    },
    onDisconnect: {
      addListener(value) {
        disconnectListener = value;
      },
    },
    postMessage(value) {
      sent.push(value);
    },
    disconnect() {},
    notifyMessage(value) {
      messageListener?.(value);
    },
    notifyDisconnect() {
      disconnectListener?.();
    },
  };

  const chrome: ChromeMock = {
    runtime: {
      onMessage: {
        addListener(value) {
          listener = value;
        },
      },
      connectNative(name) {
        hostName = name;
        return port;
      },
      lastError: undefined,
    },
    storage: {
      local: {
        set(value) {
          statusWrites.push(value);
        },
      },
    },
    action: {
      setBadgeText(value) {
        badgeTexts.push(value.text);
      },
      setBadgeBackgroundColor(value) {
        badgeColors.push(value.color);
      },
      setTitle() {},
    },
  };

  const source = readFileSync(
    join(import.meta.dir, "../extension/background.js"),
    "utf8",
  );
  runInNewContext(source, { chrome, console });

  return {
    chrome,
    getListener() {
      if (listener === undefined) {
        throw new Error("background did not register a message listener");
      }
      return listener;
    },
    getHostName: () => hostName,
    getSent: () => sent,
    port,
    statusWrites,
    badgeTexts,
    badgeColors,
  };
}

describe("extension background", () => {
  test("forwards the token to the native host", () => {
    const mock = loadBackground();
    let response: unknown;

    const keepAlive = mock.getListener()(
      { type: "deepseek-token", token: "stored-token", deviceId: "device-1" },
      {},
      (value) => {
        response = value;
      },
    );

    expect(keepAlive).toBe(true);
    expect(mock.getHostName()).toBe("com.whales.deepseek_web");
    expect(mock.getSent()).toEqual([
      { token: "stored-token", deviceId: "device-1" },
    ]);
    mock.port.notifyMessage({ ok: true });
    expect(response).toEqual({ ok: true });
  });

  test("rejects an empty token without contacting the host", () => {
    const mock = loadBackground();
    let response: unknown;

    mock.getListener()(
      { type: "deepseek-token", token: "   " },
      {},
      (value) => {
        response = value;
      },
    );

    expect(mock.getHostName()).toBeUndefined();
    expect(response).toEqual({ ok: false, error: "Missing token." });
  });

  test("publishes a connected status and success badge", () => {
    const mock = loadBackground();

    mock.getListener()(
      { type: "deepseek-token", token: "stored-token", deviceId: "device-1" },
      {},
      () => {},
    );
    mock.port.notifyMessage({ ok: true });

    const status = mock.statusWrites.at(-1)?.deepseekWebStatus as
      | { state: string; message: string; deviceIdPresent: boolean }
      | undefined;
    expect(status?.state).toBe("connected");
    expect(status?.message).toContain("synced");
    expect(status?.deviceIdPresent).toBe(true);
    expect(mock.badgeTexts.at(-1)).toBe("✓");
    expect(mock.badgeColors.at(-1)).toBe("#188038");
  });

  test("publishes a missing-token status and warning badge", () => {
    const mock = loadBackground();

    mock.getListener()(
      { type: "deepseek-token", token: "   " },
      {},
      () => {},
    );

    const status = mock.statusWrites.at(-1)?.deepseekWebStatus as
      | { state: string; message: string }
      | undefined;
    expect(status?.state).toBe("missing");
    expect(status?.message).toContain("No token");
    expect(mock.badgeTexts.at(-1)).toBe("!");
  });

  test("reports a native host disconnect", () => {
    const mock = loadBackground();
    let response: unknown;

    mock.getListener()(
      { type: "deepseek-token", token: "stored-token" },
      {},
      (value) => {
        response = value;
      },
    );
    mock.chrome.runtime.lastError = {
      message: "Specified native messaging host not found.",
    };
    mock.port.notifyDisconnect();

    expect(response).toEqual({
      ok: false,
      error: "Specified native messaging host not found.",
    });
  });
});
