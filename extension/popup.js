// Reads the last sync status; no token value is ever stored in the popup.
const STATUS_KEY = "deepseekWebStatus";
const CHAT_URL = "https://chat.deepseek.com/";

const stateDot = document.getElementById("state-dot");
const message = document.getElementById("message");
const lastSync = document.getElementById("last-sync");
const device = document.getElementById("device");
const host = document.getElementById("host");
const syncButton = document.getElementById("sync");
const openButton = document.getElementById("open");

function formatTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function render(status) {
  const state = status?.state ?? "idle";
  stateDot.className = `dot ${state}`;
  stateDot.title = status?.message ?? "No sync yet";
  message.textContent =
    status?.message ?? "No sync yet. Open chat.deepseek.com and sign in.";
  lastSync.textContent = formatTime(status?.lastSync ?? status?.updatedAt);
  device.textContent = status?.deviceIdPresent
    ? "Stored"
    : status?.tokenPresent
      ? "Not sent"
      : "—";
  host.textContent = "com.whales.deepseek_web";
  syncButton.textContent = state === "syncing" ? "Syncing…" : "Sync now";
  syncButton.disabled = state === "syncing";
}

function load() {
  chrome.storage.local.get(STATUS_KEY, (value) => {
    render(value?.[STATUS_KEY]);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || changes[STATUS_KEY] === undefined) return;
  render(changes[STATUS_KEY].newValue);
});

syncButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || typeof tab.url !== "string" || !tab.url.startsWith(CHAT_URL)) {
    await chrome.tabs.create({ url: CHAT_URL });
    window.close();
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "deepseek-sync-now" });
  } catch {
    // The content script may not be ready yet; the polling loop will retry.
  }
});

openButton.addEventListener("click", () => {
  chrome.tabs.create({ url: CHAT_URL });
});

load();
