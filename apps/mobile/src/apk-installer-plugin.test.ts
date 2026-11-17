import { createRequire } from "node:module";
import { AndroidConfig, type ConfigPlugin, type ExportedConfig } from "expo/config-plugins";
import { expect, test } from "vite-plus/test";
import app from "../app.json";

const require = createRequire(import.meta.url);
const withApkInstaller = require("../plugins/with-apk-installer.cjs") as ConfigPlugin;

async function generateGradle(version: string, versionCode?: number, previous?: string) {
  const config = withApkInstaller({
    name: "Eta",
    slug: "eta-mobile",
    version,
    android: { versionCode },
  }) as ExportedConfig;
  const mod = config.mods?.android?.appBuildGradle;
  if (!mod) throw new Error("Missing Android app Gradle mod");
  let contents =
    previous ??
    `android {
 defaultConfig {
 versionName "${version}"
 versionCode ${versionCode ?? 1}
 }
 signingConfigs { debug {} }
 buildTypes { release { signingConfig signingConfigs.debug } }
}`;
  // Exercise Expo's own metadata updates before a repeated plugin pass.
  contents = AndroidConfig.Version.setVersionName(config, contents);
  contents = AndroidConfig.Version.setVersionCode(config, contents);
  const result = await mod({
    ...config,
    modRawConfig: config,
    modRequest: {
      projectRoot: process.cwd(),
      platformProjectRoot: `${process.cwd()}/android`,
      platform: "android",
      modName: "appBuildGradle",
      introspect: false,
      ignoreExistingNativeFiles: false,
    },
    modResults: { path: `${process.cwd()}/android/app/build.gradle`, language: "groovy", contents },
  });
  return result.modResults.contents;
}

function fallback(gradle: string, variable: string) {
  const line = gradle.split("\n").find((line) => line.startsWith(`def ${variable} = `));
  if (!line) throw new Error(`Missing generated ${variable}`);
  const literal = line.slice(line.lastIndexOf(" ?: ") + 4);
  const match = /^['"]([^'"]+)['"]/.exec(literal);
  if (!match) throw new Error(`Missing literal fallback in ${line}`);
  return match[1];
}

function expectMetadata(gradle: string, version: string, versionCode: number) {
  expect(fallback(gradle, "etaVersionName")).toBe(version);
  expect(Number(fallback(gradle, "etaVersionCode"))).toBe(versionCode);
  expect(gradle).toContain(
    "findProperty('ETA_MOBILE_VERSION_NAME') ?: System.getenv('ETA_MOBILE_VERSION_NAME')",
  );
  expect(gradle).toContain(
    "findProperty('ETA_MOBILE_VERSION_CODE') ?: System.getenv('ETA_MOBILE_VERSION_CODE')",
  );
  expect(gradle).toContain("versionName etaVersionName");
  expect(gradle).toContain("versionCode etaVersionCode");
}

test.each([
  { version: app.expo.version, versionCode: undefined },
  { version: "0.1.0", versionCode: 456 },
])(
  "Android Gradle defaults retain configured $version / $versionCode",
  async ({ version, versionCode }) => {
    expectMetadata(await generateGradle(version, versionCode), version, versionCode ?? 1);
  },
);

test("repeated prebuild updates defaults without duplicating signing configuration or losing overrides", async () => {
  const old = await generateGradle("0.1.1", 11);
  const current = await generateGradle("0.2.0", 42, old);
  expectMetadata(current, "0.2.0", 42);
  expect(await generateGradle("0.2.0", 42, current)).toBe(current);
});
