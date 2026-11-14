const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withMainApplication,
} = require("expo/config-plugins");

const APK_INSTALLER_MODULE = `package com.eta.mobile

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

class ApkInstallerModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "EtaApkInstaller"

  private fun resolveFile(uriOrPath: String): File {
    val cleaned = if (uriOrPath.startsWith("file://")) {
      Uri.parse(uriOrPath).path ?: uriOrPath.removePrefix("file://")
    } else {
      uriOrPath
    }
    return File(cleaned)
  }

  @ReactMethod
  fun getVersionInfo(promise: Promise) {
    try {
      val pm = reactContext.packageManager
      val pkgName = reactContext.packageName
      val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.getPackageInfo(pkgName, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(pkgName, 0)
      }
      val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.longVersionCode.toDouble()
      } else {
        @Suppress("DEPRECATION")
        info.versionCode.toDouble()
      }
      val result = Arguments.createMap().apply {
        putString("versionName", info.versionName ?: "")
        putDouble("versionCode", versionCode)
      }
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("VERSION_ERROR", error.message, error)
    }
  }

  @ReactMethod
  fun sha256File(fileUriOrPath: String, promise: Promise) {
    Thread {
      try {
        val file = resolveFile(fileUriOrPath)
        if (!file.exists() || !file.isFile) {
          promise.reject("FILE_NOT_FOUND", "APK file not found: \${file.absolutePath}")
          return@Thread
        }
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(8192)
        FileInputStream(file).use { input ->
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            digest.update(buffer, 0, read)
          }
        }
        val hex = digest.digest().joinToString("") { "%02x".format(it) }
        promise.resolve(hex)
      } catch (error: Exception) {
        promise.reject("HASH_ERROR", error.message, error)
      }
    }.start()
  }

  @ReactMethod
  fun canRequestPackageInstalls(promise: Promise) {
    try {
      val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
      promise.resolve(allowed)
    } catch (error: Exception) {
      promise.reject("PERMISSION_CHECK_ERROR", error.message, error)
    }
  }

  @ReactMethod
  fun openUnknownAppSourcesSettings(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val intent = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:\${reactContext.packageName}"),
        ).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        reactContext.startActivity(intent)
      }
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("SETTINGS_ERROR", error.message, error)
    }
  }

  @ReactMethod
  fun installApk(fileUriOrPath: String, promise: Promise) {
    try {
      val file = resolveFile(fileUriOrPath)
      if (!file.exists() || !file.isFile) {
        promise.reject("FILE_NOT_FOUND", "APK file not found: \${file.absolutePath}")
        return
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !reactContext.packageManager.canRequestPackageInstalls()
      ) {
        promise.reject(
          "INSTALL_PERMISSION_REQUIRED",
          "Allow installing unknown apps for Eta first.",
        )
        return
      }
      val authority = "\${reactContext.packageName}.fileprovider"
      val contentUri = FileProvider.getUriForFile(reactContext, authority, file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("INSTALL_ERROR", error.message, error)
    }
  }
}
`;

const APK_INSTALLER_PACKAGE = `package com.eta.mobile

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class ApkInstallerPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(ApkInstallerModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
`;

const APK_FILE_PATHS_XML = `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <cache-path name="apk_updates" path="." />
  <files-path name="apk_files" path="." />
</paths>
`;

/** Injects Android APK installer module, FileProvider, permissions, and env-driven release signing during expo prebuild. */
module.exports = function withApkInstaller(config) {
  config = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.REQUEST_INSTALL_PACKAGES",
  ]);

  config = withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    app.provider = app.provider ?? [];
    const authority = "${applicationId}.fileprovider";
    const exists = app.provider.some((entry) => entry.$?.["android:authorities"] === authority);
    if (!exists) {
      app.provider.push({
        $: {
          "android:name": "androidx.core.content.FileProvider",
          "android:authorities": authority,
          "android:exported": "false",
          "android:grantUriPermissions": "true",
        },
        "meta-data": [
          {
            $: {
              "android:name": "android.support.FILE_PROVIDER_PATHS",
              "android:resource": "@xml/apk_file_paths",
            },
          },
        ],
      });
    }
    return mod;
  });

  config = withMainApplication(config, (mod) => {
    if (!mod.modResults.contents.includes("ApkInstallerPackage()")) {
      mod.modResults.contents = mod.modResults.contents.replace(
        "PackageList(this).packages.apply {",
        "PackageList(this).packages.apply {\n              add(ApkInstallerPackage())",
      );
    }
    return mod;
  });

  config = withAppBuildGradle(config, (mod) => {
    let contents = mod.modResults.contents;
    if (!contents.includes("etaVersionName")) {
      const header = `def etaVersionName = (findProperty('ETA_MOBILE_VERSION_NAME') ?: System.getenv('ETA_MOBILE_VERSION_NAME') ?: '0.1.0').toString()
def etaVersionCode = ((findProperty('ETA_MOBILE_VERSION_CODE') ?: System.getenv('ETA_MOBILE_VERSION_CODE') ?: '1').toString()).toInteger()
def etaKeystorePath = (findProperty('ETA_ANDROID_KEYSTORE_PATH') ?: System.getenv('ETA_ANDROID_KEYSTORE_PATH'))?.toString()

`;
      contents = contents.replace("android {", `${header}android {`);
      contents = contents.replace(/versionCode\s+\d+/, "versionCode etaVersionCode");
      contents = contents.replace(/versionName\s+"[^"]+"/, "versionName etaVersionName");
      contents = contents.replace(
        "signingConfigs {",
        `signingConfigs {
        if (etaKeystorePath) {
            release {
                storeFile file(etaKeystorePath)
                storePassword((findProperty('ETA_ANDROID_STORE_PASSWORD') ?: System.getenv('ETA_ANDROID_STORE_PASSWORD') ?: '').toString())
                keyAlias((findProperty('ETA_ANDROID_KEY_ALIAS') ?: System.getenv('ETA_ANDROID_KEY_ALIAS') ?: '').toString())
                keyPassword((findProperty('ETA_ANDROID_KEY_PASSWORD') ?: System.getenv('ETA_ANDROID_KEY_PASSWORD') ?: '').toString())
            }
        }`,
      );
      contents = contents.replace(
        /release\s*\{[\s\S]*?signingConfig\s+signingConfigs\.debug/,
        (block) =>
          block.replace(
            "signingConfig signingConfigs.debug",
            "signingConfig etaKeystorePath ? signingConfigs.release : signingConfigs.debug",
          ),
      );
      mod.modResults.contents = contents;
    }
    return mod;
  });

  config = withDangerousMod(config, [
    "android",
    async (mod) => {
      const projectRoot = mod.modRequest.platformProjectRoot;
      const javaDir = path.join(projectRoot, "app/src/main/java/com/eta/mobile");
      const xmlDir = path.join(projectRoot, "app/src/main/res/xml");
      fs.mkdirSync(javaDir, { recursive: true });
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(javaDir, "ApkInstallerModule.kt"), APK_INSTALLER_MODULE);
      fs.writeFileSync(path.join(javaDir, "ApkInstallerPackage.kt"), APK_INSTALLER_PACKAGE);
      fs.writeFileSync(path.join(xmlDir, "apk_file_paths.xml"), APK_FILE_PATHS_XML);
      return mod;
    },
  ]);

  return config;
};
