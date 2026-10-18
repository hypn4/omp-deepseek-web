import { PowError, solvePow } from "./pow";
import type {
  DeepSeekCompletionRequest,
  DeepSeekConfig,
  DeepSeekPowChallenge,
} from "./types";

const COMPLETION_PATH = "/api/v0/chat/completion";
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
  readonly #tokenCommand: string | undefined;

  constructor(config: DeepSeekConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#token = config.token;
    this.#deviceId = config.deviceId;
    this.#locale = config.locale ?? "en_US";
    this.#timezoneOffset = config.timezoneOffset ?? "32400";
    this.#clientVersion = config.clientVersion ?? "2.5.0";
    this.#tokenCommand = config.tokenCommand;
  }

  async #request(
    path: string,
    init: RequestInit = {},
    token = this.#token,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("content-type", "application/json");
    headers.set("x-client-platform", "web");
    headers.set("x-client-version", this.#clientVersion);
    headers.set("x-client-bundle-id", CLIENT_BUNDLE_ID);
    headers.set("x-client-locale", this.#locale);
    headers.set("x-client-timezone-offset", this.#timezoneOffset);
    headers.set("x-device-id", this.#deviceId);
    headers.set("x-device-model", "");
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

  /** Reads an error body and always throws the mapped error. */
  async #throwResponseError(response: Response): Promise<never> {
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
    throw new DeepSeekApiError(
      -1,
      `DeepSeek completion failed (HTTP ${response.status})`,
      response.status,
    );
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
    const answer = solvePow(challenge);
    const powHeader = btoa(
      JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer,
        signature: challenge.signature,
        target_path: challenge.target_path ?? COMPLETION_PATH,
      }),
    );

    const response = await this.#request(COMPLETION_PATH, {
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
      headers: { "x-ds-pow-response": powHeader },
      signal,
    });

    if (!response.ok) {
      await this.#throwResponseError(response);
    }
    if (response.body === null) {
      throw new DeepSeekApiError(
        -1,
        "DeepSeek returned an empty completion stream",
        response.status,
      );
    }
    return response.body;
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
