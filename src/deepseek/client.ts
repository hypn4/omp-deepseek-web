import { PowError, solvePow } from "./pow";
import { retryAfterFromHeaders } from "./rate-limit";
import type {
  DeepSeekCompletionRequest,
  DeepSeekConfig,
  DeepSeekContinueRequest,
  DeepSeekPowChallenge,
  DeepSeekResumeRequest,
  DeepSeekUploadFile,
  WaitForFileOptions,
} from "./types";

const COMPLETION_PATH = "/api/v0/chat/completion";
const CONTINUE_PATH = "/api/v0/chat/continue";
const RESUME_PATH = "/api/v0/chat/resume_stream";
const FILE_UPLOAD_PATH = "/api/v0/file/upload_file";
const FILE_FETCH_PATH = "/api/v0/file/fetch_files";
const CLIENT_BUNDLE_ID = "com.deepseek.chat";

interface DeepSeekEnvelope<T> {
  code?: number;
  msg?: string;
  data?: {
    biz_code?: number;
    biz_msg?: string;
    biz_data?: T;
  } | null;
}

/** Thrown when DeepSeek rejects the bearer token (biz code 40003 or HTTP 401). */
export class TokenError extends Error {
  constructor(message = "DeepSeek token is invalid or expired") {
    super(message);
    this.name = "TokenError";
  }
}

/** Thrown for any DeepSeek error that is neither an auth nor a PoW failure. */
export class DeepSeekApiError extends Error {
  /** DeepSeek `biz_code`, or -1 when the response was not a valid API envelope. */
  readonly code: number;
  readonly status?: number;

  constructor(code: number, message: string, status?: number) {
    super(message);
    this.name = "DeepSeekApiError";
    this.code = code;
    this.status = status;
  }
}

function apiError(code: number, message: string, status?: number): Error {
  if (code === 40003) {
    return new TokenError(message);
  }
  if (code === 40301 || code === 40300) {
    return new PowError(message);
  }
  return new DeepSeekApiError(code, message, status);
}

/** Bun and Node both reject a failed `fetch` with a `TypeError`. */
function isNetworkError(error: unknown): error is TypeError {
  return error instanceof TypeError;
}

function throwIfError(payload: DeepSeekEnvelope<unknown>, status: number): void {
  const topLevel = typeof payload.code === "number" ? payload.code : 0;
  const biz = payload.data;
  const bizCode = typeof biz?.biz_code === "number" ? biz.biz_code : 0;
  const code = topLevel !== 0 ? topLevel : bizCode;
  if (code !== 0) {
    throw apiError(
      code,
      biz?.biz_msg || payload.msg || `DeepSeek API error ${code}`,
      status,
    );
  }
}

/**
 * Client for the DeepSeek web chat API.
 *
 * Every request carries the browser client headers and the bearer token. The
 * completion endpoint requires a proof of work that is solved locally with the
 * vendored wasm.
 */
export class DeepSeekClient {
  readonly #baseUrl: string;
  #token: string;
  readonly #deviceId: string;
  readonly #locale: string;
  readonly #timezoneOffset: string;
  readonly #clientVersion: string;
  readonly #platform: string;
  readonly #bundleId: string;
  readonly #deviceModel: string;
  readonly #tokenCommand: string | undefined;
  #retryAfterMs: number | undefined;

  constructor(config: DeepSeekConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#token = config.token;
    this.#deviceId = config.deviceId;
    this.#locale = config.locale ?? "en_US";
    this.#timezoneOffset = config.timezoneOffset ?? "32400";
    this.#clientVersion = config.clientVersion ?? "2.5.0";
    this.#platform = config.platform ?? "web";
    this.#bundleId = config.bundleId ?? CLIENT_BUNDLE_ID;
    this.#deviceModel = config.deviceModel ?? "";
    this.#tokenCommand = config.tokenCommand;
  }

