export const DEFAULT_RELEASES_API_URL =
  "https://api.github.com/repos/Lingwcy/eta/releases?per_page=15";
export const DEFAULT_RELEASES_PAGE_URL = "https://github.com/Lingwcy/eta/releases";

export const STARTUP_CHECK_DELAY_MS = 3_000;
export const FOREGROUND_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string | null;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  body?: string | null;
  assets?: GitHubReleaseAsset[];
}

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  raw: string;
  mobileScoped: boolean;
}

export interface ReleaseCandidate {
  version: string;
  tag: string;
  releaseUrl: string;
  assetName?: string;
  downloadUrl?: string;
  size?: number;
  sha256?: string;
  sha256Url?: string;
  notes?: string;
}

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "not-available"; checkedAt: number }
  | { status: "available"; release: ReleaseCandidate }
  | {
      status: "downloading";
      release: ReleaseCandidate;
      percent: number;
      bytesWritten: number;
      totalBytes: number;
    }
  | { status: "downloaded"; release: ReleaseCandidate; fileUri: string }
  | { status: "permission-required"; release: ReleaseCandidate; fileUri: string }
  | { status: "error"; message: string; releaseUrl: string };

export interface UpdateSnapshot {
  currentVersion: string;
  versionCode?: number;
  platform: "android" | "ios" | "web";
  supportsInAppInstall: boolean;
  autoCheck: boolean;
  dismissedVersion?: string;
  lastCheckedAt?: number;
  state: UpdateState;
}

export interface DownloadHandle {
  promise: Promise<{ fileUri: string }>;
  cancel: () => void;
}

export interface UpdaterAdapter {
  platform: "android" | "ios" | "web";
  fetchReleases: (signal?: AbortSignal) => Promise<GitHubRelease[]>;
  fetchText: (url: string, signal?: AbortSignal) => Promise<string>;
  getInstalledVersion: () => Promise<{ version: string; versionCode?: number }>;
  startDownloadApk: (
    candidate: ReleaseCandidate,
    onProgress: (bytesWritten: number, totalBytes: number) => void,
  ) => DownloadHandle;
  sha256File: (fileUri: string) => Promise<string>;
  deleteFile: (fileUri: string) => Promise<void>;
  canRequestPackageInstalls: () => Promise<boolean>;
  openUnknownAppSourcesSettings: () => Promise<void>;
  installApk: (fileUri: string) => Promise<void>;
  openExternalUrl: (url: string) => Promise<void>;
}

const tagPattern = /^(mobile-)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaHexPattern = /\b([a-fA-F0-9]{64})\b/;

export function parseSemver(input: string): ParsedSemver | null {
  const trimmed = input.trim();
  const match = tagPattern.exec(trimmed);
  if (!match) return null;
  const major = Number(match[2]);
  const minor = Number(match[3]);
  const patch = Number(match[4]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    raw: `${major}.${minor}.${patch}`,
    mobileScoped: Boolean(match[1]),
  };
}

export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

export function parseSha256Text(text: string, assetName?: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (assetName) {
    const lowerTarget = assetName.toLowerCase();
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const hash = parts[0]!;
        const file = parts.slice(1).join(" ").replace(/^\*/, "").trim();
        const base = file.split("/").pop()?.toLowerCase();
        if (
          /^[a-fA-F0-9]{64}$/.test(hash) &&
          (file.toLowerCase() === lowerTarget || base === lowerTarget)
        ) {
          return hash.toLowerCase();
        }
      }
    }
  }
  if (lines.length === 1) {
    const match = shaHexPattern.exec(lines[0]!);
    if (match) return match[1]!.toLowerCase();
  }
  return undefined;
}

function scoreApkAsset(name: string): number {
  const lower = name.toLowerCase();
  if (!lower.endsWith(".apk")) return -1;
  let score = 1;
  if (lower.includes("eta")) score += 2;
  if (lower.includes("mobile")) score += 2;
  if (lower.includes("android")) score += 1;
  if (lower.includes("release")) score += 1;
  if (lower.includes("debug")) score -= 3;
  return score;
}

function parseAssetDigest(digest?: string | null): string | undefined {
  if (!digest) return undefined;
  const trimmed = digest.trim().toLowerCase();
  if (trimmed.startsWith("sha256:")) {
    const hex = trimmed.slice("sha256:".length);
    if (/^[a-f0-9]{64}$/.test(hex)) return hex;
  }
  return undefined;
}

