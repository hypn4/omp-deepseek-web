// Forwards the token from the content script to the native messaging host.
// The host writes owner-only files; the token is never logged.
const NATIVE_HOST = "com.whales.deepseek_web";
const STATUS_KEY = "deepseekWebStatus";
const COLOR_ICONS = {
  16: "icons/deepseek-web-16.png",
  32: "icons/deepseek-web-32.png",
  48: "icons/deepseek-web-48.png",
  128: "icons/deepseek-web-128.png",
};
const MONO_ICONS = {
  16: "icons/deepseek-web-mono-16.png",
  32: "icons/deepseek-web-mono-32.png",
  48: "icons/deepseek-web-mono-48.png",
  128: "icons/deepseek-web-mono-128.png",
};

function publishStatus(status) {
  const value = { ...status, updatedAt: Date.now() };
  try {
    chrome.storage.local.set({ [STATUS_KEY]: value });
  } catch {
    // Status is best-effort; token delivery must still proceed.
  }

  const badge =
    status.state === "connected"
      ? "✓"
      : status.state === "syncing"
        ? "…"
        : "!";
  const color =
    status.state === "connected"
      ? "#188038"
      : status.state === "syncing"
        ? "#1a73e8"
        : "#d93025";
  try {
    chrome.action.setBadgeText({ text: badge });
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setIcon({
      path:
        status.state === "connected" || status.state === "syncing"
          ? COLOR_ICONS
          : MONO_ICONS,
    });
    chrome.action.setTitle({
      title: `DeepSeek Token Bridge — ${status.message}`,
    });
  } catch {
    // Older Chrome builds may not expose the action API in a worker.
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message === null ||
    typeof message !== "object" ||
    message.type !== "deepseek-token"
  ) {
    return false;
  }
  if (typeof message.token !== "string" || message.token.trim() === "") {
    publishStatus({
      state: "missing",
      message: "No token found. Open chat.deepseek.com and sign in.",
      tokenPresent: false,
      deviceIdPresent: false,
    });
    sendResponse({ ok: false, error: "Missing token." });
    return false;
  }

  const deviceIdPresent =
    typeof message.deviceId === "string" && message.deviceId !== "";
  publishStatus({
    state: "syncing",
    message: "Sending token to omp…",
    tokenPresent: true,
    deviceIdPresent,
  });

  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    const text =
      error instanceof Error
        ? error.message
        : "Could not start the native host.";
    publishStatus({
      state: "error",
      message: text,
      tokenPresent: true,
      deviceIdPresent,
    });
    sendResponse({ ok: false, error: text });
    return false;
  }

  let settled = false;
  const succeed = () => {
    if (settled) return;
    settled = true;
    publishStatus({
      state: "connected",
      message: "Token synced to omp.",
      tokenPresent: true,
      deviceIdPresent,
    });
    sendResponse({ ok: true });
    try {
      port.disconnect();
    } catch {
      // The port may already be closed by Chrome.
    }
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    publishStatus({
      state: "error",
      message: error,
      tokenPresent: true,
      deviceIdPresent,
    });
    sendResponse({ ok: false, error });
    try {
      port.disconnect();
    } catch {
      // The port may already be closed by Chrome.
    }
  };

  port.onMessage.addListener((response) => {
    if (response !== null && typeof response === "object" && response.ok === true) {
      succeed();
      return;
    }
    const error =
      response !== null &&
      typeof response === "object" &&
      typeof response.error === "string"
        ? response.error
        : "The native host rejected the token.";
    fail(error);
  });

  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    fail(
      typeof error?.message === "string"
        ? error.message
        : "The native host disconnected.",
    );
  });

  const body = { token: message.token };
  if (deviceIdPresent) {
    body.deviceId = message.deviceId;
  }

  try {
    port.postMessage(body);
  } catch {
    fail("Could not send the token to the native host.");
  }
  return true;
});
