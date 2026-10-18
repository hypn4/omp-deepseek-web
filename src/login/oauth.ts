import { DEFAULT_BASE_URL } from "../config";

const AUTHORIZE_PATH = "/api/v0/users/oauth/google/authorize";
const GET_TOKEN_PATH = "/api/v0/users/oauth/get_token";
const REDIRECT_HOST = "authorized_android";
const REDIRECT_PROTOCOL = "com.deepseek.chat:";
const CLIENT_BUNDLE_ID = "com.deepseek.chat";

interface TokenEnvelope {
  code?: number;
  msg?: string;
  data?: {
    token?: unknown;
    biz_code?: number;
    biz_msg?: string;
    biz_data?: { token?: unknown } | null;
  } | null;
}

/**
 * Thrown for OAuth login failures. `code` is the `code` query parameter from
 * the `com.deepseek.chat://authorized_android` redirect when it is non-zero.
 */
export class LoginError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "LoginError";
    this.code = code;
  }
}

/** Builds the DeepSeek Android endpoint that redirects to Google consent. */
export function buildAuthorizeUrl(deviceId: string): string {
  const url = new URL(`${DEFAULT_BASE_URL}${AUTHORIZE_PATH}`);
  url.searchParams.set("os", "android");
  url.searchParams.set("device_id", deviceId);
  return url.toString();
}

/** Reads the nonce from the custom-scheme redirect, rejecting failed logins. */
export function parseOAuthRedirect(url: string): { nonce: string; code: number } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LoginError(`Invalid redirect URL: ${url}`);
  }

  if (parsed.protocol !== REDIRECT_PROTOCOL || parsed.host !== REDIRECT_HOST) {
    throw new LoginError(
      `Unexpected redirect URL; expected ${REDIRECT_PROTOCOL}//${REDIRECT_HOST}`,
    );
  }

  const nonce = parsed.searchParams.get("nonce")?.trim() ?? "";
  if (nonce === "") {
    throw new LoginError("Redirect URL is missing the nonce parameter");
  }

  const rawCode = parsed.searchParams.get("code");
  if (rawCode === null || !/^-?\d+$/.test(rawCode)) {
    throw new LoginError("Redirect URL is missing a valid code parameter");
  }

  const code = Number.parseInt(rawCode, 10);
  if (code !== 0) {
    throw new LoginError(`Google login failed with code ${code}`, code);
  }

  return { nonce, code };
}

function extractToken(payload: TokenEnvelope | undefined): string | undefined {
  const direct = payload?.data?.token;
  if (typeof direct === "string" && direct !== "") {
    return direct;
  }
  const nested = payload?.data?.biz_data?.token;
  return typeof nested === "string" && nested !== "" ? nested : undefined;
}

function describeFailure(
  payload: TokenEnvelope | undefined,
  status: number,
): string {
  const code = payload?.data?.biz_code ?? payload?.code;
  const message =
    payload?.data?.biz_msg ||
    payload?.msg ||
    (status >= 400 ? `HTTP ${status}` : "response did not contain a token");
  return code === undefined || code === 0 ? message : `${message} (code ${code})`;
}

/**
 * Exchanges the redirect nonce for a bearer token.
 *
 * The web flow needs the browser client headers but no proof of work: GuestPow
 * is only used by the Google ID token endpoint.
 */
export async function exchangeNonce(
  deviceId: string,
  nonce: string,
): Promise<string> {
  const headers = new Headers({
    "content-type": "application/json",
    "x-client-platform": "web",
    "x-client-version": "2.5.0",
    "x-client-bundle-id": CLIENT_BUNDLE_ID,
    "x-client-locale": "en_US",
    "x-client-timezone-offset": "32400",
    "x-device-id": deviceId,
    "x-device-model": "",
  });

  let response: Response;
  try {
    response = await fetch(`${DEFAULT_BASE_URL}${GET_TOKEN_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        device_id: deviceId,
        nonce,
        os: "android",
        provider: "google",
      }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LoginError(`Token exchange request failed: ${reason}`);
  }

  let payload: TokenEnvelope | undefined;
  try {
    payload = (await response.json()) as TokenEnvelope;
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    throw new LoginError(
      `Token exchange failed: ${describeFailure(payload, response.status)}`,
    );
  }

  const token = extractToken(payload);
  if (token === undefined) {
    throw new LoginError(
      `Token exchange failed: ${describeFailure(payload, response.status)}`,
    );
  }
  return token;
}
