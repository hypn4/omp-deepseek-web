import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const NATIVE_HOST_NAME = "com.whales.deepseek_web";

export type Browser = "chrome" | "chromium" | "edge" | "brave";

const BROWSER_DIRECTORIES: Record<Browser, string> = {
  chrome: "Library/Application Support/Google/Chrome/NativeMessagingHosts",
  chromium: "Library/Application Support/Chromium/NativeMessagingHosts",
  edge: "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
  brave:
    "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
};

export interface NativeHostManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

export interface NativeHostInstallOptions {
  extensionId: string;
  home: string;
  bunPath: string;
  repoRoot: string;
  browser?: Browser;
}

export interface NativeHostInstallResult {
  manifestPath: string;
  wrapperPath: string;
}

function validateExtensionId(extensionId: string): void {
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error(
      "A Chrome extension id is 32 characters from a-p; copy it from chrome://extensions.",
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Chrome extension id derived from the manifest `key` public key. */
export function extensionIdFromKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") {
    throw new Error("Extension key is empty.");
  }
  const digest = createHash("sha256")
    .update(Buffer.from(trimmed, "base64"))
    .digest()
    .subarray(0, 16);
  let id = "";
  for (const byte of digest) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

/** Reads the pinned extension id from extension/manifest.json. */
export function manifestExtensionId(repoRoot: string): string {
  const manifestPath = join(repoRoot, "extension", "manifest.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`Could not read ${manifestPath}.`);
  }
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("extension/manifest.json is not an object.");
  }
  const key = (manifest as Record<string, unknown>).key;
  if (typeof key !== "string") {
    throw new Error("extension/manifest.json has no pinned key.");
  }
  return extensionIdFromKey(key);
}

export function nativeHostManifest(options: {
  extensionId: string;
  hostPath: string;
}): NativeHostManifest {
  validateExtensionId(options.extensionId);
  return {
    name: NATIVE_HOST_NAME,
    description: "DeepSeek Web token bridge for omp",
    path: options.hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${options.extensionId}/`],
  };
}

export function nativeHostManifestPath(
  home: string,
  browser: Browser = "chrome",
): string {
  return join(
    home,
    BROWSER_DIRECTORIES[browser],
    `${NATIVE_HOST_NAME}.json`,
  );
}

export function installNativeHost(
  options: NativeHostInstallOptions,
): NativeHostInstallResult {
  validateExtensionId(options.extensionId);
  const browser = options.browser ?? "chrome";
  const hostDirectory = join(options.home, ".omp", "agent");
  const wrapperPath = join(hostDirectory, "deepseek-web-native-host");
  const hostScript = join(
    options.repoRoot,
    "extension",
    "native-host",
    "host.ts",
  );

  mkdirSync(hostDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    wrapperPath,
    `#!/bin/sh\nexec ${shellQuote(options.bunPath)} ${shellQuote(hostScript)} "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(wrapperPath, 0o755);

  const manifestPath = nativeHostManifestPath(options.home, browser);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    manifestPath,
    JSON.stringify(
      nativeHostManifest({
        extensionId: options.extensionId,
        hostPath: wrapperPath,
      }),
      null,
      2,
    ) + "\n",
    { mode: 0o644 },
  );
  chmodSync(manifestPath, 0o644);

  return { manifestPath, wrapperPath };
}

export function uninstallNativeHost(options: {
  home: string;
  browser?: Browser;
}): void {
  const browser = options.browser ?? "chrome";
  rmSync(join(options.home, ".omp", "agent", "deepseek-web-native-host"), {
    force: true,
  });
  rmSync(nativeHostManifestPath(options.home, browser), { force: true });
}

function parseBrowser(value: string | undefined): Browser {
  if (value === undefined) {
    return "chrome";
  }
  if (
    value === "chrome" ||
    value === "chromium" ||
    value === "edge" ||
    value === "brave"
  ) {
    return value;
  }
  throw new Error("Use --browser chrome|chromium|edge|brave.");
}

function main(args: string[]): void {
  const extensionIdIndex = args.indexOf("--extension-id");
  const browserIndex = args.indexOf("--browser");
  const extensionId =
    extensionIdIndex >= 0 ? args[extensionIdIndex + 1] : undefined;
  const browser = parseBrowser(
    browserIndex >= 0 ? args[browserIndex + 1] : undefined,
  );
  const home = homedir();

  if (args.includes("--uninstall")) {
    uninstallNativeHost({ home, browser });
    console.log("Removed the DeepSeek native messaging host.");
    return;
  }

  if (extensionId === undefined) {
    const repoRoot = dirname(import.meta.dir);
    const resolved = manifestExtensionId(repoRoot);
    const result = installNativeHost({
      extensionId: resolved,
      home,
      bunPath: process.execPath,
      repoRoot,
      browser,
    });
    console.log(`Pinned extension id: ${resolved}`);
    console.log(`Native host wrapper: ${result.wrapperPath}`);
    console.log(`Chrome host manifest: ${result.manifestPath}`);
    return;
  }

  const result = installNativeHost({
    extensionId,
    home,
    bunPath: process.execPath,
    repoRoot: dirname(import.meta.dir),
    browser,
  });
  console.log(`Native host wrapper: ${result.wrapperPath}`);
  console.log(`Chrome host manifest: ${result.manifestPath}`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
