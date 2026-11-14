import { expect, test, vi } from "vite-plus/test";
import {
  compareSemver,
  createMobileUpdater,
  FOREGROUND_CHECK_INTERVAL_MS,
  parseSemver,
  parseSha256Text,
  pickMobileRelease,
  STARTUP_CHECK_DELAY_MS,
  type GitHubRelease,
  type UpdaterAdapter,
} from "./updater.ts";

function createAdapter(overrides: Partial<UpdaterAdapter> = {}): UpdaterAdapter {
  return {
    platform: "android",
    fetchReleases: vi.fn(async () => []),
    fetchText: vi.fn(async () => ""),
    getInstalledVersion: vi.fn(async () => ({ version: "0.1.0", versionCode: 1 })),
    startDownloadApk: vi.fn(() => ({
      promise: Promise.resolve({ fileUri: "file:///cache/eta-mobile-0.2.0.apk" }),
      cancel: vi.fn(),
    })),
    sha256File: vi.fn(async () => "a".repeat(64)),
    deleteFile: vi.fn(async () => {}),
    canRequestPackageInstalls: vi.fn(async () => true),
    openUnknownAppSourcesSettings: vi.fn(async () => {}),
    installApk: vi.fn(async () => {}),
    openExternalUrl: vi.fn(async () => {}),
    ...overrides,
  };
}

test("parseSemver & compareSemver accept mobile-scoped and standard tags and reject prereleases", () => {
  const a = parseSemver("mobile-v0.2.0");
  const b = parseSemver("v0.10.1");
  expect(a).toEqual({ major: 0, minor: 2, patch: 0, raw: "0.2.0", mobileScoped: true });
  expect(b).toEqual({ major: 0, minor: 10, patch: 1, raw: "0.10.1", mobileScoped: false });
  expect(compareSemver(a!, b!)).toBe(-1);
  expect(parseSemver("v0.2.0-beta.1")).toBeNull();
});

test("pickMobileRelease chooses newest non-draft Android APK release and ignores desktop-only releases", () => {
  const releases: GitHubRelease[] = [
    {
      tag_name: "v0.9.0",
      html_url: "https://github.com/Lingwcy/eta/releases/tag/v0.9.0",
      assets: [
        { name: "Eta-0.9.0-mac-arm64.dmg", browser_download_url: "https://example.com/mac.dmg" },
      ],
    },
    {
      tag_name: "mobile-v0.3.0",
      draft: true,
      html_url: "https://github.com/Lingwcy/eta/releases/tag/mobile-v0.3.0",
      assets: [
        {
          name: "Eta-mobile-0.3.0-android.apk",
          browser_download_url: "https://example.com/030.apk",
        },
      ],
    },
    {
      tag_name: "mobile-v0.2.0",
      html_url: "https://github.com/Lingwcy/eta/releases/tag/mobile-v0.2.0",
      assets: [
        {
          name: "Eta-mobile-0.2.0-android.apk",
          browser_download_url: "https://example.com/020.apk",
          size: 2048,
        },
        {
          name: "Eta-mobile-0.2.0-android.apk.sha256",
          browser_download_url: "https://example.com/020.apk.sha256",
        },
      ],
    },
  ];
  const picked = pickMobileRelease(releases, "0.1.0", "android");
  expect(picked).toMatchObject({
    version: "0.2.0",
    tag: "mobile-v0.2.0",
    downloadUrl: "https://example.com/020.apk",
    sha256Url: "https://example.com/020.apk.sha256",
  });
  expect(
    parseSha256Text(
      `${"f".repeat(64)}  Eta-mobile-0.2.0-android.apk`,
      "Eta-mobile-0.2.0-android.apk",
    ),
  ).toBe("f".repeat(64));
});

test("downloads APK, verifies SHA-256, handles missing install permission on resume, and installs", async () => {
  let canInstall = false;
  let onProgressCb: ((bytes: number, total: number) => void) | undefined;
  let resolveDownload!: (res: { fileUri: string }) => void;

  const adapter = createAdapter({
    fetchReleases: async () => [
      {
        tag_name: "mobile-v0.2.0",
        html_url: "https://github.com/Lingwcy/eta/releases/tag/mobile-v0.2.0",
        assets: [
          {
            name: "Eta-mobile-0.2.0-android.apk",
            browser_download_url: "https://example.com/020.apk",
            size: 1000,
          },
          {
            name: "Eta-mobile-0.2.0-android.apk.sha256",
            browser_download_url: "https://example.com/020.apk.sha256",
          },
        ],
      },
    ],
    fetchText: async () => `${"b".repeat(64)}  Eta-mobile-0.2.0-android.apk\n`,
    sha256File: async () => "b".repeat(64),
    canRequestPackageInstalls: async () => canInstall,
    startDownloadApk: (_candidate, onProgress) => {
      onProgressCb = onProgress;
      return {
        promise: new Promise((resolve) => {
          resolveDownload = resolve;
        }),
        cancel: vi.fn(),
      };
    },
  });

  const updater = createMobileUpdater({ adapter, initialVersion: "0.1.0" });
  await updater.check(true);
  expect(updater.getSnapshot().state.status).toBe("available");

  const downloadPromise = updater.downloadAndInstall();
  await Promise.resolve();
  onProgressCb?.(450, 1000);
  expect(updater.getSnapshot().state).toMatchObject({ status: "downloading", percent: 45 });

  resolveDownload({ fileUri: "file:///cache/eta-mobile-0.2.0.apk" });
  await downloadPromise;
  expect(updater.getSnapshot().state.status).toBe("permission-required");
  expect(adapter.installApk).not.toHaveBeenCalled();

  await updater.requestInstallPermission();
  expect(adapter.openUnknownAppSourcesSettings).toHaveBeenCalledOnce();

  canInstall = true;
  await updater.onForeground();
  expect(updater.getSnapshot().state.status).toBe("downloaded");
  expect(adapter.installApk).toHaveBeenCalledWith("file:///cache/eta-mobile-0.2.0.apk");
});

