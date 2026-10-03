const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");

const configPath = path.resolve(__dirname, "../electron-builder.config.cjs");
function load(environment) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `const config = require(process.argv[1]);
       console.log(JSON.stringify({
         certificate: process.env.CSC_LINK ?? null,
         password: process.env.CSC_KEY_PASSWORD ?? null,
         identity: config.mac.identity ?? null,
         notarize: config.mac.notarize
       }));`,
      configPath,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ETA_SIGNED_RELEASE: "0",
        CSC_LINK: "",
        CSC_KEY_PASSWORD: "",
        APPLE_ID: "",
        APPLE_APP_SPECIFIC_PASSWORD: "",
        APPLE_TEAM_ID: "",
        ...environment,
      },
    },
  );
}

void test("unsigned CI builds ignore empty and configured signing secrets", () => {
  for (const certificate of ["", "   ", "/nonexistent/certificate.p12"]) {
    const result = load({ CSC_LINK: certificate, CSC_KEY_PASSWORD: "ignored" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      certificate: null,
      password: null,
      identity: "-",
      notarize: false,
    });
  }
});

void test("signed builds reject missing notarization credentials before packaging", () => {
  const result = load({ ETA_SIGNED_RELEASE: "1", APPLE_ID: "   " });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Signed releases require APPLE_ID/);
});

void test("signed builds retain provided certificates and allow a keychain identity", () => {
  for (const certificate of ["", "/certificate.p12"]) {
    const result = load({
      ETA_SIGNED_RELEASE: "1",
      CSC_LINK: certificate,
      CSC_KEY_PASSWORD: "test-password",
      APPLE_ID: "test-account",
      APPLE_APP_SPECIFIC_PASSWORD: "test-password",
      APPLE_TEAM_ID: "test-team",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      certificate: certificate || null,
      password: "test-password",
      identity: null,
      notarize: true,
    });
  }
});