  async #request(
    path: string,
    init: RequestInit = {},
    token = this.#token,
    options: { json?: boolean } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (options.json !== false) {
      headers.set("content-type", "application/json");
    }
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-client-platform", this.#platform);
    headers.set("x-client-version", this.#clientVersion);
    headers.set("x-client-bundle-id", this.#bundleId);
    headers.set("x-client-locale", this.#locale);
    headers.set("x-client-timezone-offset", this.#timezoneOffset);
    headers.set("x-device-id", this.#deviceId);
    headers.set("x-device-model", this.#deviceModel);
    return fetch(`${this.#baseUrl}${path}`, { ...init, headers });
  }

  async #readEnvelope<T>(response: Response): Promise<T | undefined> {
    const text = await response.text();
    let payload: DeepSeekEnvelope<T>;
    try {
      payload = JSON.parse(text) as DeepSeekEnvelope<T>;
    } catch {
      if (response.status === 401) {
        throw new TokenError();
      }
      throw new DeepSeekApiError(
        -1,
        `DeepSeek returned an invalid JSON response (HTTP ${response.status})`,
        response.status,
      );
    }

    throwIfError(payload, response.status);
    if (!response.ok) {
      if (response.status === 401) {
        throw new TokenError();
      }
      throw new DeepSeekApiError(
        -1,
        `DeepSeek request failed (HTTP ${response.status})`,
        response.status,
      );
    }
    return payload.data?.biz_data;
  }

  /** Retry delay advertised by the last response, when present. */
  retryAfterMs(): number | undefined {
    return this.#retryAfterMs;
  }

  /** Reads an error body and always throws the mapped error. */
  async #throwResponseError(
    response: Response,
    fallback = `DeepSeek completion failed (HTTP ${response.status})`,
  ): Promise<never> {
    const text = await response.text();
    let payload: DeepSeekEnvelope<unknown> | undefined;
    try {
      payload = JSON.parse(text) as DeepSeekEnvelope<unknown>;
    } catch {
      payload = undefined;
    }

    if (payload !== undefined) {
      throwIfError(payload, response.status);
    }
    if (response.status === 401) {
      throw new TokenError();
    }
    throw new DeepSeekApiError(-1, fallback, response.status);
  }

  /**
   * Runs an upstream operation, retrying exactly once after a recoverable
   * failure: an auth failure recovers the token, a PoW or network failure just
   * runs the operation again (the challenge is fetched inside the operation).
   */
  async #withRetry<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (error instanceof TokenError) {
        await this.#recoverToken(error);
        return operation();
      }
      if (error instanceof PowError || isNetworkError(error)) {
        return operation();
      }
      throw error;
    }
  }

  /**
   * Recovers from an auth failure via `check_device` rotation, falling back to
   * `tokenCommand`. Throws the original `TokenError` when neither works.
   */
  async #recoverToken(original: TokenError): Promise<void> {
    try {
      const result = await this.checkDevice(this.#token, this.#deviceId);
      if (result.rotated) {
        this.#token = result.token;
        return;
      }
    } catch (error) {
      if (!(error instanceof TokenError) && !isNetworkError(error)) {
        throw error;
      }
    }

    if (this.#tokenCommand !== undefined) {
      const token = await this.#runTokenCommand(this.#tokenCommand);
      if (token !== "") {
        this.#token = token;
        return;
      }
    }
    throw original;
  }

