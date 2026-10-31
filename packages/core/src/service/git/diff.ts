import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Context, Effect, Layer } from "effect";
import { runGit } from "../../platform/git.ts";
import type {
  DiffContent,
  DiffFile,
  WorkspaceChanges,
  WorkspaceChangesInput,
  WorkspaceDiffScope,
  WorkspaceFileDiffInput,
} from "../../shared/diff.ts";
import { adapter, CoreError } from "../errors.ts";
import { WorkspaceService } from "../workspaces/index.ts";

export const WORKSPACE_DIFF_MAX_FILES = 1000;
export const WORKSPACE_DIFF_MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINES = 20000;
const MAX_LINE_LENGTH = 20000;
const MAX_PATCH_BYTES = 3 * WORKSPACE_DIFF_MAX_FILE_BYTES;
const gitOptions = { timeoutMs: 10000 };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => new CoreError({ code: "InvalidInput", message: "Diff 查询参数无效" });
const unavailable = () =>
  new CoreError({ code: "WorkspaceUnavailable", message: "无法读取工作区差异" });
const literal = (path: string) => `:(top,literal)${path}`;
// Git patch paths use C-style octal escapes, not JSON Unicode escapes.
const quotePatchPath = (path: string) =>
  `"${[...Buffer.from(path)].map((byte) => (byte >= 32 && byte < 127 && byte !== 34 && byte !== 92 ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`)).join("")}"`;
const terminator = (value: string) => (value.endsWith("\n") ? value.slice(0, -1) : value);
const within = (root: string, path: string) => {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
};
const validPath = (path: string) =>
  path.length > 0 &&
  !isAbsolute(path) &&
  !path.split("/").some((part) => part === ".." || part === ".git" || part === "");

async function checked(cwd: string, args: readonly string[]) {
  const result = await runGit(cwd, args, gitOptions);
  if (result.exitCode !== 0) throw unavailable();
  return result.stdout;
}

function validateInput(input: WorkspaceChangesInput) {
  if (!input.workspaceId || !["all", "staged", "unstaged"].includes(input.scope)) throw invalid();
}

interface IndexEntry {
  mode: string;
  sha: string;
  stage: string;
}
interface StatusEntry {
  path: string;
  oldPath?: string;
  x: string;
  y: string;
}
interface Snapshot {
  result: Extract<WorkspaceChanges, { status: "ready" }>;
  root: string;
  cwd: string;
  prefix: string;
  head?: string;
  fileMode: boolean;
  index: Map<string, IndexEntry>;
  entries: Map<string, StatusEntry>;
}

function parseIndex(output: string) {
  const entries = new Map<string, IndexEntry>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, sha, stage] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (tab < 0 || !mode || !sha || !stage || !validPath(path)) throw unavailable();
    if (stage === "0") entries.set(path, { mode, sha, stage });
  }
  return entries;
}

function parseStatus(output: string) {
  const entries: StatusEntry[] = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw unavailable();
    const x = record[0]!;
    const y = record[1]!;
    const path = record.slice(3);
    const oldPath = x === "R" || x === "C" || y === "R" || y === "C" ? records[++index] : undefined;
    if (!validPath(path) || (oldPath !== undefined && !validPath(oldPath))) throw unavailable();
    entries.push({ path, x, y, ...(oldPath ? { oldPath } : {}) });
  }
  return entries;
}

const conflicted = ({ x, y }: StatusEntry) =>
  x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
function kind(entry: StatusEntry, scope: WorkspaceDiffScope): DiffFile["kind"] {
  if (conflicted(entry)) return "conflicted";
  if (entry.x === "?") return "untracked";
  const state =
    scope === "staged"
      ? entry.x
      : scope === "unstaged"
        ? entry.y
        : entry.y === "D"
          ? "D"
          : entry.x !== " "
            ? entry.x
            : entry.y;
  if (state === "R" || state === "C") return "renamed";
  if (state === "A") return "added";
  if (state === "D") return "deleted";
  if (state === "T") return "type-changed";
  return "modified";
}

async function fileSignature(cwd: string, path: string): Promise<string> {
  try {
    const absolute = join(cwd, path);
    if (!within(cwd, await realpath(dirname(absolute)))) return "outside";
    const info = await lstat(absolute, { bigint: true });
    return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return "missing";
    throw unavailable();
  }
}