export function pickMobileRelease(
  releases: readonly GitHubRelease[],
  currentVersion: string,
  platform: "android" | "ios" | "web",
): ReleaseCandidate | null {
  const current = parseSemver(currentVersion);
  if (!current) return null;

  let best: { parsed: ParsedSemver; candidate: ReleaseCandidate } | null = null;

  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const parsed = parseSemver(release.tag_name);
    if (!parsed || compareSemver(parsed, current) <= 0) continue;

    const assets = release.assets ?? [];
    const apkAssets = assets
      .map((asset) => ({ asset, score: scoreApkAsset(asset.name) }))
      .filter((item) => item.score > 0)
      .toSorted((left, right) => right.score - left.score);

    const primaryApk = apkAssets[0]?.asset;
    if (platform === "android" && !primaryApk) {
      // Android self-updates require an installable APK asset on the release.
      continue;
    }
    if (platform !== "android" && !parsed.mobileScoped && !primaryApk) {
      // On iOS/web, only surface releases explicitly scoped to mobile unless an APK is also present.
      continue;
    }

    const shaAsset =
      primaryApk &&
      (assets.find((item) => item.name === `${primaryApk.name}.sha256`) ??
        assets.find((item) => item.name.toLowerCase() === "sha256sums.txt"));

    const candidate: ReleaseCandidate = {
      version: parsed.raw,
      tag: release.tag_name,
      releaseUrl: release.html_url || DEFAULT_RELEASES_PAGE_URL,
      assetName: primaryApk?.name,
      downloadUrl: primaryApk?.browser_download_url,
      size: primaryApk?.size,
      sha256: parseAssetDigest(primaryApk?.digest),
      sha256Url: shaAsset?.browser_download_url,
      notes: release.body?.trim() || undefined,
    };

    if (!best) {
      best = { parsed, candidate };
      continue;
    }
    const cmp = compareSemver(parsed, best.parsed);
    if (cmp > 0 || (cmp === 0 && parsed.mobileScoped && !best.parsed.mobileScoped)) {
      best = { parsed, candidate };
    }
  }

  return best?.candidate ?? null;
}

class CancelledDownloadError extends Error {
  constructor() {
    super("cancelled");
  }
}

