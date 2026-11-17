import Constants from "expo-constants";
import { Directory, DownloadTask, File, Paths } from "expo-file-system";
import * as Linking from "expo-linking";
import { NativeModules, Platform } from "react-native";

import {
  DEFAULT_RELEASES_API_URL,
  type DownloadHandle,
  type GitHubRelease,
  type ReleaseCandidate,
  type UpdaterAdapter,
} from "./updater.ts";

interface NativeApkInstaller {
  getVersionInfo(): Promise<{ versionName: string; versionCode: number }>;
  sha256File(fileUriOrPath: string): Promise<string>;
  canRequestPackageInstalls(): Promise<boolean>;
  openUnknownAppSourcesSettings(): Promise<boolean>;
  installApk(fileUriOrPath: string): Promise<boolean>;
}

const nativeInstaller = NativeModules.EtaApkInstaller as NativeApkInstaller | undefined;

export function createNativeUpdaterAdapter(): UpdaterAdapter {
  const platform = Platform.OS === "android" ? "android" : Platform.OS === "ios" ? "ios" : "web";

  const cleanUpdatesDirectory = (keepName?: string) => {
    const dir = new Directory(Paths.cache, "eta-mobile-updates");
    if (!dir.exists) return dir;
    for (const entry of dir.list()) {
      if (entry instanceof File && entry.name !== keepName) {
        try {
          entry.delete();
        } catch {
          // Ignore best-effort cache cleanup failure.
        }
      }
    }
    return dir;
  };

  return {
    platform,
    async fetchReleases(signal) {
      const response = await fetch(DEFAULT_RELEASES_API_URL, {
        headers: {
          Accept: "application/vnd.github+json",
        },
        signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as unknown;
      if (!Array.isArray(data)) throw new Error("Invalid releases payload");
      return data as GitHubRelease[];
    },
    async fetchText(url, signal) {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    async getInstalledVersion() {
      if (platform === "android" && nativeInstaller) {
        const info = await nativeInstaller.getVersionInfo();
        return {
          version: info.versionName || Constants.expoConfig?.version || "0.1.0",
          versionCode: info.versionCode,
        };
      }
      return {
        version: Constants.expoConfig?.version || "0.1.0",
      };
    },
    startDownloadApk(candidate: ReleaseCandidate, onProgress): DownloadHandle {
      if (!candidate.downloadUrl) {
        return {
          promise: Promise.reject(new Error("Missing APK download URL")),
          cancel: () => {},
        };
      }
      const fileName = `eta-mobile-${candidate.version}.apk`;
      const dir = cleanUpdatesDirectory();
      dir.create({ idempotent: true, intermediates: true });
      const destination = new File(dir, fileName);
      if (destination.exists) {
        try {
          destination.delete();
        } catch {
          // DownloadTask idempotent option will overwrite.
        }
      }

      const task = new DownloadTask(candidate.downloadUrl, destination, {
        onProgress: ({ bytesWritten, totalBytes }) => {
          onProgress(bytesWritten, totalBytes);
        },
      });

      return {
        promise: task.downloadAsync().then((downloaded) => {
          if (!downloaded) throw new Error("Download cancelled");
          return { fileUri: downloaded.uri };
        }),
        cancel: () => {
          task.cancel();
        },
      };
    },
    async sha256File(fileUri) {
      if (!nativeInstaller) throw new Error("Native APK verifier unavailable");
      return nativeInstaller.sha256File(fileUri);
    },
    async deleteFile(fileUri) {
      try {
        const target = new File(fileUri);
        if (target.exists) target.delete();
      } catch {
        // Ignore deletion failure.
      }
    },
    async canRequestPackageInstalls() {
      if (platform !== "android" || !nativeInstaller) return true;
      return nativeInstaller.canRequestPackageInstalls();
    },
    async openUnknownAppSourcesSettings() {
      if (platform !== "android" || !nativeInstaller) return;
      await nativeInstaller.openUnknownAppSourcesSettings();
    },
    async installApk(fileUri) {
      if (!nativeInstaller) throw new Error("Native APK installer unavailable");
      await nativeInstaller.installApk(fileUri);
    },
    async openExternalUrl(url) {
      await Linking.openURL(url);
    },
  };
}