async function snapshot(cwd: string, input: WorkspaceChangesInput): Promise<Snapshot | undefined> {
  validateInput(input);
  const located = await runGit(cwd, ["rev-parse", "--show-toplevel"], gitOptions);
  if (located.exitCode !== 0) {
    if (/not a git repository/i.test(located.stderr)) return undefined;
    throw unavailable();
  }
  const root = await realpath(terminator(located.stdout));
  const actual = await realpath(cwd);
  if (!within(root, actual)) throw unavailable();
  const prefix = relative(root, actual).split(sep).join("/");
  const scopedPath = (path: string) =>
    !prefix ? path : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined;
  const [gitDir, indexOutput, statusOutput, headResult, fileModeResult] = await Promise.all([
    checked(cwd, ["rev-parse", "--absolute-git-dir"]),
    checked(cwd, ["ls-files", "--stage", "-z", "--full-name", "--", "."]),
    checked(cwd, [
      "-c",
      "status.renames=true",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--",
      ".",
    ]),
    runGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"], gitOptions),
    runGit(cwd, ["config", "--type=bool", "--get", "core.filemode"], gitOptions),
  ]);
  if (fileModeResult.exitCode !== 0 && fileModeResult.exitCode !== 1) throw unavailable();
  const fileMode = fileModeResult.exitCode === 1 || terminator(fileModeResult.stdout) === "true";
  let head: string | undefined;
  if (headResult.exitCode === 0 && /^[a-f0-9]{40,64}\n?$/.test(headResult.stdout))
    head = terminator(headResult.stdout);
  else {
    const symbolic = await runGit(cwd, ["symbolic-ref", "-q", "HEAD"], gitOptions);
    if (symbolic.exitCode !== 0) throw unavailable();
    const exists = await runGit(
      cwd,
      ["show-ref", "--verify", "--quiet", terminator(symbolic.stdout)],
      gitOptions,
    );
    if (exists.exitCode !== 1) throw unavailable();
  }
  const index = parseIndex(indexOutput);
  const merged = new Map<string, StatusEntry>();
  for (const raw of parseStatus(statusOutput)) {
    let path = scopedPath(raw.path);
    let oldPath = raw.oldPath ? scopedPath(raw.oldPath) : undefined;
    let entry = raw;
    // A rename that crosses a subdirectory workspace is only visible on its admitted side.
    if (path === undefined && oldPath !== undefined) {
      path = oldPath;
      oldPath = undefined;
      entry = {
        path: raw.oldPath!,
        x: raw.x === "R" ? "D" : raw.x,
        y: raw.y === "R" ? "D" : raw.y,
      };
    } else if (path !== undefined && raw.oldPath && oldPath === undefined) {
      entry = { ...raw, x: raw.x === "R" ? "A" : raw.x, y: raw.y === "R" ? "A" : raw.y };
    }
    if (path === undefined) continue;
    const existing = merged.get(path);
    if (existing && raw.x === "?") {
      merged.set(path, { ...existing, y: "?" });
      continue;
    }
    merged.set(path, { path, ...(oldPath ? { oldPath } : {}), x: entry.x, y: entry.y });
  }
  const candidates = [...merged.values()].filter(
    (entry) =>
      input.scope === "all" ||
      conflicted(entry) ||
      (input.scope === "staged" ? entry.x !== " " && entry.x !== "?" : entry.y !== " "),
  );
  candidates.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const selected = candidates.slice(0, WORKSPACE_DIFF_MAX_FILES);
  const entries = new Map<string, StatusEntry>();
  const files = selected.map((entry) => {
    const id = digest(JSON.stringify([input.scope, entry.path, entry.oldPath]));
    entries.set(id, entry);
    const rootPath = prefix ? `${prefix}/${entry.path}` : entry.path;
    return {
      id,
      path: entry.path,
      ...(entry.oldPath && input.scope !== "unstaged" ? { oldPath: entry.oldPath } : {}),
      kind: index.get(rootPath)?.mode === "160000" ? "submodule" : kind(entry, input.scope),
      staged: entry.x !== " " && entry.x !== "?",
      unstaged: entry.y !== " " || entry.x === "?",
    } satisfies DiffFile;
  });
  const signatures: string[] = [];
  // Bound filesystem concurrency independently of the number of dirty files.
  for (let offset = 0; offset < selected.length; offset += 16)
    signatures.push(
      ...(await Promise.all(
        selected
          .slice(offset, offset + 16)
          .map(async (entry) => `${entry.path}\0${await fileSignature(actual, entry.path)}`),
      )),
    );
  const revision = digest(
    JSON.stringify([
      root,
      terminator(gitDir),
      actual,
      input.scope,
      head,
      fileMode,
      indexOutput,
      statusOutput,
      signatures,
    ]),
  );
  return {
    root,
    cwd: actual,
    prefix,
    ...(head ? { head } : {}),
    fileMode,
    index,
    entries,
    result: {
      status: "ready",
      workspaceId: input.workspaceId,
      scope: input.scope,
      revision,
      files,
      ...(candidates.length > selected.length ? { truncated: true } : {}),
    },
  };
}

