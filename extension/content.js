// Reads the chat.deepseek.com session token and device id from localStorage and
// forwards them to the local proxy through the background service worker.
(() => {
  const TOKEN_KEY = "userToken";
  const DEVICE_KEY = "deepseek-device-id:chat";
  const HEARTBEAT_MS = 30_000;
  let lastToken = "";
  let lastSentAt = 0;

  function readToken() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (raw === null || raw === "") return null;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.value === "string" && parsed.value !== "") {
          return parsed.value;
        }
      } catch {
        // Older or hand-written values may be the token itself.
      }
      return raw;
    } catch {
      return null;
    }
  }

  function sync() {
    const token = readToken();
    if (token === null) return;
    const now = Date.now();
    if (token === lastToken && now - lastSentAt < HEARTBEAT_MS) return;
    lastToken = token;
    lastSentAt = now;
    const deviceId = localStorage.getItem(DEVICE_KEY) || undefined;
    try {
      chrome.runtime.sendMessage(
        { type: "deepseek-token", token, deviceId },
        () => void chrome.runtime.lastError,
      );
    } catch {
      // The proxy or extension context may be unavailable; retry on the next tick.
    }
  }

  sync();
  setInterval(sync, 5_000);
})();
