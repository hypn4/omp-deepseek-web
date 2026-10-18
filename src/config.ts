import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOKEN_PATH } from "./auth/token-store";
import type { DeepSeekCompletionRequest } from "./deepseek/types";

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOSTNAME = "127.0.0.1";
export const DEFAULT_BASE_URL = "https://chat.deepseek.com";
export const DEFAULT_MAX_PROMPT_CHARS = 400000;

/** Device id stored by the browser extension, reused when the env var is unset. */
export const DEFAULT_DEVICE_ID_PATH = join(
  homedir(),
  ".omp",
  "agent",
  ".deepseek-web-device-id",
);

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
  /** File the browser extension's token is written to. */
  tokenPath?: string;
  /** File the browser extension's device id is written to. */
  deviceIdPath?: string;
  maxPromptChars?: number;
  /** Default DeepThink setting for requests without tools. */
  thinking?: boolean;
  /** Default web-search setting. */
  search?: boolean;
  logLevel?: LogLevel;
  /** Shell command whose trimmed stdout is a fresh token after a 401. */
  tokenCommand?: string;
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

function readStoredDeviceId(path: string): string | undefined {
  try {
    const stored = readFileSync(path, "utf8").trim();
    return stored === "" ? undefined : stored;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
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
 * The proxy always binds to loopback. The device id comes from
 * `DEEPSEEK_WEB_DEVICE_ID`, then the file written by the browser extension, then
 * a fresh UUID per process.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: { deviceIdPath?: string; tokenPath?: string } = {},
): ServerConfig {
  const tokenCommand = env.DEEPSEEK_WEB_TOKEN_CMD?.trim();
  const configuredDeviceId = env.DEEPSEEK_WEB_DEVICE_ID?.trim();
  const deviceIdPath = options.deviceIdPath ?? DEFAULT_DEVICE_ID_PATH;
  const tokenPath = options.tokenPath ?? DEFAULT_TOKEN_PATH;
  const deviceId =
    configuredDeviceId !== undefined && configuredDeviceId !== ""
      ? configuredDeviceId
      : (readStoredDeviceId(deviceIdPath) ?? globalThis.crypto.randomUUID());
  return {
    port: readInteger(env.DEEPSEEK_WEB_PORT, DEFAULT_PORT),
    hostname: DEFAULT_HOSTNAME,
    baseUrl: env.DEEPSEEK_WEB_BASE_URL ?? DEFAULT_BASE_URL,
    deviceId,
    tokenPath,
    deviceIdPath,
    maxPromptChars: readPositiveInteger(
      env.DEEPSEEK_WEB_MAX_PROMPT_CHARS,
      DEFAULT_MAX_PROMPT_CHARS,
    ),
    thinking: readFlag(env.DEEPSEEK_WEB_THINKING),
    search: readFlag(env.DEEPSEEK_WEB_SEARCH),
    logLevel: readLogLevel(env.DEEPSEEK_WEB_LOG_LEVEL),
    tokenCommand:
      tokenCommand === undefined || tokenCommand === "" ? undefined : tokenCommand,
  };
}
