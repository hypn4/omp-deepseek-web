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
import { buildOmpIncrementalPrompt, buildOmpPrompt } from "./prompt";
import { buildResetHandoff } from "./handoff";
import type { ConversationPlanner } from "./conversation";
import {
  DEFAULT_SESSION_MAX_ENTRIES,
  DEFAULT_SESSION_STORE_PATH,
  DEFAULT_SESSION_TTL_MS,
  EphemeralPlanner,
  PersistentPlanner,
} from "./conversation";
import { runDeepSeekTurn } from "./provider";

const PROVIDER_ID = "deepseek-web";
const MODEL_ID = "deepseek-web";
const BASE_URL = "https://chat.deepseek.com";

const EPHEMERAL_PLANNER = new EphemeralPlanner();

function createPlanner(): ConversationPlanner {
  if (process.env.DEEPSEEK_WEB_SESSION_MODE === "ephemeral") {
    return EPHEMERAL_PLANNER;
  }
  try {
    return new PersistentPlanner({
      path: process.env.DEEPSEEK_WEB_SESSION_STORE ?? DEFAULT_SESSION_STORE_PATH,
      ttlMs:
        resolveNonNegativeInt(
          process.env.DEEPSEEK_WEB_SESSION_TTL_MS,
          DEFAULT_SESSION_TTL_MS,
        ),
      maxEntries:
        resolveNonNegativeInt(
          process.env.DEEPSEEK_WEB_SESSION_MAX_ENTRIES,
          DEFAULT_SESSION_MAX_ENTRIES,
        ),
    });
  } catch {
    // A broken store must not make the provider unavailable.
    return EPHEMERAL_PLANNER;
  }
}

const CONVERSATION_PLANNER = createPlanner();

function deleteChatSessions(records: readonly { chatSessionId: string }[]): void {
  if (records.length === 0) {
    return;
  }
  const token = readAuthValue(DEFAULT_TOKEN_PATH);
  const deviceId = readAuthValue(DEFAULT_DEVICE_ID_PATH);
  if (token === null || deviceId === null) {
    return;
  }
  const client = createDeepSeekClient(token, deviceId);
  for (const record of records) {
    void client.deleteSession(record.chatSessionId).catch(() => {
      // Session cleanup is best-effort.
    });
  }
}

if (CONVERSATION_PLANNER instanceof PersistentPlanner) {
  // TTL removal only drops the local mapping; also remove abandoned chats.
  deleteChatSessions(CONVERSATION_PLANNER.drainExpired());
}

function createDeepSeekClient(
  token: string,
  deviceId: string,
): DeepSeekClient {
  return new DeepSeekClient({
    baseUrl: BASE_URL,
    token,
    deviceId,
    tokenCommand: process.env.DEEPSEEK_WEB_TOKEN_CMD,
    platform: process.env.DEEPSEEK_WEB_PLATFORM ?? "android",
    clientVersion: process.env.DEEPSEEK_WEB_CLIENT_VERSION ?? "2.6.2",
    bundleId: process.env.DEEPSEEK_WEB_BUNDLE_ID ?? "com.deepseek.chat.nov",
    deviceModel: process.env.DEEPSEEK_WEB_DEVICE_MODEL ?? "Android",
  });
}

/** Title generation is a utility call, not a main chat turn. */
function isUtilityCall(context: PromptContext): boolean {
  const system = (context.systemPrompt ?? []).join("\n");
  return system.includes("Output only the title wrapped in `<title>`");
}

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

function promptFor(context: PromptContext, handoff?: string): string {
  return buildOmpPrompt(
    context,
    (tool: PromptTool) =>
      toolWireSchema(tool as Parameters<typeof toolWireSchema>[0]),
    { handoff },
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
  pi.on("session_shutdown", (_event, ctx) => {
    // Subagent/task chats are task-scoped: delete them when the task ends.
    // The main chat is kept so its mapping survives across turns/restarts.
    if (ctx.agent.kind === "sub") {
      const scopeKey = ctx.sessionManager.getSessionId();
      let record;
      try {
        record = CONVERSATION_PLANNER.remove(scopeKey);
      } catch {
        record = undefined;
      }
      if (record !== undefined) {
        deleteChatSessions([record]);
      }
    }
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
          createClient: createDeepSeekClient,
          buildPrompt: promptFor,
          buildIncrementalPrompt: buildOmpIncrementalPrompt,
          buildHandoff:
            process.env.DEEPSEEK_WEB_HANDOFF === "off"
              ? undefined
              : (context, reason, cwd) =>
                  buildResetHandoff({ context, reason, cwd }),
          cwd: activeContext?.cwd ?? process.cwd(),
          onStatus: setStatus,
          requestGate,
          planner: isUtilityCall(context as unknown as PromptContext)
            ? EPHEMERAL_PLANNER
            : CONVERSATION_PLANNER,
          scopeKey:
            activeContext?.sessionManager.getSessionId() ??
            options?.sessionId ??
            "",
          taskDelayMs: resolveNonNegativeInt(
            process.env.DEEPSEEK_WEB_TASK_DELAY_MS,
            3_000,
          ),
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