interface BlobEntry {
  mode: string;
  sha: string;
  size: number;
}
async function headEntry(state: Snapshot, path: string): Promise<BlobEntry | undefined> {
  if (!state.head) return undefined;
  const record = await checked(state.root, [
    "ls-tree",
    "-z",
    "-l",
    state.head,
    "--",
    literal(path),
  ]);
  if (!record) return undefined;
  const tab = record.indexOf("\t");
  const match = /^(\d+) (blob|commit) ([a-f0-9]+) +([0-9-]+)$/.exec(record.slice(0, tab));
  if (!match || record.slice(tab + 1, -1) !== path) throw unavailable();
  return { mode: match[1]!, sha: match[3]!, size: match[4] === "-" ? 0 : Number(match[4]) };
}

const unavailableContent = (
  reason: Extract<DiffContent, { status: "unavailable" }>["reason"],
): DiffContent => ({ status: "unavailable", reason });
interface FileContent {
  content: string;
  mode: string;
}
type Content = FileContent | null | Extract<DiffContent, { status: "unavailable" }>;
const isUnavailable = (value: Content): value is Extract<DiffContent, { status: "unavailable" }> =>
  value !== null && "status" in value;
function textLimit(content: string): Content | undefined {
  if (content.includes("\0")) return { status: "unavailable", reason: "binary" };
  const lines = content.split("\n");
  if (
    Buffer.byteLength(content) > WORKSPACE_DIFF_MAX_FILE_BYTES ||
    lines.length > MAX_LINES ||
    lines.some((line) => line.length > MAX_LINE_LENGTH)
  )
    return { status: "unavailable", reason: "too-large" };
  return undefined;
}

async function blobContent(
  state: Snapshot,
  entry: BlobEntry | IndexEntry | undefined,
): Promise<Content> {
  if (!entry) return null;
  if (entry.mode === "160000") return { status: "unavailable", reason: "submodule" };
  if (entry.mode === "120000") return { status: "unavailable", reason: "symlink" };
  const size =
    "size" in entry
      ? entry.size
      : Number(terminator(await checked(state.root, ["cat-file", "-s", entry.sha])));
  if (!Number.isSafeInteger(size) || size < 0) throw unavailable();
  if (size > WORKSPACE_DIFF_MAX_FILE_BYTES) return { status: "unavailable", reason: "too-large" };
  const content = await checked(state.root, ["cat-file", "blob", entry.sha]);
  // execFile decodes stdout as UTF-8. Verify the object identity rather than treating a
  // legitimate U+FFFD as binary or trusting byte length to prove lossless decoding.
  const object = createHash(entry.sha.length === 64 ? "sha256" : "sha1")
    .update(`blob ${size}\0`)
    .update(content)
    .digest("hex");
  if (object !== entry.sha) return { status: "unavailable", reason: "binary" };
  return textLimit(content) ?? { content, mode: entry.mode };
}

async function worktreeContent(state: Snapshot, path: string, indexMode: string): Promise<Content> {
  const absolute = join(state.cwd, path);
  try {
    if (!within(state.cwd, await realpath(dirname(absolute))))
      return { status: "unavailable", reason: "symlink" };
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) return { status: "unavailable", reason: "symlink" };
    if (metadata.isDirectory()) return { status: "unavailable", reason: "submodule" };
    if (!metadata.isFile()) return { status: "unavailable", reason: "unsupported" };
    if (metadata.size > WORKSPACE_DIFF_MAX_FILE_BYTES)
      return { status: "unavailable", reason: "too-large" };
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > WORKSPACE_DIFF_MAX_FILE_BYTES)
        return { status: "unavailable", reason: "too-large" };
      // A bounded positional read cannot grow without limit if another process appends.
      const buffer = Buffer.alloc(WORKSPACE_DIFF_MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > WORKSPACE_DIFF_MAX_FILE_BYTES)
        return { status: "unavailable", reason: "too-large" };
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, length),
        );
      } catch {
        return { status: "unavailable", reason: "binary" };
      }
      const mode = state.fileMode ? (info.mode & 0o111 ? "100755" : "100644") : indexMode;
      return textLimit(content) ?? { content, mode };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;
    if (error instanceof Error && "code" in error && error.code === "ELOOP")
      return { status: "unavailable", reason: "symlink" };
    throw error;
  }
}

