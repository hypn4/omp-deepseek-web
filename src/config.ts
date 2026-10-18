import type { DeepSeekCompletionRequest } from "./deepseek/types";

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOSTNAME = "127.0.0.1";
export const DEFAULT_BASE_URL = "https://chat.deepseek.com";
export const DEFAULT_MAX_PROMPT_CHARS = 400000;

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * The subset of `DeepSeekClient` the server needs. Declaring it here lets tests
 * inject a fake client without reaching the network.
 */
export interface CompletionClient {
  createSession(): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
  complete(
    request: DeepSeekCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
}

export interface ServerConfig {
  /** Bind port; `0` picks an ephemeral port (useful in tests). */
  port?: number;
  /** Bind address. Defaults to loopback only. */
  hostname?: string;
  baseUrl?: string;
  deviceId?: string;
  maxPromptChars?: number;
  /** Default DeepThink setting for requests without tools. */
  thinking?: boolean;
  /** Default web-search setting. */
  search?: boolean;
  logLevel?: LogLevel;
  /** Injected client factory; defaults to a real `DeepSeekClient` per token. */
  createClient?: (token: string) => CompletionClient;
}

function readInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : fallback;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function readLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

/**
 * Reads the proxy configuration from environment variables.
 *
 * The proxy always binds to loopback. The device id defaults to a fresh UUID
 * per process; set `DEEPSEEK_WEB_DEVICE_ID` to keep it stable across restarts.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  return {
    port: readInteger(env.DEEPSEEK_WEB_PORT, DEFAULT_PORT),
    hostname: DEFAULT_HOSTNAME,
    baseUrl: env.DEEPSEEK_WEB_BASE_URL ?? DEFAULT_BASE_URL,
    deviceId: env.DEEPSEEK_WEB_DEVICE_ID ?? globalThis.crypto.randomUUID(),
    maxPromptChars: readPositiveInteger(
      env.DEEPSEEK_WEB_MAX_PROMPT_CHARS,
      DEFAULT_MAX_PROMPT_CHARS,
    ),
    thinking: readFlag(env.DEEPSEEK_WEB_THINKING),
    search: readFlag(env.DEEPSEEK_WEB_SEARCH),
    logLevel: readLogLevel(env.DEEPSEEK_WEB_LOG_LEVEL),
  };
}
