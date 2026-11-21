import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalizedError } from "../../shared/i18n/messages.ts";
import type { FileEditorOption } from "../../shared/workspace-files.ts";
import { expandHome } from "./workspace-file.ts";

const execute = promisify(execFile);

export interface EditorDefinition {
  readonly id: string;
  readonly name: string;
  readonly macAppPaths: readonly string[];
  readonly macCliPaths: readonly string[];
  readonly pathCommands: readonly string[];
  readonly goto: "--goto" | "colon";
}

const editorList: readonly EditorDefinition[] = [
  {
    id: "vscode",
    name: "Visual Studio Code",
    macAppPaths: ["/Applications/Visual Studio Code.app", "~/Applications/Visual Studio Code.app"],
    macCliPaths: [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      "~/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ],
    pathCommands: ["code"],
    goto: "--goto",
  },
  {
    id: "cursor",
    name: "Cursor",
    macAppPaths: ["/Applications/Cursor.app", "~/Applications/Cursor.app"],
    macCliPaths: [
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      "~/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    ],
    pathCommands: ["cursor"],
    goto: "--goto",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    macAppPaths: ["/Applications/Windsurf.app", "~/Applications/Windsurf.app"],
    macCliPaths: [
      "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf",
      "~/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf",
    ],
    pathCommands: ["windsurf"],
    goto: "--goto",
  },
  {
    id: "zed",
    name: "Zed",
    macAppPaths: ["/Applications/Zed.app", "~/Applications/Zed.app"],
    macCliPaths: [
      "/Applications/Zed.app/Contents/MacOS/cli",
      "~/Applications/Zed.app/Contents/MacOS/cli",
    ],
    pathCommands: ["zed"],
    goto: "colon",
  },
  {
    id: "vscode-insiders",
    name: "Visual Studio Code - Insiders",
    macAppPaths: [
      "/Applications/Visual Studio Code - Insiders.app",
      "~/Applications/Visual Studio Code - Insiders.app",
    ],
    macCliPaths: [
      "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
      "~/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
    ],
    pathCommands: ["code-insiders"],
    goto: "--goto",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    macAppPaths: ["/Applications/Antigravity.app", "~/Applications/Antigravity.app"],
    macCliPaths: [
      "/Applications/Antigravity.app/Contents/Resources/app/bin/agy",
      "~/Applications/Antigravity.app/Contents/Resources/app/bin/agy",
    ],
    pathCommands: ["agy"],
    goto: "--goto",
  },
];

const editorsById = new Map(editorList.map((editor) => [editor.id, editor]));

export interface EditorDetectionOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly exists?: (path: string, kind: "app" | "cli") => Promise<boolean>;
}

export interface EditorLaunchOptions extends EditorDetectionOptions {
  readonly exec?: (file: string, args: readonly string[]) => Promise<unknown>;
  readonly spawnDetached?: (command: string, args: readonly string[]) => Promise<void>;
}

async function defaultExists(targetPath: string, kind: "app" | "cli", platform: NodeJS.Platform) {
  try {
    const mode = kind === "cli" && platform !== "win32" ? constants.X_OK : constants.F_OK;
    await access(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

async function defaultSpawnDetached(command: string, args: readonly string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function firstExisting(
  candidates: readonly string[],
  kind: "app" | "cli",
  exists: (path: string, kind: "app" | "cli") => Promise<boolean>,
) {
  for (const candidate of candidates) {
    if (await exists(candidate, kind)) return candidate;
  }
  return undefined;
}

function cliCandidates(editor: EditorDefinition, options: Required<EditorDetectionOptions>) {
  const candidates: string[] = [];
  if (options.platform === "darwin") {
    for (const cliPath of editor.macCliPaths) candidates.push(expandHome(cliPath, options.home));
  }
  const pathValue = options.env.PATH ?? "";
  const separator = options.platform === "win32" ? ";" : ":";
  const pathDirs = pathValue.split(separator).filter(Boolean);
  for (const command of editor.pathCommands) {
    for (const dir of pathDirs) {
      candidates.push(join(dir, command));
      if (options.platform === "win32" && !/\.(exe|cmd|bat)$/i.test(command)) {
        candidates.push(join(dir, `${command}.cmd`), join(dir, `${command}.exe`));
      }
    }
  }
  return candidates;
}

function resolveOptions(options?: EditorDetectionOptions): Required<EditorDetectionOptions> {
  const platform = options?.platform ?? process.platform;
  return {
    platform,
    env: options?.env ?? process.env,
    home: options?.home ?? homedir(),
    exists: options?.exists ?? ((targetPath, kind) => defaultExists(targetPath, kind, platform)),
  };
}

/** Formats editor CLI arguments, preserving optional line and column positioning. */
export function buildEditorArgs(
  editor: Pick<EditorDefinition, "goto">,
  file: string,
  line?: number,
  column?: number,
): string[] {
  const validLine =
    typeof line === "number" && Number.isInteger(line) && line > 0 ? line : undefined;
  const validCol =
    typeof column === "number" && Number.isInteger(column) && column > 0 ? column : undefined;
  if (!validLine) return [file];
  const location = validCol ? `${file}:${validLine}:${validCol}` : `${file}:${validLine}`;
  return editor.goto === "--goto" ? ["--goto", location] : [location];
}

/** Detects installed desktop editors using fast filesystem checks without spawning processes. */
export async function detectInstalledEditors(
  options?: EditorDetectionOptions,
): Promise<FileEditorOption[]> {
  const resolved = resolveOptions(options);
  const found: FileEditorOption[] = [];
  for (const editor of editorList) {
    const hasCli = Boolean(
      await firstExisting(cliCandidates(editor, resolved), "cli", resolved.exists),
    );
    const hasApp =
      !hasCli &&
      resolved.platform === "darwin" &&
      Boolean(
        await firstExisting(
          editor.macAppPaths.map((appPath) => expandHome(appPath, resolved.home)),
          "app",
          resolved.exists,
        ),
      );
    if (hasCli || hasApp) found.push({ id: editor.id, name: editor.name });
  }
  return found;
}

/** Opens a local file in the chosen installed editor, jumping to line/column when its CLI exists. */
export async function openFileWithEditor(
  file: string,
  editorId: string,
  line?: number,
  column?: number,
  options?: EditorLaunchOptions,
) {
  const editor = editorsById.get(editorId);
  if (!editor) throw new LocalizedError("errors:handlers.editorUnavailable");
  const resolved = resolveOptions(options);
  const cli = await firstExisting(cliCandidates(editor, resolved), "cli", resolved.exists);
  if (cli) {
    const launch = options?.spawnDetached ?? defaultSpawnDetached;
    await launch(cli, buildEditorArgs(editor, file, line, column));
    return;
  }
  if (resolved.platform === "darwin") {
    const appPath = await firstExisting(
      editor.macAppPaths.map((entry) => expandHome(entry, resolved.home)),
      "app",
      resolved.exists,
    );
    if (appPath) {
      const exec = options?.exec ?? ((cmd, args) => execute(cmd, [...args]));
      await exec("/usr/bin/open", ["-a", appPath, file]);
      return;
    }
  }
  throw new LocalizedError("errors:handlers.editorUnavailable");
}
