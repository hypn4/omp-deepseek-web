import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATIVE_HOST_NAME,
  extensionIdFromKey,
  installNativeHost,
  manifestExtensionId,
  nativeHostManifest,
  nativeHostManifestPath,
  uninstallNativeHost,
} from "../extension/install";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "deepseek-web-install-"));
  directories.push(directory);
  return directory;
}

const EXTENSION_ID = "a".repeat(32);
const REPO_ROOT = "/repo/deepseek-web";
const BUN_PATH = "/usr/local/bin/bun";

describe("native host installer", () => {
  test("derives the pinned extension id from the manifest key", () => {
    const id = manifestExtensionId(join(import.meta.dir, ".."));

    expect(id).toBe("oabliooijagfijmlhdidggapcebhnepp");
    expect(() => extensionIdFromKey("")).toThrow(/extension key/i);
  });

  test("builds a host manifest scoped to the extension", () => {
    const manifest = nativeHostManifest({
      extensionId: EXTENSION_ID,
      hostPath: "/host/deepseek-web-native-host",
    });

    expect(manifest.name).toBe(NATIVE_HOST_NAME);
    expect(manifest.type).toBe("stdio");
    expect(manifest.path).toBe("/host/deepseek-web-native-host");
    expect(manifest.allowed_origins).toEqual([
      `chrome-extension://${EXTENSION_ID}/`,
    ]);
  });

  test("installs a wrapper and manifest with owner-safe modes", () => {
    const home = temporaryHome();
    const result = installNativeHost({
      extensionId: EXTENSION_ID,
      home,
      bunPath: BUN_PATH,
      repoRoot: REPO_ROOT,
    });

    expect(result.wrapperPath).toBe(
      join(home, ".omp", "agent", "deepseek-web-native-host"),
    );
    expect(result.manifestPath).toBe(
      nativeHostManifestPath(home, "chrome"),
    );

    const wrapper = readFileSync(result.wrapperPath, "utf8");
    expect(wrapper).toContain(`exec '${BUN_PATH}' '${REPO_ROOT}/extension/native-host/host.ts' "$@"`);
    expect(statSync(result.wrapperPath).mode & 0o777).toBe(0o755);

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(manifest.allowed_origins).toEqual([
      `chrome-extension://${EXTENSION_ID}/`,
    ]);
    expect(manifest.path).toBe(result.wrapperPath);
  });

  test("rejects an empty or malformed extension id", () => {
    const home = temporaryHome();

    expect(() =>
      installNativeHost({
        extensionId: "",
        home,
        bunPath: BUN_PATH,
        repoRoot: REPO_ROOT,
      }),
    ).toThrow("extension id");
    expect(() =>
      installNativeHost({
        extensionId: "not-a-chrome-id",
        home,
        bunPath: BUN_PATH,
        repoRoot: REPO_ROOT,
      }),
    ).toThrow("extension id");
  });

  test("uninstalls the manifest and wrapper", () => {
    const home = temporaryHome();
    installNativeHost({
      extensionId: EXTENSION_ID,
      home,
      bunPath: BUN_PATH,
      repoRoot: REPO_ROOT,
    });

    uninstallNativeHost({ home });

    expect(() =>
      statSync(join(home, ".omp", "agent", "deepseek-web-native-host")),
    ).toThrow();
    expect(() =>
      statSync(nativeHostManifestPath(home, "chrome")),
    ).toThrow();
  });
});