export function createMobileUpdater(options: {
  adapter: UpdaterAdapter;
  initialVersion: string;
  initialAutoCheck?: boolean;
  initialDismissedVersion?: string;
  now?: () => number;
  onAutoCheckPersist?: (enabled: boolean) => void;
  onDismissedVersionPersist?: (version?: string) => void;
}) {
  const { adapter, now = Date.now } = options;
  const supportsInAppInstall = adapter.platform === "android";

  let snapshot: UpdateSnapshot = {
    currentVersion: parseSemver(options.initialVersion)?.raw ?? options.initialVersion,
    platform: adapter.platform,
    supportsInAppInstall,
    autoCheck: options.initialAutoCheck ?? true,
    dismissedVersion: options.initialDismissedVersion,
    state: { status: "idle" },
  };

  const listeners = new Set<() => void>();
  let disposed = false;
  let versionResolved = false;
  let inFlightCheck: Promise<UpdateState> | undefined;
  let activeDownload: { handle: DownloadHandle; cancelled: boolean; version: string } | undefined;
  let checkAbort: AbortController | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const setSnapshot = (patch: Partial<UpdateSnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    notify();
  };

  const ensureVersionLoaded = async () => {
    if (versionResolved) return;
    versionResolved = true;
    try {
      const info = await adapter.getInstalledVersion();
      if (disposed) return;
      const clean = parseSemver(info.version)?.raw ?? (info.version || snapshot.currentVersion);
      setSnapshot({
        currentVersion: clean,
        versionCode: info.versionCode,
      });
    } catch {
      // Keep configured fallback version.
    }
  };

  const isBusyOrSettled = () => {
    const s = snapshot.state.status;
    return s === "downloading" || s === "downloaded" || s === "permission-required";
  };

  const check = async (manual = true): Promise<UpdateState> => {
    if (disposed) return snapshot.state;
    await ensureVersionLoaded();
    if (disposed) return snapshot.state;
    if (isBusyOrSettled()) return snapshot.state;
    if (inFlightCheck) return inFlightCheck;

    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    checkAbort = controller;
    if (manual || snapshot.state.status === "idle" || snapshot.state.status === "error") {
      setSnapshot({ state: { status: "checking" } });
    }

    inFlightCheck = (async () => {
      try {
        const releases = await adapter.fetchReleases(controller?.signal);
        if (disposed) return snapshot.state;
        const checkedAt = now();
        // Do not overwrite if a download began elsewhere.
        if (isBusyOrSettled()) return snapshot.state;
        const match = pickMobileRelease(releases, snapshot.currentVersion, adapter.platform);
        if (match) {
          // Unhide if user manually triggers check or a newer version arrives.
          const nextDismissed =
            manual || (snapshot.dismissedVersion && snapshot.dismissedVersion !== match.version)
              ? undefined
              : snapshot.dismissedVersion;
          if (nextDismissed !== snapshot.dismissedVersion) {
            options.onDismissedVersionPersist?.(nextDismissed);
          }
          setSnapshot({
            lastCheckedAt: checkedAt,
            dismissedVersion: nextDismissed,
            state: { status: "available", release: match },
          });
        } else {
          setSnapshot({
            lastCheckedAt: checkedAt,
            state: { status: "not-available", checkedAt },
          });
        }
      } catch (error) {
        if (disposed || controller?.signal.aborted) return snapshot.state;
        if (manual || snapshot.state.status === "checking") {
          const message = error instanceof Error ? error.message : String(error);
          setSnapshot({
            state: { status: "error", message, releaseUrl: DEFAULT_RELEASES_PAGE_URL },
          });
        }
      } finally {
        if (checkAbort === controller) checkAbort = undefined;
        inFlightCheck = undefined;
      }
      return snapshot.state;
    })();

    return inFlightCheck;
  };

  const downloadAndInstall = async () => {
    if (disposed) return;
    if (snapshot.state.status === "downloaded") {
      await install();
      return;
    }
    if (snapshot.state.status === "permission-required") {
      await requestInstallPermission();
      return;
    }
    if (snapshot.state.status !== "available") return;
    const { release } = snapshot.state;

    if (!supportsInAppInstall || !release.downloadUrl) {
      await adapter.openExternalUrl(release.releaseUrl);
      return;
    }

    const totalHint = release.size ?? 0;
    setSnapshot({
      state: {
        status: "downloading",
        release,
        percent: 0,
        bytesWritten: 0,
        totalBytes: totalHint,
      },
    });

    const handle = adapter.startDownloadApk(release, (bytesWritten, reportedTotal) => {
      if (
        disposed ||
        !activeDownload ||
        activeDownload.handle !== handle ||
        activeDownload.cancelled
      ) {
        return;
      }
      const total = reportedTotal > 0 ? reportedTotal : totalHint;
      const percent =
        total > 0 ? Math.max(0, Math.min(100, Math.floor((bytesWritten / total) * 100))) : 0;
      const current = snapshot.state;
      if (
        current.status === "downloading" &&
        current.percent === percent &&
        percent > 0 &&
        percent < 100
      ) {
        return;
      }
      setSnapshot({
        state: {
          status: "downloading",
          release,
          percent,
          bytesWritten,
          totalBytes: total,
        },
      });
    });

    const downloadEntry = { handle, cancelled: false, version: release.version };
    activeDownload = downloadEntry;

    try {
      const { fileUri } = await handle.promise;
      if (disposed || downloadEntry.cancelled) {
        await adapter.deleteFile(fileUri).catch(() => {});
        return;
      }

      let expectedSha = release.sha256;
      if (!expectedSha && release.sha256Url) {
        try {
          const text = await adapter.fetchText(release.sha256Url);
          expectedSha = parseSha256Text(text, release.assetName);
        } catch {
          // Proceed if sidecar file cannot be fetched, unless release digest already failed.
        }
      }
      if (expectedSha) {
        const actualSha = (await adapter.sha256File(fileUri)).trim().toLowerCase();
        if (actualSha !== expectedSha.toLowerCase()) {
          await adapter.deleteFile(fileUri).catch(() => {});
          throw new Error("APK checksum mismatch");
        }
      }
      if (disposed || downloadEntry.cancelled) {
        await adapter.deleteFile(fileUri).catch(() => {});
        return;
      }

      activeDownload = undefined;
      const canInstall = await adapter.canRequestPackageInstalls();
      if (disposed) return;

      if (!canInstall) {
        setSnapshot({
          state: { status: "permission-required", release, fileUri },
        });
        return;
      }

      setSnapshot({
        state: { status: "downloaded", release, fileUri },
      });
      await adapter.installApk(fileUri);
    } catch (error) {
      if (activeDownload === downloadEntry) activeDownload = undefined;
      if (disposed || downloadEntry.cancelled || error instanceof CancelledDownloadError) {
        setSnapshot({ state: { status: "available", release } });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setSnapshot({
        state: { status: "error", message, releaseUrl: release.releaseUrl },
      });
    }
  };

  const cancelDownload = () => {
    if (!activeDownload) return;
    activeDownload.cancelled = true;
    const target = activeDownload;
    activeDownload = undefined;
    try {
      target.handle.cancel();
    } catch {
      // Ignore cancel hook error.
    }
    if (snapshot.state.status === "downloading") {
      setSnapshot({ state: { status: "available", release: snapshot.state.release } });
    }
  };

  const install = async () => {
    if (disposed) return;
    if (snapshot.state.status === "permission-required") {
      await requestInstallPermission();
      return;
    }
    if (snapshot.state.status !== "downloaded") return;
    const { release, fileUri } = snapshot.state;
    const canInstall = await adapter.canRequestPackageInstalls();
    if (disposed) return;
    if (!canInstall) {
      setSnapshot({ state: { status: "permission-required", release, fileUri } });
      return;
    }
    await adapter.installApk(fileUri);
  };

  const requestInstallPermission = async () => {
    if (disposed) return;
    await adapter.openUnknownAppSourcesSettings();
  };

  const openReleasePage = async () => {
    const url =
      "release" in snapshot.state
        ? snapshot.state.release.releaseUrl
        : snapshot.state.status === "error"
          ? snapshot.state.releaseUrl
          : DEFAULT_RELEASES_PAGE_URL;
    await adapter.openExternalUrl(url);
  };

  const dismissBanner = () => {
    if (!("release" in snapshot.state)) return;
    const version = snapshot.state.release.version;
    options.onDismissedVersionPersist?.(version);
    setSnapshot({ dismissedVersion: version });
  };

  const setAutoCheck = (enabled: boolean) => {
    options.onAutoCheckPersist?.(enabled);
    setSnapshot({ autoCheck: enabled });
    if (!enabled && startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
  };

  const start = () => {
    if (started || disposed) return;
    started = true;
    void ensureVersionLoaded();
    if (snapshot.autoCheck) {
      startupTimer = setTimeout(() => {
        startupTimer = undefined;
        if (!disposed && snapshot.autoCheck) {
          void check(false);
        }
      }, STARTUP_CHECK_DELAY_MS);
    }
  };

  const onForeground = async () => {
    if (disposed) return;
    if (snapshot.state.status === "permission-required") {
      const { release, fileUri } = snapshot.state;
      const canInstall = await adapter.canRequestPackageInstalls();
      if (!disposed && canInstall) {
        setSnapshot({ state: { status: "downloaded", release, fileUri } });
        await adapter.installApk(fileUri).catch(() => {});
      }
      return;
    }
    if (!snapshot.autoCheck || isBusyOrSettled() || inFlightCheck) return;
    const elapsed = snapshot.lastCheckedAt
      ? now() - snapshot.lastCheckedAt
      : Number.POSITIVE_INFINITY;
    if (elapsed >= FOREGROUND_CHECK_INTERVAL_MS) {
      void check(false);
    }
  };

  const applyPreferences = (prefs: { autoCheck: boolean; dismissedVersion?: string }) => {
    if (disposed) return;
    setSnapshot({
      autoCheck: prefs.autoCheck,
      dismissedVersion: prefs.dismissedVersion,
    });
    if (!prefs.autoCheck && startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
  };

  const dispose = () => {
    disposed = true;
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    checkAbort?.abort();
    activeDownload?.handle.cancel();
    activeDownload = undefined;
    listeners.clear();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    check,
    downloadAndInstall,
    cancelDownload,
    install,
    requestInstallPermission,
    openReleasePage,
    dismissBanner,
    setAutoCheck,
    onForeground,
    applyPreferences,
    dispose,
  };
}

export type MobileUpdater = ReturnType<typeof createMobileUpdater>;
