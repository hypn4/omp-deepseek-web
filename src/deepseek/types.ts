import type { PowChallenge } from "./pow";

export interface DeepSeekConfig {
  baseUrl: string;
  token: string;
  deviceId: string;
  locale?: string;
  timezoneOffset?: string;
  clientVersion?: string;
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

/** The challenge object returned by `POST /api/v0/chat/create_pow_challenge`. */
export interface DeepSeekPowChallenge extends PowChallenge {
  algorithm: string;
  signature: string;
  target_path?: string;
  expire_after?: number;
}
