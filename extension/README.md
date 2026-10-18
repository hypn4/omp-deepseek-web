# DeepSeek Web Token Bridge

A Manifest V3 extension that forwards the `chat.deepseek.com` session token and
device id to omp through a Chrome native messaging host.

## Why

The DeepSeek web app stores its bearer token in `localStorage.userToken`. This
extension reads that value and sends it to a small native host on demand. The
host writes `~/.omp/agent/deepseek-web-token` and
`~/.omp/agent/.deepseek-web-device-id` with mode `0600`. There is no HTTP
listener, proxy process, Google OAuth redirect, custom URL scheme, or CDP.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `extension/` directory.
4. Copy the extension ID shown on its card.
5. Install the native host from the repository root:

   ```bash
   bun extension/install.ts --extension-id <extension-id>
   ```

   Add `--browser chromium|edge|brave` if you are not using Chrome.
6. Reload the extension (or restart Chrome) so it reconnects to the new host.
7. Open <https://chat.deepseek.com> and sign in normally.
8. Check that omp can see the token:

   ```bash
   omp --no-extensions -e omp-extension/index.ts \
     --model deepseek-web/deepseek-web -p "Reply with exactly: OK"
   ```

The content script polls localStorage every 5 seconds and sends only when the
token or device id changes. A failed send retries on the next tick. If the web
app rotates the token, the file is updated automatically.

## Status UI

The toolbar badge shows the last sync result:

- `✓` — the token was written to the omp native host.
- `…` — a sync is in progress.
- `!` — no token was found, or the native host reported an error.

Click the extension icon to open the popup. It shows the last sync time, whether
a device id is stored, the native host name, and a **Sync now** button. The popup
never displays the token value.

## Permissions

- `nativeMessaging` — send the token to the local host.
- `storage` — keep the last sync status for the popup badge.
- `activeTab` — let **Sync now** message the active chat.deepseek.com tab.
- The content script runs on `https://chat.deepseek.com/*` (declared in
  `content_scripts.matches`) and reads `localStorage.userToken` and
  `deepseek-device-id:chat`.

The token is never logged by the extension, the native host, or omp. The native
host only writes owner-only files; it does not open a network connection.
