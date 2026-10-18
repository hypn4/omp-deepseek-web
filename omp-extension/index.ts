import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
  DEFAULT_DEVICE_ID_PATH,
  DEFAULT_TOKEN_PATH,
  readAuthValue,
  writeAuthValue,
} from "../src/auth/token-store";
import { DeepSeekClient } from "../src/deepseek/client";
import {
  resolveContextWindow,
  resolveNonNegativeInt,
  resolveThinkingEnabled,
} from "../src/deepseek/options";
import { RequestGate } from "../src/deepseek/rate-limit";
import type { PromptContext, PromptTool } from "./prompt";
import { buildOmpPrompt } from "./prompt";
import { runDeepSeekTurn } from "./provider";

const PROVIDER_ID = "deepseek-web";
const MODEL_ID = "deepseek-web";
const BASE_URL = "https://chat.deepseek.com";

function ensureDeviceId(): string | null {
  const stored = readAuthValue(DEFAULT_DEVICE_ID_PATH);
  if (stored !== null) {
    return stored;
  }
  const generated = globalThis.crypto.randomUUID();
  try {
    writeAuthValue(DEFAULT_DEVICE_ID_PATH, generated);
  } catch {
    return null;
  }
  return generated;
}

function promptFor(context: PromptContext): string {
  return buildOmpPrompt(context, (tool: PromptTool) =>
    toolWireSchema(tool as Parameters<typeof toolWireSchema>[0]),
  );
}

export default function deepseekWebExtension(pi: ExtensionAPI): void {
  const requestGate = new RequestGate({
    minIntervalMs: resolveNonNegativeInt(
      process.env.DEEPSEEK_WEB_MIN_REQUEST_INTERVAL_MS,
      1_000,
    ),
  });
  let activeContext: ExtensionContext | undefined;
  const setStatus = (status: string | null): void => {
    activeContext?.ui.setStatus("deepseek-web", status ?? undefined);
  };
  const refreshStatus = (ctx: ExtensionContext): void => {
    activeContext = ctx;
    if (ctx.model?.provider !== PROVIDER_ID || ctx.model.id !== MODEL_ID) {
      setStatus(null);
      return;
    }
    const hasToken = readAuthValue(DEFAULT_TOKEN_PATH) !== null;
    setStatus(hasToken ? "DeepSeek Web ✓" : "DeepSeek Web: token missing");
  };

  pi.setLabel("DeepSeek Web");
  pi.on("session_start", (_event, ctx) => {
    refreshStatus(ctx);
  });
  // Model switches can happen mid-session; refresh before each turn so the
  // provider badge is only present while the deepseek-web model is active.
  pi.on("before_agent_start", (_event, ctx) => {
    refreshStatus(ctx);
  });
  pi.on("session_shutdown", () => {
    activeContext = undefined;
  });

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "https://deepseek-web.invalid/",
    apiKey: "unused-by-extension",
    api: PROVIDER_ID,
    models: [
      {
        id: MODEL_ID,
        name: "DeepSeek Web (free)",
        reasoning: true,
        input: ["text", "image"],
        supportsTools: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: resolveContextWindow(
          process.env.DEEPSEEK_WEB_CONTEXT_WINDOW,
        ),
        maxTokens: 8192,
      },
    ],
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      const searchEnabled = process.env.DEEPSEEK_WEB_SEARCH !== "0";
      void runDeepSeekTurn(
        {
          readToken: () => readAuthValue(DEFAULT_TOKEN_PATH),
          readDeviceId: ensureDeviceId,
          createClient: (token, deviceId) =>
            new DeepSeekClient({
              baseUrl: BASE_URL,
              token,
              deviceId,
              tokenCommand: process.env.DEEPSEEK_WEB_TOKEN_CMD,
              platform: process.env.DEEPSEEK_WEB_PLATFORM ?? "android",
              clientVersion: process.env.DEEPSEEK_WEB_CLIENT_VERSION ?? "2.6.2",
              bundleId: process.env.DEEPSEEK_WEB_BUNDLE_ID ?? "com.deepseek.chat.nov",
              deviceModel: process.env.DEEPSEEK_WEB_DEVICE_MODEL ?? "Android",
            }),
          buildPrompt: promptFor,
          onStatus: setStatus,
          requestGate,
        },
        { api: model.api, provider: model.provider, id: model.id },
        context as unknown as PromptContext,
        {
          signal: options?.signal,
          thinkingEnabled: resolveThinkingEnabled(
            process.env.DEEPSEEK_WEB_THINKING,
          ),
          searchEnabled,
        },
        stream,
      );
      return stream;
    },
  });
}
