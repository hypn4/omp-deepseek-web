// Reads the chat.deepseek.com session token and device id from localStorage and
// forwards them to the native messaging host through the background worker.
(() => {
  const TOKEN_KEY = "userToken";
  const DEVICE_KEY = "deepseek-device-id:chat";
  const POLL_MS = 5_000;

  let lastToken = null;
  let lastDeviceId = null;
  let inFlight = false;

  function readValue(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw.trim() === "") return null;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "string") {
          return parsed.trim() || null;
        }
        if (parsed !== null && typeof parsed === "object" && typeof parsed.value === "string") {
          return parsed.value.trim() || null;
        }
      } catch {
        // Older or hand-written values may be the value itself.
      }
      return raw.trim();
    } catch {
      return null;
    }
  }

  function sync() {
    const token = readValue(TOKEN_KEY);
    if (token === null) {
      lastToken = null;
      lastDeviceId = null;
      return;
    }

    const deviceId = readValue(DEVICE_KEY);
    if (token === lastToken && deviceId === lastDeviceId) return;
    if (inFlight) return;

    inFlight = true;
    try {
      chrome.runtime.sendMessage(
        { type: "deepseek-token", token, deviceId: deviceId ?? undefined },
        (response) => {
          inFlight = false;
          if (chrome.runtime.lastError || response?.ok !== true) {
            lastToken = null;
            lastDeviceId = null;
            return;
          }
          lastToken = token;
          lastDeviceId = deviceId;
        },
      );
    } catch {
      inFlight = false;
      lastToken = null;
      lastDeviceId = null;
    }
  }

  sync();
  setInterval(sync, POLL_MS);
})();