test("rejects SHA-256 mismatch, deletes downloaded APK, and supports cancelling active download", async () => {
  const cancelSpy = vi.fn();
  let rejectDownload!: (error: Error) => void;
  const adapter = createAdapter({
    fetchReleases: async () => [
      {
        tag_name: "mobile-v0.2.0",
        html_url: "https://github.com/Lingwcy/eta/releases/tag/mobile-v0.2.0",
        assets: [
          {
            name: "Eta-mobile-0.2.0-android.apk",
            browser_download_url: "https://example.com/020.apk",
            digest: `sha256:${"c".repeat(64)}`,
          },
        ],
      },
    ],
    sha256File: async () => "0".repeat(64),
    startDownloadApk: () => ({
      promise: Promise.resolve({ fileUri: "file:///cache/corrupt.apk" }),
      cancel: cancelSpy,
    }),
  });

  const updater = createMobileUpdater({ adapter, initialVersion: "0.1.0" });
  await updater.check(true);
  await updater.downloadAndInstall();

  expect(adapter.deleteFile).toHaveBeenCalledWith("file:///cache/corrupt.apk");
  expect(adapter.installApk).not.toHaveBeenCalled();
  expect(updater.getSnapshot().state).toMatchObject({
    status: "error",
    message: "APK checksum mismatch",
  });

  // Cancel resets back to "available" rather than "error".
  const cancelAdapter = createAdapter({
    fetchReleases: async () => [
      {
        tag_name: "mobile-v0.2.0",
        html_url: "https://github.com/Lingwcy/eta/releases/tag/mobile-v0.2.0",
        assets: [
          {
            name: "Eta-mobile-0.2.0-android.apk",
            browser_download_url: "https://example.com/020.apk",
          },
        ],
      },
    ],
    startDownloadApk: () => ({
      promise: new Promise((_resolve, reject) => {
        rejectDownload = reject;
      }),
      cancel: () => {
        cancelSpy();
        rejectDownload(new Error("Download cancelled"));
      },
    }),
  });
  const cancellable = createMobileUpdater({ adapter: cancelAdapter, initialVersion: "0.1.0" });
  await cancellable.check(true);
  const pending = cancellable.downloadAndInstall();
  cancellable.cancelDownload();
  await pending;
  expect(cancelSpy).toHaveBeenCalledOnce();
  expect(cancellable.getSnapshot().state.status).toBe("available");
});

test("auto-check runs on startup delay, throttles foreground re-checks, and iOS opens release page", async () => {
  vi.useFakeTimers();
  let clock = 1_000;
  const iosAdapter = createAdapter({
    platform: "ios",
    fetchReleases: vi.fn(async () => [
      {
        tag_name: "mobile-v0.2.0",
        html_url: "https://github.com/Lingwcy/eta/releases/tag/mobile-v0.2.0",
      },
    ]),
  });

  const updater = createMobileUpdater({
    adapter: iosAdapter,
    initialVersion: "0.1.0",
    now: () => clock,
  });
  updater.start();
  expect(iosAdapter.fetchReleases).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS);
  expect(iosAdapter.fetchReleases).toHaveBeenCalledTimes(1);
  expect(updater.getSnapshot().state.status).toBe("available");

  await updater.downloadAndInstall();
  expect(iosAdapter.openExternalUrl).toHaveBeenCalledWith(
    "https://github.com/Lingwcy/eta/releases/tag/mobile-v0.2.0",
  );

  // Too soon on foreground -> no extra network check.
  clock += 60_000;
  await updater.onForeground();
  expect(iosAdapter.fetchReleases).toHaveBeenCalledTimes(1);

  // After interval elapsed -> foreground re-check fires.
  clock += FOREGROUND_CHECK_INTERVAL_MS;
  await updater.onForeground();
  expect(iosAdapter.fetchReleases).toHaveBeenCalledTimes(2);

  updater.dispose();
  vi.useRealTimers();
});
