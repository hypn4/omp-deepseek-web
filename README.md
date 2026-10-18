# deepseek-web

An OpenAI-compatible proxy that exposes a free `chat.deepseek.com` web account to
[omp](https://github.com/can1357/oh-my-pi) as a custom provider:

```
omp  ──/v1/chat/completions──▶  127.0.0.1:8787  ──web API + PoW──▶  chat.deepseek.com
     ◀──content / tool_calls──                ◀──SSE patches──
```

The proxy converts DeepSeek's SSE stream to OpenAI Chat Completions chunks and
bridges text-format tool calls (DSML and V3.1) to OpenAI `tool_calls`, so omp can
run `read`, `edit`, `bash`, and the rest of its tools.

The DeepSeek web API is **unofficial and may change without notice**. Treat this
as a personal convenience, not a supported API.

## Requirements

- [Bun](https://bun.sh) 1.x (the only runtime; there are no npm dependencies)
- `omp` 18.x
- A free DeepSeek chat account that can sign in with Google
- Chrome or another Chromium browser for the token-bridge extension

## Install

```bash
git clone <this-repo> deepseek-web
cd deepseek-web
bun install
```

There are no runtime dependencies: the proxy uses Bun built-ins (`fetch`,
`crypto`, `WebAssembly`). `bun install` creates/validates the lockfile and is
safe to run for consistency.

## Log in

The login path is a small Chrome extension. It reads the token that the DeepSeek
web app already stores in `localStorage.userToken` and posts it to the local
proxy. There is no Google OAuth redirect, custom URL scheme, or CDP.

1. Start the proxy:

   ```bash
   bun run start
   ```

2. Load the extension: open `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, and select the `extension/` directory.

3. Open <https://chat.deepseek.com> and sign in normally.

4. The content script sends `localStorage.userToken` and
   `deepseek-device-id:chat` to `http://127.0.0.1:8787/login/token` through the
   extension's background worker. The proxy writes the token to
   `~/.omp/agent/deepseek-web-token` with mode `0600`.

5. Verify:

   ```bash
   curl -s http://127.0.0.1:8787/login/status
   # {"hasToken":true}
   ```

The content script polls every 5 seconds and re-sends when the token changes, or
every 30 seconds as a heartbeat. If the web app rotates the token, the proxy is
updated automatically. If the token check fails, reload the extension or start
the proxy again.

The extension only sends the token to loopback and never logs it. The proxy never
logs the token, prompt, or `Authorization` header.

## Start the proxy

```bash
bun run start
```

It listens on `http://127.0.0.1:8787` only. The proxy uses the stored token for
DeepSeek; omp's `apiKey` is a dummy value. Do not open the port to the network.

Quick check:

```bash
curl -s http://127.0.0.1:8787/v1/models
curl -s http://127.0.0.1:8787/login/status
```

## Configure omp

Copy the block from [`models.example.yml`](./models.example.yml) into
`~/.omp/agent/models.yml` (merge it under the existing `providers:` key; do not
replace that file's other providers):

```yaml
providers:
  deepseek-web:
    baseUrl: http://127.0.0.1:8787/v1
    api: openai-completions
    apiKey: local
    authHeader: true
    models:
      - id: deepseek-web
        name: DeepSeek Web (free)
        reasoning: false
        input: [text]
        supportsTools: true
        contextWindow: 128000
        maxTokens: 8192
        compat:
          supportsToolChoice: false
          supportsStrictMode: false
          supportsDeveloperRole: false
```

`models.example.yml` is not an active models file, so `omp models find deepseek-web`
finds nothing until you copy the block into the active file.

`apiKey: local` is a dummy credential so omp selects the provider. The proxy
ignores it: when `~/.omp/agent/deepseek-web-token` exists, that token is used for
DeepSeek.

Verify:

```bash
omp models find deepseek-web
omp --model deepseek-web/deepseek-web
```

Then try "Read package.json and summarize it": the `read` tool card should appear
and the model should produce a summary. If the model answers without calling a
tool, see limitations below.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEEPSEEK_WEB_PORT` | `8787` | Proxy port |
| `DEEPSEEK_WEB_BASE_URL` | `https://chat.deepseek.com` | Upstream web API base URL |
| `DEEPSEEK_WEB_DEVICE_ID` | extension value | Stable `x-device-id`; usually written by the extension |
| `DEEPSEEK_WEB_THINKING` | `0` | `1` enables DeepThink for requests without tools |
| `DEEPSEEK_WEB_SEARCH` | `0` | `1` enables web search |
| `DEEPSEEK_WEB_MAX_PROMPT_CHARS` | `400000` | Prompt length cap |
| `DEEPSEEK_WEB_LOG_LEVEL` | `info` | `debug` adds stream-error detail; prompts and tokens are never logged |
| `DEEPSEEK_WEB_TOKEN_CMD` | — | Advanced: command whose stdout is a fresh token after a 401 |

If you change `DEEPSEEK_WEB_PORT`, update `PROXY_URL` in
`extension/background.js` and the loopback host permission in
`extension/manifest.json` to match. They are intentionally fixed to the default
port.

The token and device id are stored in `~/.omp/agent/deepseek-web-token` and
`~/.omp/agent/.deepseek-web-device-id` with mode `0600`. The proxy reads them at
startup and after every extension POST.

## Known limitations

- **Sampling parameters are ignored.** The web API accepts no `temperature`,
  `top_p`, `max_tokens`, `stop`, or `tool_choice`. Requests still succeed, but
  those fields have no effect.
- **Tool-call format risk.** DeepSeek web has no native tool calling. The proxy
  prompts the model to emit DSML (with a V3.1 fallback parser); the hidden web
  system prompt or a model update can break that convention. Malformed blocks are
  returned as text rather than fabricated `tool_calls`. Tool calling only works
  with thinking disabled.
- **Unofficial protocol and ToS.** Automated use of free web chat may violate
  DeepSeek's terms or hit rate limits, and endpoints/PoW may change at any time.
  Use at your own risk and with your own account.
- **Loopback only.** The proxy binds `127.0.0.1`. Every completion request must
  carry a bearer token, but the proxy uses the stored token; anyone who can reach
  the port can spend your account quota. Never expose it through a tunnel or
  reverse proxy.
- **No token logging.** Tokens are bearer credentials; the proxy never logs the
  `Authorization` header, prompt text, or token values, including at `debug` level.
- **Extension dependency.** The token is read from the web app's
  `localStorage.userToken` key. If DeepSeek changes that key or the page storage
  layout, update `extension/content.js`. The proxy stores one token; there is no
  multi-account rotation.
- **Streaming is buffered.** The proxy collects the full upstream response before
  emitting chunks; tokens do not appear incrementally. `stream: false` is also
  supported.
- **Usage is not reported.** The proxy emits no OpenAI `usage` object;
  `contextWindow: 128000` is an estimate.
- **Single account.** The proxy checks `auth_token/check_device` on auth errors and
  adopts a rotated token when DeepSeek supplies one; the extension also re-posts
  a token when the web app rotates it. There is no multi-account rotation.

## Vendored PoW solver

`vendor/sha3_wasm_bg.wasm` is required to solve DeepSeek's `DeepSeekHashV1`
challenge.

- Source: `https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm`
- Size: 26,612 bytes
- SHA-256: `b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d`

The file is checked in because the proxy loads it from disk at startup instead of
fetching it at runtime. If DeepSeek rotates the asset, verify the new file's hash
and update this section.
