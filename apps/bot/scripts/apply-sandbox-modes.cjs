#!/usr/bin/env node
"use strict";

const {
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { basename, dirname, join } = require("node:path");
const { randomUUID } = require("node:crypto");

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
  if (enableFullAccess) {
    modes.add("danger-full-access");
  } else {
    modes.delete("danger-full-access");
    if (
      !modes.has("read-only") &&
      !modes.has("workspace-write") &&
      configuredModes.includes("danger-full-access")
    ) {
      modes.add("read-only");
    }

    const runtime = config.runtime ?? {};
    if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime)) {
      throw new TypeError("runtime must be a JSON object");
    }
    const defaultMode = runtime.defaultSandboxMode ?? "workspace-write";
    if (!modes.has(defaultMode)) {
      const fallback = ["workspace-write", "read-only"].find((mode) => modes.has(mode));
      if (!fallback) {
        throw new Error(
          "Cannot disable full access: configure at least one restricted mode in allowedSandboxModes",
        );
      }
      config = { ...config, runtime: { ...runtime, defaultSandboxMode: fallback } };
    }
  }

  return { ...config, allowedSandboxModes: [...modes] };
}

function writeConfigAtomically(configPath, config) {
  const directory = dirname(configPath);
  const original = lstatSync(configPath);
  if (!original.isFile()) throw new Error("Bot config must be a regular file");

  const temporaryPath = join(
    directory,
    `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", original.mode & 0o777);
    writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    const temporary = lstatSync(temporaryPath);
    if (temporary.uid !== original.uid || temporary.gid !== original.gid) {
      chownSync(temporaryPath, original.uid, original.gid);
    }
    chmodSync(temporaryPath, original.mode & 0o777);
    renameSync(temporaryPath, configPath);

    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

if (require.main === module) {
  const [configPath, enableFullAccessValue] = process.argv.slice(2);
  if (!configPath || !["true", "false"].includes(enableFullAccessValue)) {
    console.error("Usage: apply-sandbox-modes.cjs CONFIG_PATH true|false");
    process.exitCode = 2;
  } else {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const nextConfig = configureSandboxModes(config, enableFullAccessValue === "true");
      writeConfigAtomically(configPath, nextConfig);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

module.exports = { configureSandboxModes, writeConfigAtomically };
