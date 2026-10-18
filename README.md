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

```bash
bun run login --write-env
```

The helper:

1. Reuses or creates a device id (stored in `~/.omp/agent/.deepseek-web-device-id`).
2. Opens the DeepSeek Google authorize URL in your browser and prints it to stderr.
3. Prompts for the final redirect URL. After approving Google sign-in, the browser
   lands on a `com.deepseek.chat://authorized_android?nonce=...&code=...` URL.
   Copy the whole URL from the address bar and paste it at the prompt.
   If the browser blocks the custom scheme, copy the same request from the
   DevTools Network tab.
4. Exchanges the nonce through `/api/v0/users/oauth/get_token`.
5. Writes `DEEPSEEK_WEB_TOKEN` and `DEEPSEEK_WEB_DEVICE_ID` to
   `~/.omp/agent/.env` (mode `0600`), preserving unrelated lines.

`bun run login` on its own refuses to run: it requires `--print-token` **or**
`--write-env` so the token is never printed by accident. Use
`--print-token` only when a parent process should capture stdout. A non-interactive
redirect can be supplied with `--redirect-url '<com.deepseek.chat://...>'`.

Tokens expire or rotate. If the proxy starts returning 401, run `bun run login
--write-env` again. The proxy also queries `auth_token/check_device` on auth errors
and uses the rotated token when DeepSeek supplies one.

## Start the proxy

```bash
bun run start
```

It listens on `http://127.0.0.1:8787` only. The token is not read from the
environment by the proxy: omp sends it as `Authorization: Bearer <token>` on every
request, and the proxy forwards it upstream. Do not open the port to the network.

Quick check:

```bash
set -a; . ~/.omp/agent/.env; set +a
curl -s http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $DEEPSEEK_WEB_TOKEN"
```

## Configure omp

Copy the block from [`models.example.yml`](./models.example.yml) into
`~/.omp/agent/models.yml` (merge it under the existing `providers:` key; do not
replace that file's other providers), and replace `/abs/path` with the absolute
path to this repository:

```yaml
providers:
  deepseek-web:
    baseUrl: http://127.0.0.1:8787/v1
    api: openai-completions
    apiKey: "!bun run /abs/path/scripts/login.ts --print-token"
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

If you ran `bun run login --write-env`, the simpler configuration points at the
environment variable instead of running the login helper:

```yaml
    apiKey: DEEPSEEK_WEB_TOKEN
```

`omp` loads `~/.omp/agent/.env` automatically. The `!` command form exists for the
case where the token is fetched by a non-interactive helper; the bundled login
helper is interactive, so prefer the environment-variable form for day-to-day use.

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
| `DEEPSEEK_WEB_TOKEN` | — | Web token; referenced by `models.yml`, not read by the proxy |
| `DEEPSEEK_WEB_DEVICE_ID` | generated UUID | Stable `x-device-id`; written by `bun run login` |
| `DEEPSEEK_WEB_THINKING` | `0` | `1` enables DeepThink for requests without tools |
| `DEEPSEEK_WEB_SEARCH` | `0` | `1` enables web search |
| `DEEPSEEK_WEB_TOKEN_CMD` | — | Command whose stdout is a fresh token after a 401 |
| `DEEPSEEK_WEB_MAX_PROMPT_CHARS` | `400000` | Prompt length cap |
| `DEEPSEEK_WEB_LOG_LEVEL` | `info` | `debug` adds stream-error detail; prompts and tokens are never logged |

A device id generated at process start differs from the one saved by `bun run
login`; export `DEEPSEEK_WEB_DEVICE_ID` (as `.env` does for omp) if DeepSeek's
token checks are strict about it.

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
- **Loopback only.** The proxy binds `127.0.0.1`. Every chat completion request
  must carry a bearer token, but the proxy only validates it upstream; anyone who
  can reach the port and holds the token can spend your account quota. Never
  expose it through a tunnel or reverse proxy.
- **No token logging.** Tokens are bearer credentials; the proxy never logs the
  `Authorization` header, prompt text, or token values, including at `debug` level.
  Avoid `--print-token` in shared terminals and review logs before sharing them.
- **Streaming is buffered.** The proxy collects the full upstream response before
  emitting chunks; tokens do not appear incrementally. `stream: false` is also
  supported.
- **Usage is approximate.** Token counts come from `accumulated_token_usage` and
  are not billing-exact. `contextWindow: 128000` is an estimate.
- **Single account.** On an auth error the proxy checks `auth_token/check_device`
  and adopts a rotated token when DeepSeek supplies one, and
  `DEEPSEEK_WEB_TOKEN_CMD` can fetch a fresh token, but there is no multi-account
  rotation. An expired token otherwise requires `bun run login --write-env`.

## Vendored PoW solver

`vendor/sha3_wasm_bg.wasm` is required to solve DeepSeek's `DeepSeekHashV1`
challenge.

- Source: `https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm`
- Size: 26,612 bytes
- SHA-256: `b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d`

The file is checked in because the proxy loads it from disk at startup instead of
fetching it at runtime. If DeepSeek rotates the asset, verify the new file's hash
and update this section.
