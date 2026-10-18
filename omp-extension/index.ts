import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
  DEFAULT_DEVICE_ID_PATH,
  DEFAULT_TOKEN_PATH,
  readAuthValue,
  writeAuthValue,
} from "../src/auth/token-store";
import { DeepSeekClient } from "../src/deepseek/client";
import { emitBufferedCompletion } from "./events";
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
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "https://deepseek-web.invalid/",
    apiKey: "unused-by-extension",
    api: PROVIDER_ID,
    models: [
      {
        id: MODEL_ID,
        name: "DeepSeek Web (free)",
        reasoning: false,
        input: ["text"],
        supportsTools: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
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
            }),
          buildPrompt: promptFor,
          emit: emitBufferedCompletion,
        },
        { api: model.api, provider: model.provider, id: model.id },
        context as unknown as PromptContext,
        { signal: options?.signal },
        stream,
      );
      return stream;
    },
  });
}
