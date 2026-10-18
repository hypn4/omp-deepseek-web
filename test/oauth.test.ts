import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateDeviceId } from "../src/login/device";
import {
  LoginError,
  buildAuthorizeUrl,
  exchangeNonce,
  parseOAuthRedirect,
} from "../src/login/oauth";
import { parseArgs, writeEnvToken } from "../scripts/login";

interface FetchCall {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(...responses: Response[]): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected fetch call: ${String(input)}`);
    }
    return response;
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the function to throw");
}

describe("buildAuthorizeUrl", () => {
  test("points at the Android Google authorize endpoint", () => {
    const url = new URL(buildAuthorizeUrl("device-123"));

    expect(url.origin).toBe("https://chat.deepseek.com");
    expect(url.pathname).toBe("/api/v0/users/oauth/google/authorize");
    expect(url.searchParams.get("os")).toBe("android");
    expect(url.searchParams.get("device_id")).toBe("device-123");
  });
});

describe("parseOAuthRedirect", () => {
  test("extracts the nonce and a zero code", () => {
    expect(
      parseOAuthRedirect(
        "com.deepseek.chat://authorized_android?nonce=abc&code=0",
      ),
    ).toEqual({ nonce: "abc", code: 0 });
  });

  test("throws LoginError carrying a non-zero code", () => {
    const error = capture(() =>
      parseOAuthRedirect(
        "com.deepseek.chat://authorized_android?nonce=abc&code=7",
      ),
    );

    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).code).toBe(7);
  });

  test("rejects other hosts and missing parameters", () => {
    expect(
      capture(() =>
        parseOAuthRedirect("com.deepseek.chat://other?nonce=abc&code=0"),
      ),
    ).toBeInstanceOf(LoginError);
    expect(
      capture(() =>
        parseOAuthRedirect("com.deepseek.chat://authorized_android?code=0"),
      ),
    ).toBeInstanceOf(LoginError);
    expect(
      capture(() =>
        parseOAuthRedirect(
          "com.deepseek.chat://authorized_android?nonce=abc&code=x",
        ),
      ),
    ).toBeInstanceOf(LoginError);
  });
});

describe("exchangeNonce", () => {
  test("posts the Android payload with web client headers", async () => {
    const calls = installFetch(jsonResponse({ code: 0, data: { token: "tok-1" } }));

    await expect(exchangeNonce("device-1", "nonce-1")).resolves.toBe("tok-1");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://chat.deepseek.com/api/v0/users/oauth/get_token",
    );
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({
      device_id: "device-1",
      nonce: "nonce-1",
      os: "android",
      provider: "google",
    });

    const headers = new Headers(call.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-client-platform")).toBe("web");
    expect(headers.get("x-client-version")).toBe("2.5.0");
    expect(headers.get("x-client-bundle-id")).toBe("com.deepseek.chat");
    expect(headers.get("x-client-locale")).toBe("en_US");
    expect(headers.get("x-client-timezone-offset")).toBe("32400");
    expect(headers.get("x-device-id")).toBe("device-1");
    expect(headers.get("x-device-model")).toBe("");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-ds-pow-response")).toBeNull();
  });

  test("accepts the nested biz_data token shape", async () => {
    installFetch(
      jsonResponse({ code: 0, data: { biz_data: { token: "tok-2" } } }),
    );

    await expect(exchangeNonce("device-2", "nonce-2")).resolves.toBe("tok-2");
  });

  test("throws LoginError on a biz error", async () => {
    installFetch(
      jsonResponse({
        code: 0,
        data: { biz_code: 40001, biz_msg: "nonce expired" },
      }),
    );

    const error = await exchangeNonce("device-3", "nonce-3").then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(LoginError);
    expect((error as Error).message).toContain("nonce expired");
  });
});

describe("loadOrCreateDeviceId", () => {
  test("persists a UUID and returns it on the next call", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-web-device-"));
    const path = join(dir, "nested", "device-id");
    try {
      const first = loadOrCreateDeviceId(path);

      expect(first).toMatch(UUID_PATTERN);
      expect(readFileSync(path, "utf8").trim()).toBe(first);
      expect(loadOrCreateDeviceId(path)).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trims an existing device id file", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-web-device-"));
    const path = join(dir, "device-id");
    const existing = "11111111-2222-4333-8444-555555555555";
    try {
      writeFileSync(path, `${existing}\n`);
      expect(loadOrCreateDeviceId(path)).toBe(existing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("login CLI helpers", () => {
  test("parses flags in both separate and equals forms", () => {
    expect(
      parseArgs([
        "--redirect-url",
        "com.deepseek.chat://authorized_android?nonce=n&code=0",
        "--print-token",
        "--write-env",
      ]),
    ).toEqual({
      redirectUrl: "com.deepseek.chat://authorized_android?nonce=n&code=0",
      printToken: true,
      writeEnv: true,
      help: false,
    });

    expect(
      parseArgs(["--redirect-url=com.deepseek.chat://x?nonce=n&code=0"]),
    ).toEqual({
      redirectUrl: "com.deepseek.chat://x?nonce=n&code=0",
      printToken: false,
      writeEnv: false,
      help: false,
    });
  });

  test("rejects unknown flags and missing values", () => {
    expect(capture(() => parseArgs(["--nope"]))).toBeInstanceOf(LoginError);
    expect(capture(() => parseArgs(["--redirect-url"]))).toBeInstanceOf(
      LoginError,
    );
  });

  test("writes the token into .env with mode 0600 and preserves other keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-web-env-"));
    const path = join(dir, "agent", ".env");
    try {
      mkdirSync(join(dir, "agent"), { recursive: true });
      writeFileSync(path, "OTHER=1\nDEEPSEEK_WEB_TOKEN=old\n", { mode: 0o644 });

      await writeEnvToken(path, "new-token");

      expect(readFileSync(path, "utf8")).toBe(
        "OTHER=1\nDEEPSEEK_WEB_TOKEN=new-token\n",
      );
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates a missing .env with mode 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-web-env-"));
    const path = join(dir, "agent", ".env");
    try {
      await writeEnvToken(path, "fresh-token");

      expect(readFileSync(path, "utf8")).toBe(
        "DEEPSEEK_WEB_TOKEN=fresh-token\n",
      );
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
