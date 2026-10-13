import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@eta/agent/env";

export const REVIEW_TOOL_OUTPUT_LIMIT = 16 * 1024;
const COMMAND_TIMEOUT_SECONDS = 15;

/** Read-only context gathering for the reviewer; nothing here can widen the reviewed request. */
export const reviewTools: Tool[] = [
  {
    name: "read",
    description:
      "Read a text file inside the workspace or this repository's shared Git directory. Paths are relative to the workspace root.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line, 1-based" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
    }),
  },
  {
    name: "list",
    description: "List a directory inside the workspace or this repository's shared Git directory.",
    parameters: Type.Object({ path: Type.String() }),
  },
  {
    name: "grep",
    description: "Search file contents inside the workspace for a fixed string.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String()),
    }),
  },
  {
    name: "git",
    description:
      "Run a read-only git command in the workspace. Allowed subcommands: status, diff, log, show, branch, rev-parse, ls-files.",
    parameters: Type.Object({ args: Type.Array(Type.String(), { minItems: 1 }) }),
  },
];

const GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
]);
/** Options that run programs, write files, read outside the repository, or change which repository is used. */
const GIT_FORBIDDEN = [
  "-c",
  "-C",
  "--config-env",
  "--exec",
  "--git-dir",
  "--work-tree",
  "--output",
  "--ext-diff",
  "--textconv",
  "--no-index",
  "--upload-pack",
  "--open-files-in-pager",
  "-O",
];
const BRANCH_FLAGS = new Set([
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--show-current",
]);
/** Neutralise repository configuration that would execute code, mirroring the host-side Git hardening. */
const GIT_PREFIX = [
  "git",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "--no-pager",
];

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const clip = (text: string) => {
  const bytes = Buffer.from(text);
  return bytes.length > REVIEW_TOOL_OUTPUT_LIMIT
    ? `${bytes.subarray(0, REVIEW_TOOL_OUTPUT_LIMIT).toString("utf8")}\n…[output truncated at ${REVIEW_TOOL_OUTPUT_LIMIT} bytes]`
    : text;
};
const contains = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

const stringArg = (value: unknown, name: string) => {
  if (typeof value !== "string") throw new Error(`${name} 必须是字符串`);
  return value;
};

export function gitCommand(args: readonly string[]) {
  const [subcommand, ...rest] = args;
  if (!subcommand || !GIT_SUBCOMMANDS.has(subcommand))
    throw new Error(`不允许的 git 子命令：${subcommand ?? ""}`);
  for (const arg of rest) {
    if (
      GIT_FORBIDDEN.some(
        (option) =>
          arg === option ||
          arg.startsWith(`${option}=`) ||
          (option.startsWith("--") &&
            arg.startsWith("--") &&
            arg.length > 2 &&
            option.startsWith(arg.split("=")[0]!)) ||
          (option.length === 2 && arg.startsWith(option) && !arg.startsWith("--")),
      )
    )
      throw new Error(`不允许的 git 参数：${arg}`);
    if (subcommand === "branch" && !BRANCH_FLAGS.has(arg))
      throw new Error(`git branch 只能列出分支：${arg}`);
  }
  const safety = ["diff", "log", "show"].includes(subcommand)
    ? ["--no-ext-diff", "--no-textconv"]
    : [];
  return [...GIT_PREFIX, subcommand, ...safety, ...rest].map(quote).join(" ");
}

type ToolOutcome = { readonly text: string; readonly isError: boolean; readonly summary: string };

/** Executes reviewer tool calls in a dedicated read-only sandbox confined to `root`. */
export function createReviewToolRunner(
  open: () => Promise<ExecutionEnv>,
  root: string,
  readableRoots: readonly string[] = [],
) {
  let env: Promise<ExecutionEnv> | undefined;
  const environment = () => (env ??= open());
  const inside = async (path: string | undefined, context: Context) => {
    const sandbox = await environment();
    const target = resolve(root, path ?? ".");
    const canonical = await sandbox.canonicalPath(target, context);
    // Symlinks are judged by where they point, so a link inside the workspace cannot reach outside it.
    const allowed = await Promise.all(
      [root, ...readableRoots].map((path) => sandbox.canonicalPath(path, context)),
    );
    if (!canonical.ok || !allowed.some((path) => path.ok && contains(path.value, canonical.value)))
      throw new Error(`审查器无权访问此路径：${path ?? "."}`);
    return canonical.value;
  };
  const run = async (command: string, context: Context) => {
    const sandbox = await environment();
    let output = "";
    const result = await sandbox.exec(
      command,
      {
        cwd: root,
        timeout: COMMAND_TIMEOUT_SECONDS,
        env: { GIT_PAGER: "cat", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        onOutput: (text) => {
          if (Buffer.byteLength(output) <= REVIEW_TOOL_OUTPUT_LIMIT) output = clip(output + text);
        },
      },
      context,
    );
    if (!result.ok) throw new Error(result.error.message);
    return { output, exitCode: result.value.exitCode };
  };
  const execute = async (call: ToolCall, context: Context): Promise<ToolOutcome> => {
    const args = call.arguments;
    switch (call.name) {
      case "read": {
        const path = await inside(stringArg(args.path, "path"), context);
        const text = await (await environment()).readTextFile(path, context);
        if (!text.ok) throw new Error(text.error.message);
        const offset = typeof args.offset === "number" ? args.offset : 1;
        const limit = typeof args.limit === "number" ? args.limit : 400;
        const lines = text.value.split("\n").slice(offset - 1, offset - 1 + limit);
        return {
          text: clip(lines.join("\n")),
          isError: false,
          summary: `read ${stringArg(args.path, "path")}`,
        };
      }
      case "list": {
        const path = await inside(stringArg(args.path, "path"), context);
        const entries = await (await environment()).listDir(path, context);
        if (!entries.ok) throw new Error(entries.error.message);
        const text = entries.value
          .map((entry) => `${entry.kind === "directory" ? "d" : "-"} ${entry.name}`)
          .join("\n");
        return {
          text: clip(text),
          isError: false,
          summary: `list ${stringArg(args.path, "path")}`,
        };
      }
      case "grep": {
        const path = await inside(typeof args.path === "string" ? args.path : undefined, context);
        const workspace = await (await environment()).canonicalPath(root, context);
        if (!workspace.ok || !contains(workspace.value, path))
          throw new Error("grep 只能搜索工作区");
        const { output } = await run(
          `grep -rnIF --exclude-dir=.git -m 50 -e ${quote(stringArg(args.pattern, "pattern"))} -- ${quote(path)} | head -n 50`,
          context,
        );
        return {
          text: clip(output || "(no matches)"),
          isError: false,
          summary: `grep ${stringArg(args.pattern, "pattern")}`,
        };
      }
      case "git": {
        const gitArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        const { output, exitCode } = await run(gitCommand(gitArgs), context);
        return {
          text: clip(output || `(exit ${exitCode}, no output)`),
          isError: exitCode !== 0,
          summary: `git ${gitArgs.join(" ")}`,
        };
      }
      default:
        throw new Error(`未知的审查工具：${call.name}`);
    }
  };
  return {
    execute: async (call: ToolCall, context: Context): Promise<ToolOutcome> => {
      try {
        return await execute(call, context);
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
          summary: `${call.name} (rejected)`,
        };
      }
    },
    cleanup: async (context: Context) => {
      if (env) await (await env.catch(() => undefined))?.cleanup(context);
    },
  };
}