  /** Runs the token command and returns its trimmed stdout (never logged). */
  async #runTokenCommand(command: string): Promise<string> {
    const child = Bun.spawn(["sh", "-c", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return exitCode === 0 ? stdout.trim() : "";
  }

  async createSession(): Promise<string> {
    return this.#withRetry(() => this.#createSessionOnce());
  }

  async #createSessionOnce(): Promise<string> {
    const response = await this.#request("/api/v0/chat_session/create", {
      method: "POST",
      body: "{}",
    });
    const data = await this.#readEnvelope<{ chat_session?: { id?: string } }>(response);
    const id = data?.chat_session?.id;
    if (typeof id !== "string" || id === "") {
      throw new DeepSeekApiError(
        -1,
        "DeepSeek did not return a chat session id",
        response.status,
      );
    }
    return id;
  }

  async deleteSession(id: string): Promise<void> {
    const response = await this.#request("/api/v0/chat_session/delete", {
      method: "POST",
      body: JSON.stringify({ chat_session_ids: [id] }),
    });
    await this.#readEnvelope<unknown>(response);
  }

  async createChallenge(targetPath: string): Promise<DeepSeekPowChallenge> {
    const response = await this.#request("/api/v0/chat/create_pow_challenge", {
      method: "POST",
      body: JSON.stringify({ target_path: targetPath }),
    });
    const data = await this.#readEnvelope<{ challenge?: DeepSeekPowChallenge }>(response);
    const challenge = data?.challenge;
    if (
      challenge === undefined ||
      typeof challenge.challenge !== "string" ||
      typeof challenge.salt !== "string" ||
      typeof challenge.algorithm !== "string" ||
      typeof challenge.signature !== "string" ||
      typeof challenge.difficulty !== "number" ||
      typeof challenge.expire_at !== "number"
    ) {
      throw new DeepSeekApiError(
        -1,
        "DeepSeek did not return a valid PoW challenge",
        response.status,
      );
    }
    return challenge;
  }

  #powHeader(
    challenge: DeepSeekPowChallenge,
    targetPath: string,
  ): string {
    const answer = solvePow(challenge);
    return btoa(
      JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer,
        signature: challenge.signature,
        target_path: challenge.target_path ?? targetPath,
      }),
    );
  }

  async complete(
    req: DeepSeekCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#withRetry(() => this.#completeOnce(req, signal), signal);
  }

  async #completeOnce(
    req: DeepSeekCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const challenge = await this.createChallenge(COMPLETION_PATH);
    return this.#streamRequest(
      COMPLETION_PATH,
      {
        method: "POST",
        body: JSON.stringify({
          chat_session_id: req.chatSessionId,
          parent_message_id: req.parentMessageId ?? null,
          model_type: req.modelType ?? "default",
          prompt: req.prompt,
          ref_file_ids: req.refFileIds ?? [],
          thinking_enabled: req.thinkingEnabled ?? false,
          search_enabled: req.searchEnabled ?? false,
          action: req.action ?? null,
          preempt: req.preempt ?? false,
        }),
        headers: { "x-ds-pow-response": this.#powHeader(challenge, COMPLETION_PATH) },
        signal,
      },
      signal,
    );
  }

  /**
   * Native continuation endpoint (`/api/v0/chat/continue`). The request names
   * the cut-off assistant message, not the next user prompt; the server appends
   * the missing output to that message.
   */
  async continueCompletion(
    req: DeepSeekContinueRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#withRetry(() => this.#continueOnce(req, signal), signal);
  }

  async #continueOnce(
    req: DeepSeekContinueRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    // The native contract does not mint a PoW challenge for continue; the
    // request names an existing assistant message instead.
    return this.#streamRequest(
      CONTINUE_PATH,
      {
        method: "POST",
        body: JSON.stringify({
          chat_session_id: req.chatSessionId,
          message_id: req.messageId,
          fallback_to_resume: req.fallbackToResume ?? true,
        }),
        signal,
      },
      signal,
    );
  }

  /**
   * Native stream-resume endpoint. Unlike continue, this does not mint a PoW
   * challenge; it reattaches to an in-flight assistant message.
   */
  async resumeStream(
    req: DeepSeekResumeRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#withRetry(() => this.#resumeOnce(req, signal), signal);
  }

  async #resumeOnce(
    req: DeepSeekResumeRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#streamRequest(
      RESUME_PATH,
      {
        method: "POST",
        body: JSON.stringify({
          chat_session_id: req.chatSessionId,
          message_id: req.messageId,
          interaction_type: req.interactionType ?? "Text",
        }),
        signal,
      },
      signal,
    );
  }

  async #streamRequest(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#request(path, { ...init, signal });
    this.#retryAfterMs = retryAfterFromHeaders(response.headers);
    if (!response.ok) {
      await this.#throwResponseError(response);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream")) {
      await this.#throwResponseError(
        response,
        `DeepSeek returned a non-stream response (HTTP ${response.status})`,
      );
    }
    if (response.body === null) {
      throw new DeepSeekApiError(
        -1,
        "DeepSeek returned an empty stream",
        response.status,
      );
    }
    return response.body;
  }

  async uploadFile(file: DeepSeekUploadFile): Promise<string> {
    return this.#withRetry(() => this.#uploadFileOnce(file));
  }

  async #uploadFileOnce(file: DeepSeekUploadFile): Promise<string> {
    const challenge = await this.createChallenge(FILE_UPLOAD_PATH);
    const powHeader = this.#powHeader(challenge, FILE_UPLOAD_PATH);
    const form = new FormData();
    form.append(
      "file",
      new Blob([file.data], { type: file.mimeType }),
      file.name,
    );
    const response = await this.#request(
      FILE_UPLOAD_PATH,
      {
        method: "POST",
        body: form,
        headers: {
          "x-ds-pow-response": powHeader,
          "x-file-size": String(file.data.byteLength),
        },
      },
      this.#token,
      { json: false },
    );
    const data = await this.#readEnvelope<{ id?: string; status?: string }>(
      response,
    );
    const id = data?.id;
    if (typeof id !== "string" || id === "") {
      throw new DeepSeekApiError(
        -1,
        "DeepSeek did not return an uploaded file id",
        response.status,
      );
    }
    return id;
  }

  async waitForFileReady(
    id: string,
    signal?: AbortSignal,
    options: WaitForFileOptions = {},
  ): Promise<void> {
    const intervalMs = options.intervalMs ?? 500;
    const timeoutMs = options.timeoutMs ?? 60_000;
    return this.#withRetry(
      () => this.#waitForFileReadyOnce(id, intervalMs, timeoutMs, signal),
      signal,
    );
  }

  async #waitForFileReadyOnce(
    id: string,
    intervalMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const response = await this.#request(
        `${FILE_FETCH_PATH}?file_ids=${encodeURIComponent(id)}`,
        { method: "GET", signal },
      );
      const data = await this.#readEnvelope<{
        files?: Array<{
          id?: string;
          status?: string;
          error_code?: string | null;
        }>;
      }>(response);
      const file = data?.files?.find((entry) => entry.id === id);
      if (file === undefined) {
        throw new DeepSeekApiError(
          -1,
          "DeepSeek did not return the uploaded file status",
          response.status,
        );
      }
      if (file.status === "SUCCESS") {
        return;
      }
      if (file.status === "FAILED") {
        throw new DeepSeekApiError(
          -1,
          `DeepSeek could not parse the uploaded image${
            file.error_code === null || file.error_code === undefined
              ? ""
              : ` (${file.error_code})`
          }`,
          response.status,
        );
      }
      if (Date.now() >= deadline) {
        throw new DeepSeekApiError(
          -1,
          "DeepSeek image parsing timed out",
          504,
        );
      }
      await this.#sleep(intervalMs, signal);
    }
  }

  async #sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds <= 0) {
      return;
    }
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async checkDevice(
    token: string,
    deviceId: string,
  ): Promise<{ token: string; rotated: boolean }> {
    const response = await this.#request(
      "/api/v0/users/auth_token/check_device",
      {
        method: "POST",
        body: JSON.stringify({ device_id: deviceId, device_model: "" }),
      },
      token,
    );
    const data = await this.#readEnvelope<{
      rotate?: boolean | null;
      data?: { token?: string } | null;
    }>(response);

    if (data?.rotate === true) {
      const rotatedToken = data.data?.token;
      if (typeof rotatedToken !== "string" || rotatedToken === "") {
        throw new DeepSeekApiError(
          -1,
          "DeepSeek reported a token rotation without a new token",
          response.status,
        );
      }
      return { token: rotatedToken, rotated: true };
    }
    return { token, rotated: false };
  }
}
