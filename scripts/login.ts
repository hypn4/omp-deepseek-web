import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_DEVICE_ID_PATH } from "../src/config";
import { loadOrCreateDeviceId } from "../src/login/device";
import {
  LoginError,
  buildAuthorizeUrl,
  exchangeNonce,
  parseOAuthRedirect,
} from "../src/login/oauth";

export const TOKEN_ENV_KEY = "DEEPSEEK_WEB_TOKEN";
export const DEVICE_ID_ENV_KEY = "DEEPSEEK_WEB_DEVICE_ID";
export const DEFAULT_ENV_PATH = join(homedir(), ".omp", "agent", ".env");

const USAGE = `Usage: bun run login [options]

Options:
  --redirect-url <url>  Use this com.deepseek.chat:// redirect instead of prompting
  --print-token         Write only the token to stdout
  --write-env           Save the token to ~/.omp/agent/.env (mode 0600)
  -h, --help            Show this help`;

export interface LoginOptions {
  redirectUrl?: string;
  printToken: boolean;
  writeEnv: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): LoginOptions {
  const options: LoginOptions = {
    printToken: false,
    writeEnv: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--print-token") {
      options.printToken = true;
    } else if (argument === "--write-env") {
      options.writeEnv = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--redirect-url") {
      const value = argv[index + 1];
      if (value === undefined || value === "") {
        throw new LoginError("--redirect-url requires a value");
      }
      options.redirectUrl = value;
      index += 1;
    } else if (argument.startsWith("--redirect-url=")) {
      const value = argument.slice("--redirect-url=".length);
      if (value === "") {
        throw new LoginError("--redirect-url requires a value");
      }
      options.redirectUrl = value;
    } else {
      throw new LoginError(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

/** Upserts the token and its device id, preserving other lines and mode 0600. */
export async function writeEnvConfig(
  path: string,
  token: string,
  deviceId: string,
): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const entries: Array<[string, string]> = [
    [TOKEN_ENV_KEY, token],
    [DEVICE_ID_ENV_KEY, deviceId],
  ];
  let content = existing;
  for (const [key, value] of entries) {
    if (value === "" || value.trim() !== value || /[\r\n]/.test(value)) {
      throw new LoginError(`Refusing to write an invalid value for ${key}`);
    }
    const line = `${key}=${value}`;
    const entry = new RegExp(`^${key}=.*$`, "m");
    if (entry.test(content)) {
      content = content.replace(entry, line);
    } else {
      const separator = content === "" || content.endsWith("\n") ? "" : "\n";
      content = `${content}${separator}${line}\n`;
    }
  }
  if (!content.endsWith("\n")) {
    content += "\n";
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function promptRedirectUrl(): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return (await readline.question("Paste the final com.deepseek.chat:// URL: ")).trim();
  } finally {
    readline.close();
  }
}

/**
 * Returns the platform command that opens `url` in the default browser, or
 * null when the platform is unknown. Windows `start` is a cmd builtin, and its
 * empty title argument keeps the URL from being treated as the window title.
 */
export function browserOpenCommand(
  url: string,
  platform: string = process.platform,
): string[] | null {
  switch (platform) {
    case "darwin":
      return ["open", url];
    case "linux":
      return ["xdg-open", url];
    case "win32":
      return ["cmd", "/c", "start", "", url];
    default:
      return null;
  }
}

function openInBrowser(url: string): void {
  const command = browserOpenCommand(url);
  if (command === null) {
    console.error("Could not detect a browser opener; open the URL above.");
    return;
  }
  try {
    Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    console.error("Could not open a browser automatically; open the URL above.");
  }
}

export async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.printToken && !options.writeEnv) {
    throw new LoginError(
      "Choose how to store the token: pass --print-token and/or --write-env",
    );
  }

  const configuredDeviceId = process.env.DEEPSEEK_WEB_DEVICE_ID?.trim();
  const deviceId =
    configuredDeviceId && configuredDeviceId !== ""
      ? configuredDeviceId
      : loadOrCreateDeviceId(DEFAULT_DEVICE_ID_PATH);

  const authorizeUrl = buildAuthorizeUrl(deviceId);
  console.error("Open this URL to sign in with Google:");
  console.error(authorizeUrl);
  openInBrowser(authorizeUrl);

  const redirectUrl = options.redirectUrl ?? (await promptRedirectUrl());
  if (redirectUrl === "") {
    throw new LoginError("No redirect URL was provided");
  }

  const { nonce } = parseOAuthRedirect(redirectUrl);
  console.error("Exchanging the OAuth nonce for a token...");
  const token = await exchangeNonce(deviceId, nonce);

  if (options.writeEnv) {
    await writeEnvConfig(DEFAULT_ENV_PATH, token, deviceId);
    console.error(
      `Wrote ${TOKEN_ENV_KEY} and ${DEVICE_ID_ENV_KEY} to ${DEFAULT_ENV_PATH}.`,
    );
  }
  if (options.printToken) {
    process.stdout.write(`${token}\n`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`login: ${message}`);
    process.exitCode = 1;
  });
}
