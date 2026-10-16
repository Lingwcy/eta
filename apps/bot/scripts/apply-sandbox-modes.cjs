#!/usr/bin/env node
"use strict";

const { readFileSync, writeFileSync } = require("node:fs");

function configureSandboxModes(config, enableFullAccess) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("Bot config must be a JSON object");
  }
  if (typeof enableFullAccess !== "boolean") {
    throw new TypeError("enable_full_access must be true or false");
  }

  const configuredModes = config.allowedSandboxModes ?? ["read-only", "workspace-write"];
  if (!Array.isArray(configuredModes) || configuredModes.some((mode) => typeof mode !== "string")) {
    throw new TypeError("allowedSandboxModes must be an array of strings");
  }

  const modes = new Set(configuredModes);
  if (enableFullAccess) modes.add("danger-full-access");
  else modes.delete("danger-full-access");
  return { ...config, allowedSandboxModes: [...modes] };
}

if (require.main === module) {
  const [configPath, enableFullAccessValue] = process.argv.slice(2);
  if (!configPath || !["true", "false"].includes(enableFullAccessValue)) {
    console.error("Usage: apply-sandbox-modes.cjs CONFIG_PATH true|false");
    process.exitCode = 2;
  } else {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const nextConfig = configureSandboxModes(config, enableFullAccessValue === "true");
    writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }
}

module.exports = { configureSandboxModes };
