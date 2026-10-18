// Forwards the token from the content script to the local omp proxy. The token
// is only sent to loopback and is never logged.
const PROXY_URL = "http://127.0.0.1:8787/login/token";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message === null ||
    typeof message !== "object" ||
    message.type !== "deepseek-token" ||
    typeof message.token !== "string" ||
    message.token === ""
  ) {
    return false;
  }

  const body = { token: message.token };
  if (typeof message.deviceId === "string" && message.deviceId !== "") {
    body.deviceId = message.deviceId;
  }

  fetch(PROXY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((response) => sendResponse({ ok: response.ok, status: response.status }))
    .catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  return true;
});
