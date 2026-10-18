import type { PowChallenge } from "./pow";

export interface DeepSeekConfig {
  baseUrl: string;
  token: string;
  deviceId: string;
  locale?: string;
  timezoneOffset?: string;
  clientVersion?: string;
  /** Client platform header; native Android is `android`, web is `web`. */
  platform?: string;
  /** Client bundle id header. */
  bundleId?: string;
  /** Device model header. */
  deviceModel?: string;
  /**
   * Shell command that prints a fresh token on stdout. Run once when the
   * device rotation does not produce a new token.
   */
  tokenCommand?: string;
}

export interface DeepSeekCompletionRequest {
  chatSessionId: string;
  prompt: string;
  parentMessageId?: number | null;
  modelType?: string;
  refFileIds?: string[];
  thinkingEnabled?: boolean;
  searchEnabled?: boolean;
  action?: string | null;
  preempt?: boolean;
}

export interface DeepSeekContinueRequest {
  chatSessionId: string;
  /** Assistant message id that was cut off. */
  messageId: number;
  /** Native clients set this so the server can resume the stream if needed. */
  fallbackToResume?: boolean;
}

export interface DeepSeekResumeRequest {
  chatSessionId: string;
  messageId: number;
  interactionType?: "Text" | "Call";
}

export interface DeepSeekUploadFile {
  data: Uint8Array;
  name: string;
  mimeType: string;
}

export interface WaitForFileOptions {
  /** Poll interval; defaults to 500 ms. */
  intervalMs?: number;
  /** Overall parse timeout; defaults to 60 s. */
  timeoutMs?: number;
}

/** The challenge object returned by `POST /api/v0/chat/create_pow_challenge`. */
export interface DeepSeekPowChallenge extends PowChallenge {
  algorithm: string;
  signature: string;
  target_path?: string;
  expire_after?: number;
}
