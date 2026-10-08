const signedRelease = process.env.ETA_SIGNED_RELEASE === "1";
// GitHub Actions supplies missing secrets as empty strings, which builder treats as file paths.
for (const name of [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
]) {
  if (!signedRelease || !process.env[name]?.trim()) delete process.env[name];
}
if (signedRelease) {
  for (const name of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
    if (!process.env[name]) throw new Error(`Signed releases require ${name} for notarization.`);
  }
}

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "app.eta.desktop",
  productName: "Eta",
  directories: {
    app: "dist/package",
    output: "dist/release",
    buildResources: "resources",
  },
  files: ["dist/**/*", "package.json"],
  asar: true,
  // The staged app contains its entire runtime; do not collect workspace node_modules.
  beforeBuild: async () => false,
  forceCodeSigning: signedRelease,
  artifactName: "Eta-${version}-mac-${arch}.${ext}",
  // Writes app-update.yml into the app and latest-mac.yml next to the installers for electron-updater.
  publish: { provider: "github", owner: "XiaoMouz", repo: "eta" },
  mac: {
    category: "public.app-category.developer-tools",
    icon: "resources/eta.icns",
    // Squirrel.Mac installs updates from the zip; the dmg stays the first-install download.
    target: ["dmg", "zip"],
    hardenedRuntime: signedRelease,
    identity: signedRelease ? undefined : "-",
    notarize: signedRelease,
  },
  dmg: {
    title: "Eta ${version}",
    contents: [
      { x: 150, y: 180, type: "file" },
      { x: 430, y: 180, type: "link", path: "/Applications" },
    ],
  },
};
