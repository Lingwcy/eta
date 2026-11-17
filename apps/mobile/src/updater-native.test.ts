import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  cacheUri: "",
  sequence: 0,
  tasks: [] as { uri: string; complete: (bytes: string) => void }[],
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => `attempt-${++runtime.sequence}` }));
vi.mock("expo-linking", () => ({ openURL: vi.fn() }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  NativeModules: {
    EtaApkInstaller: {
      getVersionInfo: async () => ({ versionName: "0.1.0", versionCode: 1 }),
      canRequestPackageInstalls: async () => true,
      installApk: vi.fn(async () => true),
    },
  },
}));
vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get name() {
      return this.uri.split("/").pop()!;
    }
    get exists() {
      return existsSync(new URL(this.uri));
    }
    delete() {
      unlinkSync(new URL(this.uri));
    }
  }
  class Directory extends File {
    create() {
      mkdirSync(new URL(this.uri), { recursive: true });
    }
    list() {
      return readdirSync(new URL(this.uri)).map((name) => new File(this, name));
    }
  }
  class DownloadTask {
    constructor(
      _url: string,
      private file: File,
    ) {}
    downloadAsync() {
      const pending = Promise.withResolvers<{ uri: string }>();
      runtime.tasks.push({
        uri: this.file.uri,
        complete: (bytes) => {
          writeFileSync(new URL(this.file.uri), bytes);
          pending.resolve({ uri: this.file.uri });
        },
      });
      return pending.promise;
    }
    cancel() {
      /* Deliberately hold cancellation settlement behind the replacement. */
    }
  }
  return {
    Directory,
    File,
    DownloadTask,
    Paths: {
      get cache() {
        return runtime.cacheUri;
      },
    },
  };
});

import { createNativeUpdaterAdapter } from "./updater-native.ts";
import { createMobileUpdater } from "./updater.ts";

test("late cancelled native download cannot overwrite or delete the replacement APK", async () => {
  const root = mkdtempSync(join(tmpdir(), "eta-updater-ownership-"));
  runtime.cacheUri = pathToFileURL(root).href;
  runtime.tasks = [];
  const adapter = {
    ...createNativeUpdaterAdapter(),
    fetchReleases: async () => [
      {
        tag_name: "mobile-v0.2.0",
        html_url: "https://example.com/release",
        assets: [
          {
            name: "Eta-mobile-0.2.0-android.apk",
            browser_download_url: "https://example.com/update.apk",
          },
        ],
      },
    ],
  };
  const updater = createMobileUpdater({ adapter, initialVersion: "0.1.0" });
  await updater.check();
  const old = updater.downloadAndInstall();
  updater.cancelDownload();
  const replacement = updater.downloadAndInstall();
  try {
    runtime.tasks[1]!.complete("replacement APK bytes");
    await replacement;
    expect(readFileSync(new URL(runtime.tasks[1]!.uri), "utf8")).toBe("replacement APK bytes");
    runtime.tasks[0]!.complete("late cancelled APK bytes");
    await old;
    expect(existsSync(new URL(runtime.tasks[0]!.uri))).toBe(false);
    expect(existsSync(new URL(runtime.tasks[1]!.uri))).toBe(true);
    expect(readFileSync(new URL(runtime.tasks[1]!.uri), "utf8")).toBe("replacement APK bytes");
    expect(runtime.tasks[0]!.uri).not.toBe(runtime.tasks[1]!.uri);
    expect(updater.getSnapshot().state).toMatchObject({
      status: "downloaded",
      fileUri: runtime.tasks[1]!.uri,
    });
  } finally {
    // Every held promise is settled even when the original implementation fails.
    for (const task of runtime.tasks) task.complete("cleanup fixture");
    await Promise.allSettled([old, replacement]);
    updater.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
