import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuthValue, writeAuthValue } from "../src/auth/token-store";
import type { CompletionClient, ServerConfig } from "../src/config";
import type { DeepSeekCompletionRequest } from "../src/deepseek/types";
import { startServer } from "../src/server";

const temporaryDirectories: string[] = [];

function temporaryPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "deepseek-web-login-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function completionStream(text: string): ReadableStream<Uint8Array> {
  const payload = [
    `data: ${JSON.stringify({
      v: { response: { fragments: [{ type: "RESPONSE", content: text }] } },
    })}\n\n`,
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
  ].join("");
  return new Response(payload, {
    headers: { "content-type": "text/event-stream" },
  }).body!;
}

function fakeClient(): CompletionClient {
  return {
    async createSession() {
      return "session-1";
    },
    async deleteSession() {},
    async complete(_request: DeepSeekCompletionRequest) {
      return completionStream("OK");
    },
  };
}

function start(config: Partial<ServerConfig> = {}): {
  baseUrl: string;
  tokens: string[];
  stop(): void;
} {
  const tokens: string[] = [];
  const server = startServer({
    port: 0,
    hostname: "127.0.0.1",
    deviceId: "start-device",
    tokenPath: temporaryPath("deepseek-web-token"),
    deviceIdPath: temporaryPath(".deepseek-web-device-id"),
    maxPromptChars: 400000,
    createClient: (token) => {
      tokens.push(token);
      return fakeClient();
    },
    ...config,
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    tokens,
    stop: server.stop,
  };
}

describe("readAuthValue", () => {
  test("returns null for missing and empty files", () => {
    expect(readAuthValue(temporaryPath("missing"))).toBeNull();
    const empty = temporaryPath("empty");
    writeAuthValue(empty, "   ");
    expect(readAuthValue(empty)).toBeNull();
  });
});

describe("POST /login/token", () => {
  test("stores the extension token and device id with owner-only permissions", async () => {
    const tokenPath = temporaryPath("token");
    const deviceIdPath = temporaryPath("device");
    const server = start({ tokenPath, deviceIdPath });
    try {
      const response = await fetch(`${server.baseUrl}/login/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "  stored-token  ",
          deviceId: "  web-device  ",
        }),
      });

      expect(response.status).toBe(200);
      expect(readFileSync(tokenPath, "utf8")).toBe("stored-token\n");
      expect(readFileSync(deviceIdPath, "utf8")).toBe("web-device\n");
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
      expect(statSync(deviceIdPath).mode & 0o777).toBe(0o600);

      const status = await fetch(`${server.baseUrl}/login/status`);
      expect(await status.json()).toEqual({ hasToken: true });
    } finally {
      server.stop();
    }
  });

  test("rejects an empty token", async () => {
    const server = start();
    try {
      const response = await fetch(`${server.baseUrl}/login/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "   " }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_token");
    } finally {
      server.stop();
    }
  });

  test("rejects a non-JSON content type", async () => {
    const server = start();
    try {
      const response = await fetch(`${server.baseUrl}/login/token`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ token: "stored-token" }),
      });
      expect(response.status).toBe(415);
      expect((await response.json()).error.code).toBe("unsupported_media_type");
    } finally {
      server.stop();
    }
  });

  test("uses the stored token instead of the omp bearer value", async () => {
    const server = start();
    try {
      await fetch(`${server.baseUrl}/login/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "stored-token", deviceId: "web-device" }),
      });

      const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer local",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(server.tokens).toEqual(["stored-token"]);
    } finally {
      server.stop();
    }
  });
});
