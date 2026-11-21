import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { containsDirectory } from "@eta/core/service/git/workspace-access";
import { CoreError } from "@eta/core/service/errors";
import { LocalizedError } from "../../shared/i18n/messages.ts";
import {
  languageForFileName,
  type WorkspaceFilePreviewResult,
} from "../../shared/workspace-files.ts";

export const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 512 * 1024;
export const WORKSPACE_FILE_PREVIEW_MAX_LINES = 5000;
const BINARY_PROBE_BYTES = 8192;

export function expandHome(rawPath: string, home = homedir()) {
  if (rawPath === "~") return home;
  if (rawPath.startsWith("~/") || rawPath.startsWith(`~${sep}`))
    return join(home, rawPath.slice(2));
  return rawPath;
}

/** Resolves a local file path relative to a workspace when needed and rejects malformed input. */
export function resolveWorkspaceFilePath(rawPath: string, workspaceCwd?: string) {
  if (!rawPath || !rawPath.trim() || rawPath.includes("\0"))
    throw new CoreError({ code: "InvalidInput", message: "请求参数无效" });
  const expanded = expandHome(rawPath.trim());
  if (isAbsolute(expanded)) return resolve(expanded);
  if (!workspaceCwd)
    throw new LocalizedError("errors:workspaceFile.workspaceRequiredForRelativePath");
  return resolve(workspaceCwd, expanded);
}

function errnoCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function describeDisplayTarget(resolved: string, workspaceCwd?: string) {
  if (!workspaceCwd) return { displayPath: resolved };
  const canonicalWorkspace = await realpath(workspaceCwd).catch(() => resolve(workspaceCwd));
  const canonicalTarget = await realpath(resolved).catch(() => resolved);
  if (!containsDirectory(canonicalWorkspace, canonicalTarget)) return { displayPath: resolved };
  const rel = relative(canonicalWorkspace, canonicalTarget).split(sep).join("/");
  return {
    displayPath: rel || basename(canonicalTarget) || resolved,
    rootName: basename(canonicalWorkspace) || basename(workspaceCwd),
  };
}

/** Reads a bounded UTF-8 file preview without loading large files or binaries into memory. */
export async function readWorkspaceFilePreview(
  rawPath: string,
  workspaceCwd?: string,
): Promise<WorkspaceFilePreviewResult> {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0"))
    return { status: "unavailable", reason: "missing", displayPath: rawPath };
  const expanded = expandHome(trimmed);
  if (!isAbsolute(expanded) && !workspaceCwd)
    return { status: "unavailable", reason: "missing", displayPath: trimmed };

  const resolved = resolveWorkspaceFilePath(trimmed, workspaceCwd);
  const { displayPath, rootName } = await describeDisplayTarget(resolved, workspaceCwd);

  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR")
      return { status: "unavailable", reason: "missing", displayPath };
    return { status: "unavailable", reason: "unreadable", absolutePath: resolved, displayPath };
  }

  if (info.isDirectory()) {
    return {
      status: "unavailable",
      reason: "directory",
      absolutePath: resolved,
      displayPath,
    };
  }

  let handle;
  try {
    handle = await open(resolved, constants.O_RDONLY);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR")
      return { status: "unavailable", reason: "missing", displayPath };
    return { status: "unavailable", reason: "unreadable", absolutePath: resolved, displayPath };
  }

  try {
    const targetBytes = Math.min(Math.max(info.size, 0), WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1);
    const buffer = Buffer.allocUnsafe(targetBytes);
    let bytesRead = 0;
    while (bytesRead < targetBytes) {
      const read = await handle.read(buffer, bytesRead, targetBytes - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }

    const probeLength = Math.min(bytesRead, BINARY_PROBE_BYTES);
    if (buffer.subarray(0, probeLength).includes(0)) {
      return {
        status: "unavailable",
        reason: "binary",
        absolutePath: resolved,
        displayPath,
      };
    }

    const truncatedByBytes =
      bytesRead > WORKSPACE_FILE_PREVIEW_MAX_BYTES || info.size > WORKSPACE_FILE_PREVIEW_MAX_BYTES;
    const sliceLength = Math.min(bytesRead, WORKSPACE_FILE_PREVIEW_MAX_BYTES);
    let content = new TextDecoder("utf-8", { fatal: false })
      .decode(buffer.subarray(0, sliceLength))
      .replace(/\r\n?/g, "\n");
    if (truncatedByBytes) {
      const lastNewline = content.lastIndexOf("\n");
      if (lastNewline >= 0) content = content.slice(0, lastNewline);
    }

    const lines = content === "" ? [] : content.split("\n");
    let truncated = truncatedByBytes;
    if (lines.length > WORKSPACE_FILE_PREVIEW_MAX_LINES) {
      content = lines.slice(0, WORKSPACE_FILE_PREVIEW_MAX_LINES).join("\n");
      truncated = true;
    }
    const totalLines =
      content === "" ? 0 : Math.min(lines.length, WORKSPACE_FILE_PREVIEW_MAX_LINES);
    const name = basename(resolved) || displayPath;
    const language = languageForFileName(name);

    return {
      status: "ready",
      absolutePath: resolved,
      displayPath,
      ...(rootName ? { rootName } : {}),
      name,
      ...(language ? { language } : {}),
      content,
      truncated,
      totalLines,
      size: info.size,
    };
  } catch {
    return {
      status: "unavailable",
      reason: "unreadable",
      absolutePath: resolved,
      displayPath,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}
