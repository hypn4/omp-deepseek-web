# DeepSeek Web Token Bridge

A tiny Manifest V3 extension that forwards the `chat.deepseek.com` session token
to the local `deepseek-web` proxy.

## Why

The DeepSeek web app stores its bearer token in `localStorage.userToken`. This
extension reads that value and posts it to `http://127.0.0.1:8787/login/token`.
The proxy keeps it in `~/.omp/agent/deepseek-web-token` with mode `0600` and uses
it for upstream requests. No Google OAuth redirect, custom URL scheme, or CDP is
involved.

## Install

1. Start the proxy: `bun run start` (from the repository root).
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this `extension/` directory.
5. Open <https://chat.deepseek.com> and sign in normally.
6. Check that the proxy received the token:

   ```bash
   curl -s http://127.0.0.1:8787/login/status
   # {"hasToken":true}
   ```

The content script polls every 5 seconds and re-sends the token when it changes
or every 30 seconds as a heartbeat. If the web app rotates the token, the proxy
is updated automatically.

## Permissions

- `https://chat.deepseek.com/*` — read `localStorage.userToken` and
  `deepseek-device-id:chat`.
- `http://127.0.0.1:8787/*` — POST the token to the local proxy.

The token is only sent to loopback. It is never logged by the extension or the
proxy. The proxy stores it with owner-only permissions.
