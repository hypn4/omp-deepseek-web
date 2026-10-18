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

The extension ID is pinned in `manifest.json`, so you do not need to copy it.

1. Install the native host from the repository root:

   ```bash
   bun extension/install.ts
   ```

   Add `--browser chromium|edge|brave` if you are not using Chrome.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this `extension/` directory.
5. Open <https://chat.deepseek.com> and sign in normally.
6. Check that omp can see the token:

   ```bash
   omp --no-extensions -e omp-extension/index.ts \
     --model deepseek-web/deepseek-web -p "Reply with exactly: OK"
   ```

If you build a custom extension with a different key, pass
`--extension-id <id>` to the installer instead.

The content script polls localStorage every 5 seconds and sends only when the
token or device id changes. A failed send retries on the next tick. If the web
app rotates the token, the file is updated automatically.

## Status UI

The toolbar badge shows the last sync result:

- `✓` — the token was written to the omp native host.
- `…` — a sync is in progress.
- `!` — no token was found, or the native host reported an error.

The toolbar icon is the color whale while connected/syncing and the grayscale
whale when the token is missing or the host errors. Click the extension icon to
open the popup. It shows the last sync time, whether a device id is stored, the
native host name, and a **Sync now** button. The popup never displays the token
value.

## Icons

- `icons/deepseek-web-{16,32,48,128}.png` — color DeepSeek whale with Pi badge.
- `icons/deepseek-web-mono-{16,32,48,128}.png` — grayscale variant for the
  missing-token/error state.
- Source assets: `assets/deepseek-whale-pi-color.png` and
  `assets/deepseek-whale-pi-mono.png`.

The DeepSeek and Pi marks belong to their respective owners. See the repository
[NOTICE](../NOTICE) for the trademark disclaimer.

## Permissions

- `nativeMessaging` — send the token to the local host.
- `storage` — keep the last sync status for the popup badge.
- `activeTab` — let **Sync now** message the active chat.deepseek.com tab.
- The content script runs on `https://chat.deepseek.com/*` (declared in
  `content_scripts.matches`) and reads `localStorage.userToken` and
  `deepseek-device-id:chat`.

The token is never logged by the extension, the native host, or omp. The native
host only writes owner-only files; it does not open a network connection.
