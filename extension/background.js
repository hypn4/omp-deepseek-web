// Forwards the token from the content script to the native messaging host.
// The host writes owner-only files; the token is never logged.
const NATIVE_HOST = "com.whales.deepseek_web";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message === null ||
    typeof message !== "object" ||
    message.type !== "deepseek-token"
  ) {
    return false;
  }
  if (typeof message.token !== "string" || message.token.trim() === "") {
    sendResponse({ ok: false, error: "Missing token." });
    return false;
  }

  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Could not start the native host.",
    });
    return false;
  }

  let settled = false;
  const finish = (response) => {
    if (settled) return;
    settled = true;
    sendResponse(response);
    try {
      port.disconnect();
    } catch {
      // The port may already be closed by Chrome.
    }
  };

  port.onMessage.addListener((response) => {
    if (response !== null && typeof response === "object" && response.ok === true) {
      finish({ ok: true });
      return;
    }
    const error =
      response !== null &&
      typeof response === "object" &&
      typeof response.error === "string"
        ? response.error
        : "The native host rejected the token.";
    finish({ ok: false, error });
  });

  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    finish({
      ok: false,
      error:
        typeof error?.message === "string"
          ? error.message
          : "The native host disconnected.",
    });
  });

  const body = { token: message.token };
  if (typeof message.deviceId === "string" && message.deviceId !== "") {
    body.deviceId = message.deviceId;
  }

  try {
    port.postMessage(body);
  } catch {
    finish({ ok: false, error: "Could not send the token to the native host." });
  }
  return true;
});