/** Diff bounded snapshots outside the repository, so staged deletion/recreation and Git filters cannot change the comparison. */
async function contentPatch(
  path: string,
  oldPath: string | undefined,
  before: FileContent | null,
  after: FileContent | null,
) {
  if (before === null && after === null) return "";
  const temporary = await mkdtemp(join(tmpdir(), "eta-readonly-diff-"));
  const beforePath = `a/${oldPath ?? path}`;
  const afterPath = `b/${path}`;
  try {
    for (const [name, value] of [
      [beforePath, before],
      [afterPath, after],
    ] as const) {
      if (value === null) continue;
      const file = join(temporary, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, value.content);
      await chmod(file, value.mode === "100755" ? 0o755 : 0o644);
    }
    const result = await runGit(
      temporary,
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-prefix",
        "--text",
        "--",
        before === null ? "/dev/null" : beforePath,
        after === null ? "/dev/null" : afterPath,
      ],
      gitOptions,
    );
    if (result.exitCode !== 0 && result.exitCode !== 1) throw unavailable();
    if (Buffer.byteLength(result.stdout) > MAX_PATCH_BYTES) return undefined;
    let patch = result.stdout;
    const header = `diff --git ${quotePatchPath(beforePath)} ${quotePatchPath(afterPath)}\n`;
    if (patch) patch = header + patch.slice(patch.indexOf("\n") + 1);
    if (oldPath && oldPath !== path && before && after) {
      const rename = `rename from ${quotePatchPath(oldPath)}\nrename to ${quotePatchPath(path)}\n`;
      patch = patch
        ? patch.replace(header, header + rename)
        : header + "similarity index 100%\n" + rename;
    }
    return patch;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function readWorkspaceChanges(
  cwd: string,
  input: WorkspaceChangesInput,
): Promise<WorkspaceChanges> {
  return (
    (await snapshot(cwd, input))?.result ?? {
      status: "not-repository",
      workspaceId: input.workspaceId,
    }
  );
}

export async function readWorkspaceFileDiff(
  cwd: string,
  input: WorkspaceFileDiffInput,
): Promise<DiffContent> {
  validateInput(input);
  if (!input.entryId || !input.expectedRevision) throw invalid();
  const state = await snapshot(cwd, input);
  if (!state || state.result.revision !== input.expectedRevision)
    return unavailableContent("stale");
  const entry = state.entries.get(input.entryId);
  if (!entry) return unavailableContent("stale");
  if (conflicted(entry)) return unavailableContent("conflicted");
  const rootPath = (path: string) => (state.prefix ? `${state.prefix}/${path}` : path);
  const previousPath = input.scope === "unstaged" ? entry.path : (entry.oldPath ?? entry.path);
  const indexEntry = state.index.get(rootPath(entry.path));
  const beforeEntry =
    input.scope === "unstaged" ? indexEntry : await headEntry(state, rootPath(previousPath));
  const before = await blobContent(state, beforeEntry);
  if (isUnavailable(before)) return before;
  const after =
    input.scope === "staged"
      ? await blobContent(state, indexEntry)
      : await worktreeContent(
          state,
          entry.path,
          indexEntry?.mode === "100755" ? "100755" : "100644",
        );
  if (isUnavailable(after)) return after;
  const oldPath = input.scope !== "unstaged" ? entry.oldPath : undefined;
  const patch = await contentPatch(entry.path, oldPath, before, after);
  const current = await snapshot(cwd, input);
  if (!current || current.result.revision !== state.result.revision)
    return unavailableContent("stale");
  if (patch === undefined) return unavailableContent("too-large");
  return { status: "ready", path: entry.path, ...(oldPath ? { oldPath } : {}), patch };
}

export class WorkspaceDiffService extends Context.Service<
  WorkspaceDiffService,
  {
    workspaceChanges(input: WorkspaceChangesInput): Effect.Effect<WorkspaceChanges, CoreError>;
    workspaceFileDiff(input: WorkspaceFileDiffInput): Effect.Effect<DiffContent, CoreError>;
  }
>()("eta/core/service/git/WorkspaceDiffService") {
  static readonly layer = Layer.effect(
    WorkspaceDiffService,
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceService;
      return WorkspaceDiffService.of({
        workspaceChanges: Effect.fn("WorkspaceDiffService.workspaceChanges")(function* (
          input: WorkspaceChangesInput,
        ) {
          const workspace = yield* workspaces.validate(input.workspaceId);
          return yield* adapter(
            "无法读取工作区差异",
            () => readWorkspaceChanges(workspace.cwd, input),
            "WorkspaceUnavailable",
          );
        }),
        workspaceFileDiff: Effect.fn("WorkspaceDiffService.workspaceFileDiff")(function* (
          input: WorkspaceFileDiffInput,
        ) {
          const workspace = yield* workspaces.validate(input.workspaceId);
          return yield* adapter(
            "无法读取文件差异",
            () => readWorkspaceFileDiff(workspace.cwd, input),
            "WorkspaceUnavailable",
          );
        }),
      });
    }),
  );
}
